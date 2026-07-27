package com.android.vitalix

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.ActivityIntensityRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.CyclingPedalingCadenceRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.IntermenstrualBleedingRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.MenstruationPeriodRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OvulationTestRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SexualActivityRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.StepsCadenceRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.WheelchairPushesRecord
import com.android.vitalix.health.Aggregation
import com.android.vitalix.health.HealthConnectRecordReader
import com.android.vitalix.health.MetaMappers
import com.android.vitalix.health.RecordReader
import com.android.vitalix.models.DailyHealthData
import com.android.vitalix.models.ExerciseData
import com.android.vitalix.models.ExerciseLap
import com.android.vitalix.models.ExerciseSegment
import com.android.vitalix.models.RoutePoint
import com.android.vitalix.models.ExportConfig
import com.android.vitalix.models.HealthSample
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass

/**
 * Reads Health Connect data for the configured window, buckets it per day, fills
 * the per-day summary maps (activity / body / vitals / sleep / cycle / nutrition),
 * builds exercise sessions, and emits raw [HealthSample]s for every enabled metric.
 *
 * Aggregation math lives in the pure [Aggregation] object; the HC client is hidden
 * behind [RecordReader] so this class is testable with fake record lists.
 */
class HealthConnectManager(
    private val context: Context,
    private val reader: RecordReader =
        HealthConnectRecordReader(HealthConnectClient.getOrCreate(context))
) {
    private val zone: ZoneId = ZoneId.systemDefault()

    /**
     * The Health Connect app that wrote a record — its package name. For records
     * that hold nested samples (heart rate, power, speed) the origin lives on the
     * parent record, so every sample inside inherits it. Blank collapses to null so
     * the field is simply omitted downstream rather than sent empty.
     */
    private val Record.origin: String? get() = metadata.dataOrigin.packageName.ifBlank { null }
    /** Health Connect record UID — stable per record; blank collapses to null. */
    private val Record.uid: String? get() = metadata.id.ifBlank { null }
    /**
     * Metrics whose read failed during the most recent [readHealthDataByDay].
     * Empty means every enabled metric was read (or was legitimately declined).
     */
    var lastFailedMetrics: Set<String> = emptySet()
        private set

    /**
     * Short stretches dropped because Health Connect holds a record the SDK can't
     * construct. Not a failure — the rest of the window still came through.
     */
    var lastSkippedWindows: Int = 0
        private set

    private var saferExportMode: Boolean = false
    private var chunkDays: Long = CHUNK_DAYS
    private var saferDelayMs: Long = SAFER_DELAY_MS

    /**
     * Safer mode splits each read into [chunkDays] windows and pauses [delayMs]
     * between them to stay under Health Connect's rate limits. The backfill
     * overrides both: it already reads one bounded slice at a time, so re-chunking
     * inside the slice would multiply the pauses by the metric count and turn a
     * few seconds of work into minutes.
     */
    fun setSaferExportMode(
        enabled: Boolean,
        chunkDays: Long = CHUNK_DAYS,
        delayMs: Long = SAFER_DELAY_MS,
    ) {
        saferExportMode = enabled
        this.chunkDays = chunkDays
        saferDelayMs = delayMs
    }

    val permissions: Set<String> = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(FloorsClimbedRecord::class),
        HealthPermission.getReadPermission(ElevationGainedRecord::class),
        HealthPermission.getReadPermission(PowerRecord::class),
        HealthPermission.getReadPermission(SpeedRecord::class),
        HealthPermission.getReadPermission(WheelchairPushesRecord::class),
        HealthPermission.getReadPermission(Vo2MaxRecord::class),
        HealthPermission.getReadPermission(WeightRecord::class),
        HealthPermission.getReadPermission(BodyFatRecord::class),
        HealthPermission.getReadPermission(BoneMassRecord::class),
        HealthPermission.getReadPermission(HeightRecord::class),
        HealthPermission.getReadPermission(LeanBodyMassRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HealthPermission.getReadPermission(OxygenSaturationRecord::class),
        HealthPermission.getReadPermission(RespiratoryRateRecord::class),
        HealthPermission.getReadPermission(BloodGlucoseRecord::class),
        HealthPermission.getReadPermission(BloodPressureRecord::class),
        HealthPermission.getReadPermission(BodyTemperatureRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(HydrationRecord::class),
        HealthPermission.getReadPermission(NutritionRecord::class),
        HealthPermission.getReadPermission(MenstruationFlowRecord::class),
        HealthPermission.getReadPermission(CervicalMucusRecord::class),
        HealthPermission.getReadPermission(OvulationTestRecord::class),
        HealthPermission.getReadPermission(SexualActivityRecord::class),
        HealthPermission.getReadPermission(BasalMetabolicRateRecord::class),
        HealthPermission.getReadPermission(BodyWaterMassRecord::class),
        HealthPermission.getReadPermission(BasalBodyTemperatureRecord::class),
        HealthPermission.getReadPermission(IntermenstrualBleedingRecord::class),
        HealthPermission.getReadPermission(MenstruationPeriodRecord::class),
        HealthPermission.getReadPermission(ActivityIntensityRecord::class),
        HealthPermission.getReadPermission(MindfulnessSessionRecord::class),
        HealthPermission.getReadPermission(CyclingPedalingCadenceRecord::class),
        HealthPermission.getReadPermission(StepsCadenceRecord::class),
        HealthPermission.getReadPermission(SkinTemperatureRecord::class),
        // Exercise GPS route: a separate permission from ExerciseSessionRecord;
        // without it exerciseRouteResult comes back as ConsentRequired/NoData.
        HealthPermission.PERMISSION_READ_EXERCISE_ROUTES,
        // Without this, Health Connect truncates every read to the last 30 days,
        // which would make the full-history backfill return almost nothing.
        // Spelled out because connect-client 1.1.0-alpha07 has no constant for it.
        PERMISSION_READ_HEALTH_DATA_HISTORY,
    )

    /** Tracks the most-recent value seen in a day (for "latest wins" scalars). */
    private class Latest<V> {
        var time: Instant? = null
        var value: V? = null
        fun offer(t: Instant, v: V) {
            if (time == null || t.isAfter(time)) { time = t; value = v }
        }
    }

    private inner class DayBuilder(val date: LocalDate) {
        // Activity (interval sums)
        var steps = 0L
        var distanceMeters = 0.0
        var activeKcal = 0.0
        var totalKcal = 0.0
        var floors = 0.0
        var elevationMeters = 0.0
        var wheelchairPushes = 0L
        val powers = mutableListOf<Double>()
        val speeds = mutableListOf<Double>()
        val vo2 = Latest<Double>()
        var hasSteps = false
        var hasDistance = false
        var hasActive = false
        var hasTotal = false
        var hasFloors = false
        var hasElevation = false
        var hasWheelchair = false

        // Body (latest wins)
        val weight = Latest<Double>()
        val bodyFat = Latest<Double>()
        val boneMass = Latest<Double>()
        val height = Latest<Double>()
        val leanBodyMass = Latest<Double>()

        // Vitals
        val heartRates = mutableListOf<Double>()
        val hrv = mutableListOf<Double>()
        val spo2 = mutableListOf<Double>()
        val glucose = mutableListOf<Double>()
        val respRate = mutableListOf<Double>()
        val bpSystolic = mutableListOf<Double>()
        val bpDiastolic = mutableListOf<Double>()
        val restingHeartRate = Latest<Double>()
        val bodyTemperature = Latest<Double>()

        // Sleep
        var sleepMinutes = 0L
        val stageMinutes = linkedMapOf<String, Long>()
        var hasSleep = false

        // Nutrition
        var hydrationMl = 0.0
        var nutritionKcal = 0.0
        var hasHydration = false
        var hasNutrition = false

        // Cycle (latest wins)
        val menstruation = Latest<String>()
        val cervicalMucus = Latest<String>()
        val ovulationTest = Latest<String>()
        val sexualActivity = Latest<String>()

        val exercises = mutableListOf<ExerciseData>()
        val samples = mutableListOf<HealthSample>()

        fun build(): DailyHealthData {
            val activity = linkedMapOf<String, Any?>()
            if (hasSteps) activity["steps"] = steps
            if (hasDistance) activity["distance"] = distanceMeters
            if (hasActive) activity["activeCalories"] = activeKcal
            if (hasTotal) activity["totalCalories"] = totalKcal
            if (hasFloors) activity["floorsClimbed"] = floors
            if (hasElevation) activity["elevationGained"] = elevationMeters
            if (hasWheelchair) activity["wheelchairPushes"] = wheelchairPushes
            vo2.value?.let { activity["vo2Max"] = it }

            val body = linkedMapOf<String, Any?>()
            weight.value?.let { body["weight"] = it }
            bodyFat.value?.let { body["bodyFat"] = it }
            boneMass.value?.let { body["boneMass"] = it }
            height.value?.let { body["height"] = it }
            leanBodyMass.value?.let { body["leanBodyMass"] = it }

            val vitals = linkedMapOf<String, Any?>()
            if (heartRates.isNotEmpty()) vitals["heartRate"] = Aggregation.minMaxAvg(heartRates)
            if (hrv.isNotEmpty()) vitals["hrv"] = Aggregation.minMaxAvg(hrv)
            if (spo2.isNotEmpty()) vitals["spo2"] = Aggregation.minMaxAvg(spo2)
            if (glucose.isNotEmpty()) vitals["bloodGlucose"] = Aggregation.minMaxAvg(glucose)
            if (respRate.isNotEmpty()) vitals["respiratoryRate"] = Aggregation.minMaxAvg(respRate)
            if (bpSystolic.isNotEmpty() || bpDiastolic.isNotEmpty()) {
                val bp = linkedMapOf<String, Any?>()
                if (bpSystolic.isNotEmpty()) bp["systolic"] = Aggregation.minMaxAvg(bpSystolic)
                if (bpDiastolic.isNotEmpty()) bp["diastolic"] = Aggregation.minMaxAvg(bpDiastolic)
                vitals["bloodPressure"] = bp
            }
            restingHeartRate.value?.let { vitals["restingHeartRate"] = it }
            bodyTemperature.value?.let { vitals["bodyTemperature"] = it }

            val sleep = linkedMapOf<String, Any?>()
            if (hasSleep) {
                sleep["durationMinutes"] = sleepMinutes
                if (stageMinutes.isNotEmpty()) sleep["stages"] = stageMinutes
            }

            val nutrition = linkedMapOf<String, Any?>()
            if (hasHydration) nutrition["hydrationMl"] = hydrationMl
            if (hasNutrition) nutrition["energyKcal"] = nutritionKcal

            val cycle = linkedMapOf<String, Any?>()
            menstruation.value?.let { cycle["menstruation"] = it }
            cervicalMucus.value?.let { cycle["cervicalMucus"] = it }
            ovulationTest.value?.let { cycle["ovulationTest"] = it }
            sexualActivity.value?.let { cycle["sexualActivity"] = it }

            return DailyHealthData(
                date = date.toString(),
                activityData = activity,
                bodyMeasurementData = body,
                vitalsData = vitals,
                sleepData = sleep,
                cycleTrackingData = cycle,
                nutritionData = nutrition,
                exercises = exercises,
                samples = samples
            )
        }
    }

    suspend fun readHealthDataByDay(cfg: ExportConfig): List<DailyHealthData> {
        val end = Instant.now()
        return readHealthDataByDay(cfg, end.minus(cfg.daysBack.toLong(), ChronoUnit.DAYS), end)
    }

    /**
     * Reads an explicit window instead of the trailing [ExportConfig.daysBack].
     * Used by the full-history backfill, which walks backwards a slice at a time
     * so no single payload has to hold years of samples.
     */
    suspend fun readHealthDataByDay(
        cfg: ExportConfig,
        start: Instant,
        end: Instant,
    ): List<DailyHealthData> {

        val failed = linkedSetOf<String>()
        val builders = HashMap<LocalDate, DayBuilder>()
        fun builder(d: LocalDate) = builders.getOrPut(d) { DayBuilder(d) }
        fun day(t: Instant) = Aggregation.bucketByDay(t, zone)

        // Read a record type across the window (chunked in safer-export mode) and
        // process each list. A metric that can't be read is recorded in
        // [lastFailedMetrics] rather than silently dropped: an empty read and a
        // throttled read look identical downstream, and treating a throttle as
        // "no data" quietly loses whole metrics from the export.
        suspend fun <T : Record> perMetric(
            enabled: Boolean,
            type: KClass<T>,
            handle: (List<T>) -> Unit
        ) {
            if (!enabled) return
            try {
                for ((s, e) in windows(start, end)) {
                    handle(reader.read(type, s, e))
                    if (saferExportMode) delay(saferDelayMs)
                }
            } catch (ex: RecordReader.PermanentlyUnavailable) {
                // User declined this record type. Expected, not a failure.
                Log.i(TAG, "Skipping ${type.simpleName}: ${ex.message}")
            } catch (ex: Exception) {
                Log.e(TAG, "Read failed for ${type.simpleName}: ${ex.message}", ex)
                failed += type.simpleName ?: "record"
            }
        }

        // ---- Activity ----
        perMetric(cfg.includeSteps, StepsRecord::class) { recs ->
            recs.forEach { r ->
                val b = builder(day(r.startTime)); b.hasSteps = true
                b.steps += r.count
                b.samples += HealthSample("steps", r.startTime.toString(), r.endTime.toString(), value = r.count.toDouble(), source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeDistance, DistanceRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.distance.inMeters
                val b = builder(day(r.startTime)); b.hasDistance = true
                b.distanceMeters += v
                b.samples += HealthSample("distance", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeActiveCalories, ActiveCaloriesBurnedRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.energy.inKilocalories
                val b = builder(day(r.startTime)); b.hasActive = true
                b.activeKcal += v
                b.samples += HealthSample("activeCalories", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeTotalCalories, TotalCaloriesBurnedRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.energy.inKilocalories
                val b = builder(day(r.startTime)); b.hasTotal = true
                b.totalKcal += v
                b.samples += HealthSample("totalCalories", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeFloorsClimbed, FloorsClimbedRecord::class) { recs ->
            recs.forEach { r ->
                val b = builder(day(r.startTime)); b.hasFloors = true
                b.floors += r.floors
                b.samples += HealthSample("floorsClimbed", r.startTime.toString(), r.endTime.toString(), value = r.floors, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeElevationGained, ElevationGainedRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.elevation.inMeters
                val b = builder(day(r.startTime)); b.hasElevation = true
                b.elevationMeters += v
                b.samples += HealthSample("elevationGained", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeWheelchairPushes, WheelchairPushesRecord::class) { recs ->
            recs.forEach { r ->
                val b = builder(day(r.startTime)); b.hasWheelchair = true
                b.wheelchairPushes += r.count
                b.samples += HealthSample("wheelchairPushes", r.startTime.toString(), r.endTime.toString(), value = r.count.toDouble(), source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includePower, PowerRecord::class) { recs ->
            recs.forEach { r ->
                r.samples.forEach { s ->
                    val v = s.power.inWatts
                    val b = builder(day(s.time))
                    b.powers += v
                    b.samples += HealthSample("power", s.time.toString(), value = v, source = r.origin, hcId = r.uid)
                }
            }
        }
        perMetric(cfg.includeSpeed, SpeedRecord::class) { recs ->
            recs.forEach { r ->
                r.samples.forEach { s ->
                    val v = s.speed.inMetersPerSecond
                    val b = builder(day(s.time))
                    b.speeds += v
                    b.samples += HealthSample("speed", s.time.toString(), value = v, source = r.origin, hcId = r.uid)
                }
            }
        }
        perMetric(cfg.includeActivityIntensity, ActivityIntensityRecord::class) { recs ->
            recs.forEach { r ->
                val label = MetaMappers.activityIntensityMeta(r.activityIntensityType)?.get("intensityType")
                builder(day(r.startTime)).samples += HealthSample("activityIntensity", r.startTime.toString(), r.endTime.toString(), text = label, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.activityIntensityMeta(r.activityIntensityType))
            }
        }
        perMetric(cfg.includeVO2Max, Vo2MaxRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.vo2MillilitersPerMinuteKilogram
                val b = builder(day(r.time))
                b.vo2.offer(r.time, v)
                b.samples += HealthSample("vo2Max", r.time.toString(), value = v, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.vo2MaxMeta(r.measurementMethod))
            }
        }

        // ---- Body measurements ----
        perMetric(cfg.includeWeight, WeightRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.weight.inKilograms
                val b = builder(day(r.time)); b.weight.offer(r.time, v)
                b.samples += HealthSample("weight", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBodyFat, BodyFatRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.percentage.value
                val b = builder(day(r.time)); b.bodyFat.offer(r.time, v)
                b.samples += HealthSample("bodyFat", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBoneMass, BoneMassRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.mass.inKilograms
                val b = builder(day(r.time)); b.boneMass.offer(r.time, v)
                b.samples += HealthSample("boneMass", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeHeight, HeightRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.height.inMeters
                val b = builder(day(r.time)); b.height.offer(r.time, v)
                b.samples += HealthSample("height", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeLeanBodyMass, LeanBodyMassRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.mass.inKilograms
                val b = builder(day(r.time)); b.leanBodyMass.offer(r.time, v)
                b.samples += HealthSample("leanBodyMass", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }

        perMetric(cfg.includeBasalMetabolicRate, BasalMetabolicRateRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.basalMetabolicRate.inKilocaloriesPerDay
                builder(day(r.time)).samples += HealthSample("basalMetabolicRate", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBodyWaterMass, BodyWaterMassRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.time)).samples += HealthSample("bodyWaterMass", r.time.toString(), value = r.mass.inKilograms, source = r.origin, hcId = r.uid)
            }
        }

        // ---- Vitals ----
        perMetric(cfg.includeHeartRate, HeartRateRecord::class) { recs ->
            recs.forEach { r ->
                r.samples.forEach { s ->
                    val v = s.beatsPerMinute.toDouble()
                    val b = builder(day(s.time))
                    b.heartRates += v
                    b.samples += HealthSample("heartRate", s.time.toString(), value = v, source = r.origin, hcId = r.uid)
                }
            }
        }
        perMetric(cfg.includeHeartRateVariability, HeartRateVariabilityRmssdRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.heartRateVariabilityMillis
                val b = builder(day(r.time)); b.hrv += v
                b.samples += HealthSample("hrv", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeOxygenSaturation, OxygenSaturationRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.percentage.value
                val b = builder(day(r.time)); b.spo2 += v
                b.samples += HealthSample("spo2", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeRespiratoryRate, RespiratoryRateRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.rate
                val b = builder(day(r.time)); b.respRate += v
                b.samples += HealthSample("respiratoryRate", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBloodGlucose, BloodGlucoseRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.level.inMilligramsPerDeciliter
                val b = builder(day(r.time)); b.glucose += v
                b.samples += HealthSample("bloodGlucose", r.time.toString(), value = v, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.bloodGlucoseMeta(r.mealType, r.relationToMeal, r.specimenSource))
            }
        }
        perMetric(cfg.includeBloodPressure, BloodPressureRecord::class) { recs ->
            recs.forEach { r ->
                val sys = r.systolic.inMillimetersOfMercury
                val dia = r.diastolic.inMillimetersOfMercury
                val b = builder(day(r.time))
                b.bpSystolic += sys; b.bpDiastolic += dia
                b.samples += HealthSample("bloodPressure", r.time.toString(), value = sys, value2 = dia, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.bloodPressureMeta(r.bodyPosition, r.measurementLocation))
            }
        }
        perMetric(cfg.includeRestingHeartRate, RestingHeartRateRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.beatsPerMinute.toDouble()
                val b = builder(day(r.time)); b.restingHeartRate.offer(r.time, v)
                b.samples += HealthSample("restingHeartRate", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBodyTemperature, BodyTemperatureRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.temperature.inCelsius
                val b = builder(day(r.time)); b.bodyTemperature.offer(r.time, v)
                b.samples += HealthSample("bodyTemperature", r.time.toString(), value = v, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.bodyTemperatureMeta(r.measurementLocation))
            }
        }

        // ---- Sleep ----
        perMetric(cfg.includeSleepSession, SleepSessionRecord::class) { recs ->
            recs.forEach { r ->
                val b = builder(day(r.startTime)); b.hasSleep = true
                b.sleepMinutes += ChronoUnit.MINUTES.between(r.startTime, r.endTime)
                r.stages.forEach { st ->
                    val name = SleepSessionRecord.STAGE_TYPE_INT_TO_STRING_MAP[st.stage] ?: "unknown"
                    val mins = ChronoUnit.MINUTES.between(st.startTime, st.endTime)
                    val sb = builder(day(st.startTime))
                    sb.hasSleep = true
                    sb.stageMinutes[name] = (sb.stageMinutes[name] ?: 0L) + mins
                    sb.samples += HealthSample("sleepStage", st.startTime.toString(), st.endTime.toString(), text = name, source = r.origin, hcId = r.uid)
                }
            }
        }

        // ---- Exercise ----
        perMetric(cfg.includeExercise, ExerciseSessionRecord::class) { recs ->
            recs.forEach { r ->
                val name = r.title
                    ?: ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP[r.exerciseType]
                    ?: "unknown"
                val durationMin = ChronoUnit.MINUTES.between(r.startTime, r.endTime)
                val laps = r.laps.map { l ->
                    ExerciseLap(l.startTime.toString(), l.endTime.toString(), l.length?.inMeters)
                }
                val segments = r.segments.map { s ->
                    ExerciseSegment(
                        s.startTime.toString(),
                        s.endTime.toString(),
                        segmentTypeNames[s.segmentType] ?: "unknown",
                    )
                }
                val route = if (cfg.includeExerciseRoute) {
                    (r.exerciseRouteResult as? ExerciseRouteResult.Data)?.exerciseRoute?.route?.map { p ->
                        RoutePoint(
                            p.time.toString(), p.latitude, p.longitude,
                            p.altitude?.inMeters, p.horizontalAccuracy?.inMeters, p.verticalAccuracy?.inMeters,
                        )
                    } ?: emptyList()
                } else {
                    emptyList()
                }
                val b = builder(day(r.startTime))
                b.exercises += ExerciseData(
                    date = day(r.startTime).toString(),
                    startDateTime = r.startTime.toString(),
                    exerciseName = name,
                    durationMinutes = durationMin,
                    source = r.origin,
                    hcId = r.uid,
                    laps = laps,
                    segments = segments,
                    route = route,
                )
            }
        }

        // ---- Nutrition ----
        perMetric(cfg.includeHydration, HydrationRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.volume.inMilliliters
                val b = builder(day(r.startTime)); b.hasHydration = true
                b.hydrationMl += v
                b.samples += HealthSample("hydration", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeNutrition, NutritionRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.energy?.inKilocalories ?: 0.0
                val b = builder(day(r.startTime)); b.hasNutrition = true
                b.nutritionKcal += v
                b.samples += HealthSample("nutrition", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeNutritionDetail, NutritionRecord::class) { recs ->
            recs.forEach { r ->
                val mealMeta = MetaMappers.mealTypeMeta(r.mealType)
                val b = builder(day(r.startTime))
                nutrientExtractors.forEach { (name, extract) ->
                    extract(r)?.let { v ->
                        b.samples += HealthSample("nutrition.$name", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid, meta = mealMeta)
                    }
                }
            }
        }

        // ---- Cycle tracking ----
        perMetric(cfg.includeMenstruation, MenstruationFlowRecord::class) { recs ->
            recs.forEach { r ->
                val text = MenstruationFlowRecord.FLOW_TYPE_INT_TO_STRING_MAP[r.flow] ?: "unknown"
                val b = builder(day(r.time)); b.menstruation.offer(r.time, text)
                b.samples += HealthSample("menstruation", r.time.toString(), text = text, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeCervicalMucus, CervicalMucusRecord::class) { recs ->
            recs.forEach { r ->
                val text = CervicalMucusRecord.APPEARANCE_INT_TO_STRING_MAP[r.appearance] ?: "unknown"
                val b = builder(day(r.time)); b.cervicalMucus.offer(r.time, text)
                b.samples += HealthSample("cervicalMucus", r.time.toString(), text = text, source = r.origin, hcId = r.uid, meta = MetaMappers.cervicalMucusMeta(r.sensation))
            }
        }
        perMetric(cfg.includeOvulationTest, OvulationTestRecord::class) { recs ->
            recs.forEach { r ->
                val text = OvulationTestRecord.RESULT_INT_TO_STRING_MAP[r.result] ?: "unknown"
                val b = builder(day(r.time)); b.ovulationTest.offer(r.time, text)
                b.samples += HealthSample("ovulationTest", r.time.toString(), text = text, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeSexualActivity, SexualActivityRecord::class) { recs ->
            recs.forEach { r ->
                val text = SexualActivityRecord.PROTECTION_USED_INT_TO_STRING_MAP[r.protectionUsed] ?: "unknown"
                val b = builder(day(r.time)); b.sexualActivity.offer(r.time, text)
                b.samples += HealthSample("sexualActivity", r.time.toString(), text = text, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBasalBodyTemperature, BasalBodyTemperatureRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.time)).samples += HealthSample("basalBodyTemperature", r.time.toString(), value = r.temperature.inCelsius, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.basalBodyTemperatureMeta(r.measurementLocation))
            }
        }
        perMetric(cfg.includeIntermenstrualBleeding, IntermenstrualBleedingRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.time)).samples += HealthSample("intermenstrualBleeding", r.time.toString(), value = 1.0, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeMenstruationPeriod, MenstruationPeriodRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.startTime)).samples += HealthSample("menstruationPeriod", r.startTime.toString(), r.endTime.toString(), value = 1.0, source = r.origin, hcId = r.uid)
            }
        }

        // ---- Mindfulness ----
        perMetric(cfg.includeMindfulness, MindfulnessSessionRecord::class) { recs ->
            recs.forEach { r ->
                val mins = ChronoUnit.MINUTES.between(r.startTime, r.endTime)
                val label = r.title ?: MetaMappers.mindfulnessMeta(r.mindfulnessSessionType)?.get("sessionType")
                builder(day(r.startTime)).samples += HealthSample("mindfulness", r.startTime.toString(), r.endTime.toString(), value = mins.toDouble(), text = label, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.mindfulnessMeta(r.mindfulnessSessionType))
            }
        }

        // ---- Series (cadence + skin temperature) ----
        perMetric(cfg.includeCyclingCadence, CyclingPedalingCadenceRecord::class) { recs ->
            recs.forEach { r -> r.samples.forEach { s ->
                builder(day(s.time)).samples += HealthSample("cyclingCadence", s.time.toString(), value = s.revolutionsPerMinute, source = r.origin, hcId = r.uid)
            } }
        }
        perMetric(cfg.includeStepsCadence, StepsCadenceRecord::class) { recs ->
            recs.forEach { r -> r.samples.forEach { s ->
                builder(day(s.time)).samples += HealthSample("stepsCadence", s.time.toString(), value = s.rate, source = r.origin, hcId = r.uid)
            } }
        }
        perMetric(cfg.includeSkinTemperature, SkinTemperatureRecord::class) { recs ->
            recs.forEach { r ->
                val m = MetaMappers.skinTemperatureMeta(r.measurementLocation, r.baseline?.inCelsius)
                r.deltas.forEach { d ->
                    builder(day(d.time)).samples += HealthSample("skinTemperature", d.time.toString(), value = d.delta.inCelsius, source = r.origin, hcId = r.uid, meta = m)
                }
            }
        }

        lastFailedMetrics = failed
        lastSkippedWindows = (reader as? HealthConnectRecordReader)?.skippedWindows ?: 0
        return builders.values.sortedBy { it.date }.map { it.build() }
    }

    /**
     * `ExerciseSegment.EXERCISE_SEGMENT_TYPE_*` int → lowercase name (e.g.
     * `EXERCISE_SEGMENT_TYPE_RUNNING` → `"running"`). connect-client 1.2.0-alpha
     * exposes the constants but no public int→string map, so derive it once by
     * reflection over the record class's static fields.
     */
    private val segmentTypeNames: Map<Int, String> by lazy {
        androidx.health.connect.client.records.ExerciseSegment::class.java.fields
            .filter { it.name.startsWith("EXERCISE_SEGMENT_TYPE_") && it.type == Int::class.javaPrimitiveType }
            .associate { it.getInt(null) to it.name.removePrefix("EXERCISE_SEGMENT_TYPE_").lowercase() }
    }

    /**
     * Maps a `nutrition.<field>` metric suffix to its nullable field accessor
     * on [NutritionRecord], each already in its canonical unit (grams for
     * masses, kilocalories for energies). Energy itself is excluded here: it
     * is already covered by the `includeNutrition` day-rollup sample.
     */
    private val nutrientExtractors: List<Pair<String, (NutritionRecord) -> Double?>> = listOf(
        "biotin" to { r -> r.biotin?.inGrams }, "caffeine" to { r -> r.caffeine?.inGrams },
        "calcium" to { r -> r.calcium?.inGrams }, "energyFromFat" to { r -> r.energyFromFat?.inKilocalories },
        "chloride" to { r -> r.chloride?.inGrams }, "cholesterol" to { r -> r.cholesterol?.inGrams },
        "chromium" to { r -> r.chromium?.inGrams }, "copper" to { r -> r.copper?.inGrams },
        "dietaryFiber" to { r -> r.dietaryFiber?.inGrams }, "folate" to { r -> r.folate?.inGrams },
        "folicAcid" to { r -> r.folicAcid?.inGrams }, "iodine" to { r -> r.iodine?.inGrams },
        "iron" to { r -> r.iron?.inGrams }, "magnesium" to { r -> r.magnesium?.inGrams },
        "manganese" to { r -> r.manganese?.inGrams }, "molybdenum" to { r -> r.molybdenum?.inGrams },
        "monounsaturatedFat" to { r -> r.monounsaturatedFat?.inGrams }, "niacin" to { r -> r.niacin?.inGrams },
        "pantothenicAcid" to { r -> r.pantothenicAcid?.inGrams }, "phosphorus" to { r -> r.phosphorus?.inGrams },
        "polyunsaturatedFat" to { r -> r.polyunsaturatedFat?.inGrams }, "potassium" to { r -> r.potassium?.inGrams },
        "protein" to { r -> r.protein?.inGrams }, "riboflavin" to { r -> r.riboflavin?.inGrams },
        "saturatedFat" to { r -> r.saturatedFat?.inGrams }, "selenium" to { r -> r.selenium?.inGrams },
        "sodium" to { r -> r.sodium?.inGrams }, "sugar" to { r -> r.sugar?.inGrams },
        "thiamin" to { r -> r.thiamin?.inGrams }, "totalCarbohydrate" to { r -> r.totalCarbohydrate?.inGrams },
        "totalFat" to { r -> r.totalFat?.inGrams }, "transFat" to { r -> r.transFat?.inGrams },
        "unsaturatedFat" to { r -> r.unsaturatedFat?.inGrams }, "vitaminA" to { r -> r.vitaminA?.inGrams },
        "vitaminB12" to { r -> r.vitaminB12?.inGrams }, "vitaminB6" to { r -> r.vitaminB6?.inGrams },
        "vitaminC" to { r -> r.vitaminC?.inGrams }, "vitaminD" to { r -> r.vitaminD?.inGrams },
        "vitaminE" to { r -> r.vitaminE?.inGrams }, "vitaminK" to { r -> r.vitaminK?.inGrams },
        "zinc" to { r -> r.zinc?.inGrams },
    )

    /**
     * Split [start, end] into read windows. In safer-export mode reads are chunked
     * into <=7-day windows (with a short delay between them, applied by the caller)
     * to avoid Health Connect rate limits; otherwise a single window is used.
     */
    private fun windows(start: Instant, end: Instant): List<Pair<Instant, Instant>> {
        if (!saferExportMode) return listOf(start to end)
        val out = mutableListOf<Pair<Instant, Instant>>()
        var cursor = start
        while (cursor.isBefore(end)) {
            val next = minOf(cursor.plus(chunkDays, ChronoUnit.DAYS), end)
            out += cursor to next
            cursor = next
        }
        if (out.isEmpty()) out += start to end
        return out
    }

    companion object {
        const val PERMISSION_READ_HEALTH_DATA_HISTORY =
            "android.permission.health.READ_HEALTH_DATA_HISTORY"

        private const val TAG = "HealthConnectManager"
        private const val SAFER_DELAY_MS = 2000L
        private const val CHUNK_DAYS = 7L
    }
}

package com.android.vitalix

import androidx.health.connect.client.records.ActivityIntensityRecord
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
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
import androidx.health.connect.client.units.BloodGlucose
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Pressure
import androidx.health.connect.client.units.Temperature
import androidx.health.connect.client.units.TemperatureDelta
import androidx.health.connect.client.units.Velocity
import androidx.health.connect.client.units.Volume
import com.android.vitalix.health.FakeRecordReader
import com.android.vitalix.health.fakeMetadata
import com.android.vitalix.models.*
import kotlinx.coroutines.test.runTest
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ServerForwarderTest {
    private fun sampleDay() = DailyHealthData(
        date = "2026-07-20",
        activityData = mapOf("steps" to 8123),
        vitalsData = mapOf("heartRate" to MinMaxAvg(52.0, 146.0, 68.0)),
        exercises = listOf(ExerciseData("2026-07-20", "2026-07-20T06:12:00Z", "Running", 32)),
        samples = listOf(HealthSample("heartRate", "2026-07-20T10:04:12Z", value = 68.0))
    )

    @Test fun buildsSchemaWithEnabledMetricsAndSamples() {
        val json = JSONObject(ServerForwarder.buildPayload(listOf(sampleDay()), PayloadMeta("1.0.0", "Pixel 8", 7)))
        assertEquals("vitalix", json.getString("source"))
        val day = json.getJSONArray("days").getJSONObject(0)
        assertEquals(8123, day.getJSONObject("activity").getInt("steps"))
        val hr = day.getJSONObject("vitals").getJSONObject("heartRate")
        assertEquals(68, hr.getInt("avg"))
        val sample = day.getJSONArray("samples").getJSONObject(0)
        assertEquals("heartRate", sample.getString("metric"))
        assertEquals(1, day.getJSONArray("exercises").length())
    }

    @Test fun carriesTimeZoneAndFailedMetricsOnlyWhenPresent() {
        val clean = JSONObject(ServerForwarder.buildPayload(listOf(sampleDay()),
            PayloadMeta("1.0.0", "d", 1, timeZone = "Asia/Jakarta")))
        org.junit.Assert.assertEquals("Asia/Jakarta", clean.getString("timeZone"))
        org.junit.Assert.assertFalse(clean.has("failedMetrics"))
        val partial = JSONObject(ServerForwarder.buildPayload(listOf(sampleDay()),
            PayloadMeta("1.0.0", "d", 1, failedMetrics = setOf("SleepSessionRecord"))))
        org.junit.Assert.assertEquals("SleepSessionRecord", partial.getJSONArray("failedMetrics").getString(0))
    }

    @Test fun omitsDisabledMetricSections() {
        val day = DailyHealthData(date = "2026-07-20", activityData = mapOf("steps" to 10))
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val d0 = json.getJSONArray("days").getJSONObject(0)
        assertTrue(d0.has("activity"))
        assertFalse(d0.has("body"))   // empty section omitted, not null
    }

    @Test fun nestsBloodPressureUnderVitals() {
        val day = DailyHealthData(
            date = "2026-07-20",
            vitalsData = mapOf(
                "bloodPressure" to linkedMapOf(
                    "systolic" to MinMaxAvg(110.0, 130.0, 118.0),
                    "diastolic" to MinMaxAvg(70.0, 82.0, 76.0)
                )
            )
        )
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val bp = json.getJSONArray("days").getJSONObject(0).getJSONObject("vitals").getJSONObject("bloodPressure")
        assertEquals(118, bp.getJSONObject("systolic").getInt("avg"))
        assertEquals(76, bp.getJSONObject("diastolic").getInt("avg"))
    }

    @Test fun activitySectionNeverContainsPowerOrSpeed() {
        val day = DailyHealthData(date = "2026-07-20", activityData = mapOf("steps" to 10))
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val activity = json.getJSONArray("days").getJSONObject(0).getJSONObject("activity")
        assertFalse(activity.has("power"))
        assertFalse(activity.has("speed"))
    }

    @Test fun serializesHcIdOnSampleAndExercise() {
        val day = DailyHealthData(
            date = "2026-07-20",
            exercises = listOf(ExerciseData("2026-07-20", "2026-07-20T06:12:00Z", "Running", 32, source = "com.x", hcId = "ex-uid-1")),
            samples = listOf(HealthSample("heartRate", "2026-07-20T10:04:12Z", value = 68.0, source = "com.x", hcId = "hr-uid-1"))
        )
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val d0 = json.getJSONArray("days").getJSONObject(0)
        assertEquals("hr-uid-1", d0.getJSONArray("samples").getJSONObject(0).getString("hcId"))
        assertEquals("ex-uid-1", d0.getJSONArray("exercises").getJSONObject(0).getString("hcId"))
    }

    @Test fun serializesMetaObjectOnSampleWhenPresent() {
        val day = DailyHealthData(
            date = "2026-07-20",
            samples = listOf(HealthSample("bloodPressure", "2026-07-20T10:04:12Z",
                value = 120.0, value2 = 80.0, source = "com.x", hcId = "bp-1",
                meta = mapOf("bodyPosition" to "standing", "measurementLocation" to "left_wrist")))
        )
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val sample = json.getJSONArray("days").getJSONObject(0).getJSONArray("samples").getJSONObject(0)
        val meta = sample.getJSONObject("meta")
        assertEquals("standing", meta.getString("bodyPosition"))
        assertEquals("left_wrist", meta.getString("measurementLocation"))
    }

    @Test fun omitsMetaKeyWhenNullOrEmpty() {
        val day = DailyHealthData(
            date = "2026-07-20",
            samples = listOf(
                HealthSample("heartRate", "2026-07-20T10:04:12Z", value = 68.0),                 // null meta
                HealthSample("heartRate", "2026-07-20T10:05:12Z", value = 70.0, meta = emptyMap()) // empty meta
            )
        )
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val samples = json.getJSONArray("days").getJSONObject(0).getJSONArray("samples")
        assertFalse(samples.getJSONObject(0).has("meta"))
        assertFalse(samples.getJSONObject(1).has("meta"))
    }

    @Test
    fun exerciseSerializesLapsSegmentsRoute() {
        val day = DailyHealthData(
            date = "2026-07-24",
            exercises = listOf(
                ExerciseData(
                    date = "2026-07-24", startDateTime = "2026-07-24T06:00:00Z",
                    exerciseName = "Running", durationMinutes = 30,
                    source = "com.x", hcId = "ex-1",
                    laps = listOf(ExerciseLap("2026-07-24T06:00:00Z", "2026-07-24T06:10:00Z", 2000.0)),
                    segments = listOf(ExerciseSegment("2026-07-24T06:00:00Z", "2026-07-24T06:05:00Z", "running")),
                    route = listOf(RoutePoint("2026-07-24T06:00:00Z", 1.29, 103.85, 15.0, 3.0, 5.0)),
                )
            )
        )
        val json = ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "Pixel", 7))
        val ex = JSONObject(json).getJSONArray("days").getJSONObject(0).getJSONArray("exercises").getJSONObject(0)
        assertEquals(2000.0, ex.getJSONArray("laps").getJSONObject(0).getDouble("lengthMeters"), 0.0)
        assertEquals("running", ex.getJSONArray("segments").getJSONObject(0).getString("type"))
        val pt = ex.getJSONArray("route").getJSONObject(0)
        assertEquals(1.29, pt.getDouble("lat"), 0.0)
        assertEquals(103.85, pt.getDouble("lng"), 0.0)
    }

    @Test
    fun exerciseOmitsEmptyDetail() {
        val day = DailyHealthData(
            date = "2026-07-24",
            exercises = listOf(ExerciseData("2026-07-24", "2026-07-24T06:00:00Z", "Walk", 10, hcId = "ex-2"))
        )
        val json = ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "Pixel", 7))
        val ex = JSONObject(json).getJSONArray("days").getJSONObject(0).getJSONArray("exercises").getJSONObject(0)
        assertFalse(ex.has("laps")); assertFalse(ex.has("segments")); assertFalse(ex.has("route"))
    }

    // ---- schemaVersion + shared fixture (docs/fixtures/payload-v2.json) ----

    @Test fun buildPayloadEmitsSchemaVersion2() {
        val json = JSONObject(ServerForwarder.buildPayload(listOf(sampleDay()), PayloadMeta("1.0.0", "d", 1)))
        assertEquals(2, json.getInt("schemaVersion"))
        assertEquals(2, ServerForwarder.PAYLOAD_SCHEMA_VERSION)
    }

    private fun keys(o: JSONObject): Set<String> = o.keys().asSequence().toSet()

    /** nutrition.<nutrient> is open-ended (35 names); one representative stands for all. */
    private fun normMetric(m: String) = if (m.startsWith("nutrition.")) "nutrition.*" else m

    @Test fun fixtureMetricKeysMatchWhatAnAllEnabledExportEmits() = runTest {
        val fixture = JSONObject(File("../../docs/fixtures/payload-v2.json").readText())
        assertEquals(ServerForwarder.PAYLOAD_SCHEMA_VERSION, fixture.getInt("schemaVersion"))

        // One canned record per Health Connect type, fed through the real manager.
        val t = Instant.parse("2026-07-24T06:00:00Z")
        val t2 = t.plusSeconds(3600)
        val z = ZoneOffset.UTC
        fun m(id: String) = fakeMetadata(id, "com.x")
        val recs: List<Record> = listOf(
            StepsRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, count = 10, metadata = m("a")),
            DistanceRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, distance = Length.meters(1.0), metadata = m("a")),
            ActiveCaloriesBurnedRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, energy = Energy.kilocalories(1.0), metadata = m("a")),
            TotalCaloriesBurnedRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, energy = Energy.kilocalories(1.0), metadata = m("a")),
            FloorsClimbedRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, floors = 1.0, metadata = m("a")),
            ElevationGainedRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, elevation = Length.meters(1.0), metadata = m("a")),
            WheelchairPushesRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, count = 1, metadata = m("a")),
            PowerRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, samples = listOf(PowerRecord.Sample(t, Power.watts(1.0))), metadata = m("a")),
            SpeedRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, samples = listOf(SpeedRecord.Sample(t, Velocity.metersPerSecond(1.0))), metadata = m("a")),
            ActivityIntensityRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, activityIntensityType = ActivityIntensityRecord.ACTIVITY_INTENSITY_TYPE_VIGOROUS, metadata = m("a")),
            Vo2MaxRecord(time = t, zoneOffset = z, vo2MillilitersPerMinuteKilogram = 40.0, measurementMethod = Vo2MaxRecord.MEASUREMENT_METHOD_OTHER, metadata = m("a")),
            WeightRecord(time = t, zoneOffset = z, weight = Mass.kilograms(70.0), metadata = m("a")),
            BodyFatRecord(time = t, zoneOffset = z, percentage = Percentage(20.0), metadata = m("a")),
            BoneMassRecord(time = t, zoneOffset = z, mass = Mass.kilograms(3.0), metadata = m("a")),
            HeightRecord(time = t, zoneOffset = z, height = Length.meters(1.7), metadata = m("a")),
            LeanBodyMassRecord(time = t, zoneOffset = z, mass = Mass.kilograms(50.0), metadata = m("a")),
            BasalMetabolicRateRecord(time = t, zoneOffset = z, basalMetabolicRate = Power.kilocaloriesPerDay(1500.0), metadata = m("a")),
            BodyWaterMassRecord(time = t, zoneOffset = z, mass = Mass.kilograms(35.0), metadata = m("a")),
            HeartRateRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, samples = listOf(HeartRateRecord.Sample(t, 60)), metadata = m("a")),
            HeartRateVariabilityRmssdRecord(time = t, zoneOffset = z, heartRateVariabilityMillis = 40.0, metadata = m("a")),
            OxygenSaturationRecord(time = t, zoneOffset = z, percentage = Percentage(97.0), metadata = m("a")),
            RespiratoryRateRecord(time = t, zoneOffset = z, rate = 15.0, metadata = m("a")),
            BloodGlucoseRecord(time = t, zoneOffset = z, level = BloodGlucose.milligramsPerDeciliter(90.0), metadata = m("a")),
            BloodPressureRecord(time = t, zoneOffset = z, systolic = Pressure.millimetersOfMercury(120.0), diastolic = Pressure.millimetersOfMercury(80.0), metadata = m("a")),
            RestingHeartRateRecord(time = t, zoneOffset = z, beatsPerMinute = 55, metadata = m("a")),
            BodyTemperatureRecord(time = t, zoneOffset = z, temperature = Temperature.celsius(36.6), metadata = m("a")),
            SleepSessionRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, metadata = m("a"),
                stages = listOf(SleepSessionRecord.Stage(t, t2, SleepSessionRecord.STAGE_TYPE_DEEP))),
            ExerciseSessionRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z,
                exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING, metadata = m("a")),
            HydrationRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, volume = Volume.milliliters(250.0), metadata = m("a")),
            NutritionRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, energy = Energy.kilocalories(100.0), protein = Mass.grams(5.0), metadata = m("a")),
            MenstruationFlowRecord(time = t, zoneOffset = z, flow = MenstruationFlowRecord.FLOW_MEDIUM, metadata = m("a")),
            CervicalMucusRecord(time = t, zoneOffset = z, appearance = CervicalMucusRecord.APPEARANCE_CREAMY, sensation = CervicalMucusRecord.SENSATION_MEDIUM, metadata = m("a")),
            OvulationTestRecord(time = t, zoneOffset = z, result = OvulationTestRecord.RESULT_POSITIVE, metadata = m("a")),
            SexualActivityRecord(time = t, zoneOffset = z, protectionUsed = SexualActivityRecord.PROTECTION_USED_PROTECTED, metadata = m("a")),
            BasalBodyTemperatureRecord(time = t, zoneOffset = z, temperature = Temperature.celsius(36.5), metadata = m("a")),
            IntermenstrualBleedingRecord(time = t, zoneOffset = z, metadata = m("a")),
            MenstruationPeriodRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z, metadata = m("a")),
            MindfulnessSessionRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z,
                mindfulnessSessionType = MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_MEDITATION, title = null, notes = null, metadata = m("a")),
            CyclingPedalingCadenceRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z,
                samples = listOf(CyclingPedalingCadenceRecord.Sample(t, 80.0)), metadata = m("a")),
            StepsCadenceRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z,
                samples = listOf(StepsCadenceRecord.Sample(t, 150.0)), metadata = m("a")),
            SkinTemperatureRecord(startTime = t, startZoneOffset = z, endTime = t2, endZoneOffset = z,
                deltas = listOf(SkinTemperatureRecord.Delta(t, TemperatureDelta.celsius(0.3))), baseline = Temperature.celsius(33.0),
                measurementLocation = SkinTemperatureRecord.MEASUREMENT_LOCATION_FINGER, metadata = m("a")),
        )
        val mgr = HealthConnectManager(
            context = org.mockito.Mockito.mock(android.content.Context::class.java),
            injectedReader = FakeRecordReader(recs.groupBy { it::class }),
        )
        val allOn = ExportConfig(
                includeActiveCalories = true, includeDistance = true, includeElevationGained = true, includeExercise = true,
                includeFloorsClimbed = true, includePower = true, includeSpeed = true, includeSteps = true,
                includeTotalCalories = true, includeVO2Max = true, includeWheelchairPushes = true,
                includeActivityIntensity = true, includeCyclingCadence = true, includeStepsCadence = true, includeExerciseRoute = true,
                includeBodyFat = true, includeBoneMass = true, includeHeight = true, includeLeanBodyMass = true, includeWeight = true,
                includeBasalMetabolicRate = true, includeBodyWaterMass = true,
                includeCervicalMucus = true, includeMenstruation = true, includeOvulationTest = true, includeSexualActivity = true,
                includeBasalBodyTemperature = true, includeIntermenstrualBleeding = true, includeMenstruationPeriod = true,
                includeHydration = true, includeNutrition = true, includeNutritionDetail = true, includeSleepSession = true,
                includeBloodGlucose = true, includeBloodPressure = true, includeBodyTemperature = true, includeHeartRate = true,
                includeHeartRateVariability = true, includeOxygenSaturation = true, includeRespiratoryRate = true,
                includeRestingHeartRate = true, includeSkinTemperature = true, includeMindfulness = true,
        )
        // Guard: a newly added includeX flag must be switched on above.
        val off = ExportConfig::class.java.declaredFields.filter {
            it.type == Boolean::class.javaPrimitiveType && it.name.startsWith("include") &&
                !it.apply { isAccessible = true }.getBoolean(allOn)
        }.map { it.name }
        assertEquals(emptyList<String>(), off)
        val days = mgr.readHealthDataByDay(allOn, t.minusSeconds(1), t2.plusSeconds(1))
        assertEquals(emptySet<String>(), mgr.lastFailedMetrics)
        val emitted = JSONObject(ServerForwarder.buildPayload(days, PayloadMeta("1.0.0", "d", 1))).getJSONArray("days").getJSONObject(0)
        val fx = fixture.getJSONArray("days").getJSONObject(0)

        for (section in listOf("activity", "body", "vitals", "sleep", "cycle", "nutrition")) {
            assertEquals(keys(fx.getJSONObject(section)), keys(emitted.getJSONObject(section)), "section $section")
        }
        fun metrics(d: JSONObject) = (0 until d.getJSONArray("samples").length())
            .map { normMetric(d.getJSONArray("samples").getJSONObject(it).getString("metric")) }
        assertEquals(metrics(fx).toSet(), metrics(emitted).toSet())
        assertEquals(metrics(fx).toSet().size, metrics(fx).size, "one fixture sample per metric")
    }
}

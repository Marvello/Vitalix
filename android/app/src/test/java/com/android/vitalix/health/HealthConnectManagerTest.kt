package com.android.vitalix.health

import androidx.health.connect.client.records.ActivityIntensityRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.CyclingPedalingCadenceRecord
import androidx.health.connect.client.records.ExerciseLap
import androidx.health.connect.client.records.ExerciseSegment
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.IntermenstrualBleedingRecord
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.MenstruationPeriodRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.StepsCadenceRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Temperature
import com.android.vitalix.HealthConnectManager
import com.android.vitalix.models.ExportConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mockito.Mockito.mock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.reflect.KClass

/**
 * Smoke test for the [FakeRecordReader] / [HealthConnectManager] harness that
 * later capture tasks (6-9) reuse: feed canned HC records through the real
 * manager and assert the emitted [com.android.vitalix.models.HealthSample].
 */
class HealthConnectManagerTest {

    /**
     * Builds a [Metadata] with an explicit id + dataOrigin, as HC would hand
     * back a record written by another app. connect-client 1.2.0-alpha04's
     * only public factories (`Metadata.manualEntry(...)` etc.) stamp
     * `dataOrigin` to the *calling* app and don't accept an override, which
     * is right for writing but useless for faking a *read* of someone else's
     * data. The full-arg constructor takes a `dataOrigin` param but is
     * `internal` (Kotlin-compiler-enforced only — the constructor is public
     * at the bytecode level), so reflection is used to reach it directly.
     */
    private fun meta(id: String, pkg: String): Metadata {
        val ctor = Metadata::class.java.getDeclaredConstructor(
            Int::class.javaPrimitiveType, String::class.java, DataOrigin::class.java,
            Instant::class.java, String::class.java, Long::class.javaPrimitiveType, Device::class.java,
        )
        ctor.isAccessible = true
        return ctor.newInstance(
            Metadata.RECORDING_METHOD_MANUAL_ENTRY, id, DataOrigin(pkg),
            Instant.EPOCH, null, 0L, null,
        )
    }

    private fun manager(vararg records: Pair<KClass<out Record>, List<Record>>) =
        HealthConnectManager(
            context = mock(android.content.Context::class.java),
            reader = FakeRecordReader(records.toMap()),
        )

    private val t0: Instant = Instant.parse("2026-07-24T06:00:00Z")

    @Test fun stepsEmitsSampleWithSourceAndHcId() = runTest {
        val rec = StepsRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(600), endZoneOffset = ZoneOffset.UTC,
            count = 412, metadata = meta("st-1", "com.samsung.health"),
        )
        val mgr = manager(StepsRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeSteps = true), t0.minusSeconds(1), t0.plusSeconds(601))
        val s = days.single().samples.single { it.metric == "steps" }
        assertEquals(412.0, s.value)
        assertEquals("com.samsung.health", s.source)
        assertEquals("st-1", s.hcId)
    }

    @Test fun basalMetabolicRateEmitsKcalPerDay() = runTest {
        val rec = BasalMetabolicRateRecord(
            time = t0, zoneOffset = ZoneOffset.UTC,
            basalMetabolicRate = Power.kilocaloriesPerDay(1500.0),
            metadata = meta("bmr-1", "com.x"),
        )
        val mgr = manager(BasalMetabolicRateRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeBasalMetabolicRate = true), t0.minusSeconds(1), t0.plusSeconds(1))
        assertEquals(1500.0, days.single().samples.single { it.metric == "basalMetabolicRate" }.value)
    }

    @Test fun bodyWaterMassEmitsKilograms() = runTest {
        val rec = BodyWaterMassRecord(
            time = t0, zoneOffset = ZoneOffset.UTC,
            mass = Mass.kilograms(35.0),
            metadata = meta("bwm-1", "com.x"),
        )
        val mgr = manager(BodyWaterMassRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeBodyWaterMass = true), t0.minusSeconds(1), t0.plusSeconds(1))
        assertEquals(35.0, days.single().samples.single { it.metric == "bodyWaterMass" }.value)
    }

    @Test fun basalBodyTemperatureEmitsCelsiusAndMeasurementLocationMeta() = runTest {
        val rec = BasalBodyTemperatureRecord(
            time = t0, zoneOffset = ZoneOffset.UTC,
            temperature = Temperature.celsius(36.5),
            measurementLocation = androidx.health.connect.client.records.BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_VAGINA,
            metadata = meta("bbt-1", "com.x"),
        )
        val mgr = manager(BasalBodyTemperatureRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeBasalBodyTemperature = true), t0.minusSeconds(1), t0.plusSeconds(1))
        val s = days.single().samples.single { it.metric == "basalBodyTemperature" }
        assertEquals(36.5, s.value)
        assertEquals("vagina", s.meta?.get("measurementLocation"))
    }

    @Test fun intermenstrualBleedingEmitsMarker() = runTest {
        val rec = IntermenstrualBleedingRecord(
            time = t0, zoneOffset = ZoneOffset.UTC,
            metadata = meta("imb-1", "com.x"),
        )
        val mgr = manager(IntermenstrualBleedingRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeIntermenstrualBleeding = true), t0.minusSeconds(1), t0.plusSeconds(1))
        assertEquals(1.0, days.single().samples.single { it.metric == "intermenstrualBleeding" }.value)
    }

    @Test fun menstruationPeriodEmitsSpanMarker() = runTest {
        val rec = MenstruationPeriodRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(86400), endZoneOffset = ZoneOffset.UTC,
            metadata = meta("mp-1", "com.x"),
        )
        val mgr = manager(MenstruationPeriodRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeMenstruationPeriod = true), t0.minusSeconds(1), t0.plusSeconds(90000))
        val s = days.first().samples.single { it.metric == "menstruationPeriod" }
        assertEquals("2026-07-24T06:00:00Z", s.start)
        assertEquals(1.0, s.value)
    }

    @Test fun activityIntensityEmitsIntensityTypeTextAndMeta() = runTest {
        val rec = ActivityIntensityRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(600), endZoneOffset = ZoneOffset.UTC,
            activityIntensityType = ActivityIntensityRecord.ACTIVITY_INTENSITY_TYPE_VIGOROUS,
            metadata = meta("ai-1", "com.x"),
        )
        val mgr = manager(ActivityIntensityRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeActivityIntensity = true), t0.minusSeconds(1), t0.plusSeconds(601))
        val s = days.single().samples.single { it.metric == "activityIntensity" }
        assertEquals("vigorous", s.text)
        assertEquals("vigorous", s.meta?.get("intensityType"))
    }

    @Test fun mindfulnessEmitsDurationMinutesAndTitleOrType() = runTest {
        val rec = MindfulnessSessionRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(600), endZoneOffset = ZoneOffset.UTC,
            mindfulnessSessionType = MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_MEDITATION,
            title = "Morning calm",
            notes = null,
            metadata = meta("mf-1", "com.x"),
        )
        val mgr = manager(MindfulnessSessionRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeMindfulness = true), t0.minusSeconds(1), t0.plusSeconds(601))
        val s = days.single().samples.single { it.metric == "mindfulness" }
        assertEquals(10.0, s.value)
        assertEquals("Morning calm", s.text)
        assertEquals("meditation", s.meta?.get("sessionType"))
    }

    @Test fun cyclingCadenceFansOutSamples() = runTest {
        val rec = CyclingPedalingCadenceRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(120), endZoneOffset = ZoneOffset.UTC,
            samples = listOf(
                CyclingPedalingCadenceRecord.Sample(t0, 80.0),
                CyclingPedalingCadenceRecord.Sample(t0.plusSeconds(60), 85.0),
            ),
            metadata = meta("cc-1", "com.x"),
        )
        val mgr = manager(CyclingPedalingCadenceRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeCyclingCadence = true), t0.minusSeconds(1), t0.plusSeconds(200))
        val samples = days.single().samples.filter { it.metric == "cyclingCadence" }
        assertEquals(2, samples.size)
        assertEquals(80.0, samples[0].value)
        assertEquals(85.0, samples[1].value)
    }

    @Test fun stepsCadenceFansOutSamples() = runTest {
        val rec = StepsCadenceRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(120), endZoneOffset = ZoneOffset.UTC,
            samples = listOf(
                StepsCadenceRecord.Sample(t0, 150.0),
                StepsCadenceRecord.Sample(t0.plusSeconds(60), 155.0),
            ),
            metadata = meta("stc-1", "com.x"),
        )
        val mgr = manager(StepsCadenceRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeStepsCadence = true), t0.minusSeconds(1), t0.plusSeconds(200))
        val samples = days.single().samples.filter { it.metric == "stepsCadence" }
        assertEquals(2, samples.size)
        assertEquals(150.0, samples[0].value)
        assertEquals(155.0, samples[1].value)
    }

    @Test fun skinTemperatureFansOutDeltasWithBaselineMeta() = runTest {
        val rec = SkinTemperatureRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(120), endZoneOffset = ZoneOffset.UTC,
            deltas = listOf(
                SkinTemperatureRecord.Delta(t0, androidx.health.connect.client.units.TemperatureDelta.celsius(0.3)),
                SkinTemperatureRecord.Delta(t0.plusSeconds(60), androidx.health.connect.client.units.TemperatureDelta.celsius(0.5)),
            ),
            baseline = androidx.health.connect.client.units.Temperature.celsius(33.0),
            measurementLocation = SkinTemperatureRecord.MEASUREMENT_LOCATION_FINGER,
            metadata = meta("sk-1", "com.x"),
        )
        val mgr = manager(SkinTemperatureRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeSkinTemperature = true), t0.minusSeconds(1), t0.plusSeconds(200))
        val samples = days.single().samples.filter { it.metric == "skinTemperature" }
        assertEquals(2, samples.size)
        assertEquals(0.3, samples[0].value)
        assertEquals("33.0", samples[0].meta!!["baseline"])
    }

    @Test fun nutritionDetailFansOutNonNullNutrients() = runTest {
        val rec = NutritionRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(60), endZoneOffset = ZoneOffset.UTC,
            protein = Mass.grams(20.0),
            sugar = Mass.grams(5.0),
            mealType = MealType.MEAL_TYPE_BREAKFAST,
            metadata = meta("nu-1", "com.x"),
        )
        val mgr = manager(NutritionRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeNutritionDetail = true), t0.minusSeconds(1), t0.plusSeconds(120))
        val samples = days.single().samples.filter { it.metric.startsWith("nutrition.") }
        val protein = samples.single { it.metric == "nutrition.protein" }
        assertEquals(20.0, protein.value)
        assertEquals("breakfast", protein.meta!!["mealType"])
        val sugar = samples.single { it.metric == "nutrition.sugar" }
        assertEquals(5.0, sugar.value)
        assertEquals("breakfast", sugar.meta!!["mealType"])
        assertTrue(samples.none { it.metric == "nutrition.totalFat" }) // null field omitted
        assertEquals(2, samples.size)
    }

    @Test fun cervicalMucusCarriesSensationMeta() = runTest {
        val rec = CervicalMucusRecord(
            time = t0, zoneOffset = ZoneOffset.UTC,
            appearance = CervicalMucusRecord.APPEARANCE_CREAMY,
            sensation = CervicalMucusRecord.SENSATION_MEDIUM,
            metadata = meta("cm-1", "com.x"),
        )
        val mgr = manager(CervicalMucusRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeCervicalMucus = true), t0.minusSeconds(1), t0.plusSeconds(1))
        val s = days.single().samples.single { it.metric == "cervicalMucus" }
        assertEquals("creamy", s.text)
        assertEquals("medium", s.meta!!["sensation"])
    }

    @Test fun exerciseCapturesLapsAndSegments() = runTest {
        val rec = ExerciseSessionRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(1800), endZoneOffset = ZoneOffset.UTC,
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
            title = "Morning run",
            segments = listOf(
                ExerciseSegment(t0, t0.plusSeconds(300), ExerciseSegment.EXERCISE_SEGMENT_TYPE_RUNNING),
            ),
            laps = listOf(
                ExerciseLap(t0, t0.plusSeconds(600), Length.meters(2000.0)),
            ),
            metadata = meta("ex-1", "com.x"),
        )
        val mgr = manager(ExerciseSessionRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(
            ExportConfig(includeExercise = true, includeExerciseRoute = true),
            t0.minusSeconds(1), t0.plusSeconds(2000),
        )
        val ex = days.single().exercises.single()
        assertEquals(2000.0, ex.laps.single().lengthMeters!!, 0.0)
        assertEquals(1, ex.segments.size)
        assertEquals("running", ex.segments.single().type)
    }
}

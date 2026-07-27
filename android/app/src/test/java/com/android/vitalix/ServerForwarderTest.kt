package com.android.vitalix

import com.android.vitalix.models.*
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
}

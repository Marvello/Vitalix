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
}

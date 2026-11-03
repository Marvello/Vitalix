package com.android.vitalix.widget

import com.android.vitalix.models.DailyHealthData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

class WidgetStateTest {
    private val today = LocalDate.of(2026, 11, 3)

    @Test fun picksTodaysStepsAndSleepOfDayEndingToday() {
        val days = listOf(
            DailyHealthData("2026-11-02", activityData = mapOf("steps" to 9000L), sleepData = mapOf("durationMinutes" to 400L)),
            DailyHealthData("2026-11-03", activityData = mapOf("steps" to 1234L), sleepData = mapOf("durationMinutes" to 432L)),
        )
        val s = WidgetState.fromDays(days, today, "Sent", 5L)
        assertEquals(1234L, s.stepsToday)
        assertEquals(432, s.sleepLastNightMin)
        assertEquals("Sent", s.status)
        assertNull(s.insightReadyDay)
    }

    @Test fun emptyDaysGiveNulls() {
        val s = WidgetState.fromDays(emptyList(), today, "Failed", 0L)
        assertNull(s.stepsToday); assertNull(s.sleepLastNightMin)
    }

    @Test fun todayWithoutMetricsGivesNulls() {
        val s = WidgetState.fromDays(listOf(DailyHealthData("2026-11-03")), today, "Sent", 0L)
        assertNull(s.stepsToday); assertNull(s.sleepLastNightMin)
    }

    @Test fun textFormatting() {
        val at = java.time.Instant.parse("2026-11-03T14:05:00Z").toEpochMilli()
        fun snap(st: String) = WidgetState.Snapshot(st, at, null, null, null)
        assertEquals("Sent · 14:05", WidgetState.statusLine(snap("Sent"), ZoneOffset.UTC))
        assertEquals("Partial · 14:05", WidgetState.statusLine(snap("Partial"), ZoneOffset.UTC))
        assertEquals("Failed (retry)", WidgetState.statusLine(snap("Failed"), ZoneOffset.UTC))
        assertEquals("7h 12m", WidgetState.sleepText(432))
        assertEquals("—", WidgetState.sleepText(null))
    }
}

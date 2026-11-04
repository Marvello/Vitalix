package com.android.vitalix.widget

import com.android.vitalix.SyncLog
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
        val t = WidgetState.StatusText("Sent · %1\$s", "Partial · %1\$s", "Failed (retry)")
        fun snap(st: String) = WidgetState.Snapshot(st, at, null, null, null)
        assertEquals("Sent · 14:05", WidgetState.statusLine(snap("Sent"), t, ZoneOffset.UTC))
        assertEquals("Partial · 14:05", WidgetState.statusLine(snap("Partial"), t, ZoneOffset.UTC))
        assertEquals("Failed (retry)", WidgetState.statusLine(snap("Failed"), t, ZoneOffset.UTC))
        assertEquals("", WidgetState.statusLine(null, t, ZoneOffset.UTC))
        assertEquals("7h 12m", WidgetState.sleepText(432, "%1\$dh %2\$dm", "—"))
        assertEquals("—", WidgetState.sleepText(null, "%1\$dh %2\$dm", "—"))
    }

    @Test fun statusOfMapsSyncOutcomes() {
        assertEquals("Sent", WidgetState.statusOf(SyncLog.Status.SENT))
        assertEquals("Partial", WidgetState.statusOf(SyncLog.Status.PARTIAL))
        assertEquals("Failed", WidgetState.statusOf(SyncLog.Status.FAILED))
        assertNull(WidgetState.statusOf(SyncLog.Status.RUNNING))
    }
}

class WidgetStalenessTest {
    private val today = LocalDate.of(2026, 11, 4)
    private fun snap(day: String?) = WidgetState.Snapshot("Sent", 1L, 900L, 420, "2026-11-03", day)

    @Test fun snapshotFromPreviousDayShowsNoStepsOrSleep() {
        val s = WidgetState.current(snap("2026-11-03"), today)!!
        assertNull(s.stepsToday); assertNull(s.sleepLastNightMin)
        assertEquals("2026-11-03", s.insightReadyDay) // chip is judged separately at render
        assertEquals("Sent", s.status)
    }

    @Test fun legacySnapshotWithoutDayIsStale() {
        assertNull(WidgetState.current(snap(null), today)!!.stepsToday)
    }

    @Test fun snapshotFromTodayIsKept() {
        assertEquals(900L, WidgetState.current(snap("2026-11-04"), today)!!.stepsToday)
        assertNull(WidgetState.current(null, today))
    }

    @Test fun fromDaysStampsTheDay() {
        assertEquals("2026-11-04", WidgetState.fromDays(emptyList(), today, "Sent", 0L).day)
    }

    @Test fun refreshIsOneMinuteAfterNextLocalMidnight() {
        val zone = java.time.ZoneId.of("Asia/Jakarta")
        val now = java.time.ZonedDateTime.of(2026, 11, 4, 23, 59, 0, 0, zone)
        val at = VitalixWidget.nextRefreshAt(now)
        assertEquals(java.time.ZonedDateTime.of(2026, 11, 5, 0, 1, 0, 0, zone).toInstant().toEpochMilli(), at)
    }
}

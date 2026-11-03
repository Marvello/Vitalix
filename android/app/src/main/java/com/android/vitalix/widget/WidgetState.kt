package com.android.vitalix.widget

import android.content.Context
import android.util.Log
import com.android.vitalix.SyncLog
import com.android.vitalix.models.DailyHealthData
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * What the home-screen widget shows. State, not config, so it lives in its own
 * prefs file (like SyncLog) rather than in SyncSettings.
 */
object WidgetState {

    /** [status] is "Sent", "Partial" or "Failed"; [at] is epoch millis of that outcome. */
    data class Snapshot(
        val status: String,
        val at: Long,
        val stepsToday: Long?,
        val sleepLastNightMin: Int?,
        val insightReadyDay: String?,
    )

    private const val PREFS = "vitalix_widget"

    /** Steps and sleep of [today]; sleep belongs to the day it ends. Missing data stays null. */
    fun fromDays(days: List<DailyHealthData>, today: LocalDate, status: String, at: Long): Snapshot {
        val day = days.firstOrNull { it.date == today.toString() }
        return Snapshot(
            status, at,
            (day?.activityData?.get("steps") as? Number)?.toLong(),
            (day?.sleepData?.get("durationMinutes") as? Number)?.toInt(),
            null,
        )
    }

    fun save(ctx: Context, s: Snapshot) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            putString("status", s.status)
            putLong("at", s.at)
            if (s.stepsToday != null) putLong("steps", s.stepsToday) else remove("steps")
            if (s.sleepLastNightMin != null) putInt("sleep", s.sleepLastNightMin) else remove("sleep")
            if (s.insightReadyDay != null) putString("insight", s.insightReadyDay) else remove("insight")
        }.apply()
    }

    fun load(ctx: Context): Snapshot? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val status = p.getString("status", null) ?: return null
        return Snapshot(
            status, p.getLong("at", 0L),
            if (p.contains("steps")) p.getLong("steps", 0L) else null,
            if (p.contains("sleep")) p.getInt("sleep", 0) else null,
            p.getString("insight", null),
        )
    }

    private val LOCK = Any()

    /** Entry points below never throw: a widget failure must not break a sync or a push. */
    private fun safely(what: String, block: () -> Unit) =
        runCatching { synchronized(LOCK) { block() } }.onFailure { Log.w("VitalixWidget", "$what failed", it) }

    /** After a successful read: new steps/sleep replace the old ones, status is set by the outcome. */
    fun noteDays(ctx: Context, days: List<DailyHealthData>) = safely("noteDays") {
        val fresh = fromDays(days, LocalDate.now(), "", 0L)
        val prev = load(ctx) ?: Snapshot("", 0L, null, null, null)
        save(ctx, prev.copy(
            stepsToday = fresh.stepsToday ?: prev.stepsToday,
            sleepLastNightMin = fresh.sleepLastNightMin ?: prev.sleepLastNightMin,
        ))
    }

    /** Records an outcome, keeping the last known steps/sleep, then redraws the widget. */
    fun noteOutcome(ctx: Context, status: String) = safely("noteOutcome") {
        val prev = load(ctx)
        save(ctx, Snapshot(status, System.currentTimeMillis(), prev?.stepsToday, prev?.sleepLastNightMin, prev?.insightReadyDay))
        VitalixWidget.refresh(ctx)
    }

    fun noteInsightReady(ctx: Context, day: String?) = safely("noteInsightReady") {
        val prev = load(ctx) ?: Snapshot("", 0L, null, null, null)
        save(ctx, prev.copy(insightReadyDay = day ?: LocalDate.now().minusDays(1).toString()))
        VitalixWidget.refresh(ctx)
    }

    /** SyncLog outcome -> widget status; null for a run still in flight. */
    fun statusOf(s: SyncLog.Status): String? = when (s) {
        SyncLog.Status.SENT -> "Sent"
        SyncLog.Status.PARTIAL -> "Partial"
        SyncLog.Status.FAILED -> "Failed"
        SyncLog.Status.RUNNING -> null
    }

    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")

    /** User-visible status templates (string resources); `%1$s` in the first two is HH:mm. */
    data class StatusText(val sentAt: String, val partialAt: String, val failed: String)

    /** "Sent · 14:05", "Partial · 14:05", "Failed (retry)"; empty before the first sync. */
    fun statusLine(s: Snapshot?, t: StatusText, zone: ZoneId = ZoneId.systemDefault()): String = when {
        s == null || s.status.isEmpty() -> ""
        s.status == "Failed" -> t.failed
        else -> (if (s.status == "Sent") t.sentAt else t.partialAt)
            .format(HHMM.format(Instant.ofEpochMilli(s.at).atZone(zone)))
    }

    /** [fmt] takes hours then minutes, e.g. "%1$dh %2$dm"; [empty] when unknown. */
    fun sleepText(min: Int?, fmt: String, empty: String): String =
        if (min == null) empty else fmt.format(min / 60, min % 60)
}

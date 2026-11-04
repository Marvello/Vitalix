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
        /** Local date the steps/sleep belong to; null for data saved before this was tracked. */
        val day: String? = null,
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
            today.toString(),
        )
    }

    /** What to render: steps/sleep from a previous day are stale, so they read as unknown. */
    fun current(s: Snapshot?, today: LocalDate): Snapshot? =
        if (s == null || s.day == today.toString()) s else s.copy(stepsToday = null, sleepLastNightMin = null)

    fun save(ctx: Context, s: Snapshot) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            putString("status", s.status)
            putLong("at", s.at)
            if (s.stepsToday != null) putLong("steps", s.stepsToday) else remove("steps")
            if (s.sleepLastNightMin != null) putInt("sleep", s.sleepLastNightMin) else remove("sleep")
            if (s.insightReadyDay != null) putString("insight", s.insightReadyDay) else remove("insight")
            if (s.day != null) putString("day", s.day) else remove("day")
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
            p.getString("day", null),
        )
    }

    private val LOCK = Any()

    /**
     * Entry points below never throw: a widget failure must not break a sync or a push.
     * [LOCK] covers only the prefs read-modify-write; the redraw happens after it is released.
     */
    private fun update(ctx: Context, what: String, redraw: Boolean, change: (Snapshot?) -> Snapshot) =
        runCatching {
            synchronized(LOCK) { save(ctx, change(load(ctx))) }
            if (redraw) VitalixWidget.refresh(ctx)
        }.onFailure { Log.w("VitalixWidget", "$what failed", it) }

    private val EMPTY = Snapshot("", 0L, null, null, null)

    /** After a successful read: new steps/sleep replace the old ones; yesterday's are dropped. */
    fun noteDays(ctx: Context, days: List<DailyHealthData>) = update(ctx, "noteDays", false) { prev ->
        val today = LocalDate.now()
        val fresh = fromDays(days, today, "", 0L)
        val kept = current(prev ?: EMPTY, today)!!
        kept.copy(
            stepsToday = fresh.stepsToday ?: kept.stepsToday,
            sleepLastNightMin = fresh.sleepLastNightMin ?: kept.sleepLastNightMin,
            day = fresh.day,
        )
    }

    /** Records an outcome, keeping the last known steps/sleep, then redraws the widget. */
    fun noteOutcome(ctx: Context, status: String) = update(ctx, "noteOutcome", true) { prev ->
        (prev ?: EMPTY).copy(status = status, at = System.currentTimeMillis())
    }

    fun noteInsightReady(ctx: Context, day: String?) = update(ctx, "noteInsightReady", true) { prev ->
        (prev ?: EMPTY).copy(insightReadyDay = day ?: LocalDate.now().minusDays(1).toString())
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

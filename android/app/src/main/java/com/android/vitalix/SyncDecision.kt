package com.android.vitalix

import androidx.annotation.StringRes
import com.android.vitalix.health.ChangesPlanner
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.SortedSet

/**
 * What one auto-sync run reads and what it may persist afterwards. Pure, so every
 * branch is unit-tested; [ExportWorker] only executes it.
 */
object SyncDecision {
    /** Fallback window cap, today included — same ceiling as the token path. */
    const val MAX_FALLBACK_DAYS = ChangesPlanner.MAX_CHANGED_DAYS

    enum class Mode { TOKEN, FALLBACK }

    data class Decision(
        val mode: Mode,
        /** TOKEN: exactly these days. FALLBACK: empty; read the trailing [daysBack] window. */
        val days: SortedSet<LocalDate>,
        /** Trailing window length (FALLBACK read, log range), capped at [MAX_FALLBACK_DAYS]. */
        val daysBack: Int,
        val deletedIds: List<String>,
        /** TOKEN: token to save after a clean run. FALLBACK: null — take a fresh one before reading. */
        val nextToken: String?,
        /** SyncLog note when older data is skipped. */
        @param:StringRes val note: Int?,
    ) {
        val takeFreshToken: Boolean get() = mode == Mode.FALLBACK

        fun hasPayload(readAnyDays: Boolean) = readAnyDays || deletedIds.isNotEmpty()

        /**
         * What to persist after a successful send. Token and lastSync move only on a
         * clean (no unreadable metric), non-empty send. A clean TOKEN run with nothing
         * to send still moves the token: nothing changed that it hasn't re-read.
         */
        fun commit(readAnyDays: Boolean, clean: Boolean): Commit = when {
            !clean -> Commit(saveToken = false, saveLastSync = false)
            hasPayload(readAnyDays) -> Commit(saveToken = true, saveLastSync = true)
            mode == Mode.TOKEN -> Commit(saveToken = true, saveLastSync = false)
            else -> Commit(saveToken = false, saveLastSync = false)
        }
    }

    data class Commit(val saveToken: Boolean, val saveLastSync: Boolean)

    fun decide(plan: ChangesPlanner.Plan, lastSyncMs: Long, today: LocalDate, zone: ZoneId): Decision {
        val wanted = daysToRead(lastSyncMs, today, zone)
        val daysBack = wanted.coerceAtMost(MAX_FALLBACK_DAYS)
        if (!plan.fallback) {
            return Decision(Mode.TOKEN, plan.days, daysBack, plan.deletedIds, plan.nextToken, note = null)
        }
        val note = when {
            plan.truncated -> R.string.sync_older_skipped
            wanted > MAX_FALLBACK_DAYS -> R.string.sync_older_days_skipped
            else -> null
        }
        return Decision(Mode.FALLBACK, sortedSetOf(), daysBack, plan.deletedIds, nextToken = null, note = note)
    }

    /**
     * Calendar days to read, today included: back to the last sync's day, and
     * never less than yesterday + today — a wearable often hands over last
     * night's data hours after midnight.
     */
    fun daysToRead(lastSyncMs: Long, today: LocalDate, zone: ZoneId = ZoneId.systemDefault()): Int {
        if (lastSyncMs == 0L) return 2
        val lastDay = Instant.ofEpochMilli(lastSyncMs).atZone(zone).toLocalDate()
        return (ChronoUnit.DAYS.between(lastDay, today).toInt() + 1).coerceAtLeast(2)
    }
}

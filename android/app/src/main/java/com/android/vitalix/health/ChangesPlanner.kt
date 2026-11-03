package com.android.vitalix.health

import android.util.Log
import kotlinx.coroutines.CancellationException
import java.time.LocalDate
import java.time.ZoneId
import java.util.SortedSet

/**
 * Turns Health Connect change pages into a sync plan: which local days to re-read
 * in full (so per-day totals stay whole) and which record UIDs the server should
 * delete. [Plan.fallback] means the token can't be trusted — read the window
 * since `lastSync` instead and take a fresh token.
 */
object ChangesPlanner {
    private const val TAG = "ChangesPlanner"

    /**
     * Most changed days re-read via the token; more means a bulk import or a long gap.
     * ponytail: ceiling 31 days — beyond it we read the window since lastSync instead
     * and tell the user to run Full history for anything older.
     */
    const val MAX_CHANGED_DAYS = 31

    data class Plan(
        val days: SortedSet<LocalDate>,
        val deletedIds: List<String>,
        val fallback: Boolean,
        /** Token to store after a clean send; null on fallback. */
        val nextToken: String? = null,
        /** Fallback forced by [MAX_CHANGED_DAYS]; changes older than the window are skipped. */
        val truncated: Boolean = false,
    )

    private fun fallback() = Plan(sortedSetOf(), emptyList(), fallback = true)

    fun plan(pages: List<ChangesPage>, zone: ZoneId, today: LocalDate): Plan {
        if (pages.isEmpty() || pages.any { it.expired }) return fallback()
        // Yesterday + today always: wearables hand over last night's data late.
        val days = sortedSetOf(today.minusDays(1), today)
        for ((start, end) in pages.flatMap { it.upserts }) {
            // Every local date the record touches, so a sleep's end date is in too.
            var d = start.atZone(zone).toLocalDate()
            // Capped at today: a bogus far-future end must not plan years of reads.
            val last = minOf(end.atZone(zone).toLocalDate(), today)
            while (!d.isAfter(last)) { days += d; d = d.plusDays(1) }
        }
        val deleted = pages.flatMap { it.deletedIds }.distinct()
        // Deletions still go out; the window read replaces the (too long) day list.
        if (days.size > MAX_CHANGED_DAYS) return Plan(sortedSetOf(), deleted, fallback = true, truncated = true)
        return Plan(days, deleted, fallback = false, nextToken = pages.last().nextToken)
    }

    /**
     * Pages [ChangesSource.changes] from [token] until done. No token, an expired
     * one, or any failure → fallback: a skipped change would be lost silently.
     */
    suspend fun planFrom(
        source: ChangesSource, token: String?, zone: ZoneId, today: LocalDate,
        warn: (String, Throwable) -> Unit = { msg, e -> Log.w(TAG, msg, e) },
    ): Plan {
        if (token == null) return fallback()
        val pages = mutableListOf<ChangesPage>()
        try {
            var next: String = token
            do {
                val page = source.changes(next)
                pages += page
                if (page.expired) break
                next = page.nextToken
            } while (page.hasMore)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            warn("getChanges failed, falling back to a window read", e)
            return fallback()
        }
        return plan(pages, zone, today)
    }
}

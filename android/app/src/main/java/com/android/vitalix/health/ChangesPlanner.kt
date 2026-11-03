package com.android.vitalix.health

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
    data class Plan(
        val days: SortedSet<LocalDate>,
        val deletedIds: List<String>,
        val fallback: Boolean,
        /** Token to store after a clean send; null on fallback. */
        val nextToken: String? = null,
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
        return Plan(days, deleted, fallback = false, nextToken = pages.last().nextToken)
    }

    /**
     * Pages [ChangesSource.changes] from [token] until done. No token, an expired
     * one, or any failure → fallback: a skipped change would be lost silently.
     */
    suspend fun planFrom(source: ChangesSource, token: String?, zone: ZoneId, today: LocalDate): Plan {
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
            return fallback()
        }
        return plan(pages, zone, today)
    }
}

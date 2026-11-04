package com.android.vitalix

import com.android.vitalix.SyncDecision.Commit
import com.android.vitalix.SyncDecision.Mode
import com.android.vitalix.health.ChangesPlanner
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SyncDecisionTest {
    private val zone = ZoneId.of("Asia/Jakarta")
    private val today = LocalDate.of(2026, 10, 5)
    private fun ms(day: LocalDate) = ZonedDateTime.of(day.atTime(9, 0), zone).toInstant().toEpochMilli()

    private val tokenPlan = ChangesPlanner.Plan(
        sortedSetOf(today.minusDays(1), today), listOf("del-1"), fallback = false, nextToken = "t2")
    private val noTokenPlan = ChangesPlanner.Plan(sortedSetOf(), emptyList(), fallback = true)

    @Test
    fun `valid token re-reads the planned days and keeps the plan's token`() {
        val d = SyncDecision.decide(tokenPlan, ms(today.minusDays(60)), today, zone)
        assertEquals(Mode.TOKEN, d.mode)
        assertEquals(tokenPlan.days, d.days)
        assertEquals(listOf("del-1"), d.deletedIds)
        assertEquals("t2", d.nextToken)
        assertFalse(d.takeFreshToken)
        // A long gap is irrelevant in token mode: no clamp note.
        assertNull(d.note)
    }

    @Test
    fun `no valid token reads the window since lastSync and takes a fresh token first`() {
        val d = SyncDecision.decide(noTokenPlan, ms(today.minusDays(4)), today, zone)
        assertEquals(Mode.FALLBACK, d.mode)
        assertTrue(d.days.isEmpty())
        assertEquals(5, d.daysBack)
        assertTrue(d.takeFreshToken)
        assertNull(d.nextToken)
        assertNull(d.note)
    }

    @Test
    fun `fallback never reads less than yesterday and today`() {
        assertEquals(2, SyncDecision.decide(noTokenPlan, 0L, today, zone).daysBack)
        assertEquals(2, SyncDecision.decide(noTokenPlan, ms(today), today, zone).daysBack)
    }

    @Test
    fun `fallback window is capped at 31 days with a Full history note`() {
        // 30 days back + today = 31: exactly at the cap, nothing skipped.
        val atCap = SyncDecision.decide(noTokenPlan, ms(today.minusDays(30)), today, zone)
        assertEquals(31, atCap.daysBack)
        assertNull(atCap.note)

        val over = SyncDecision.decide(noTokenPlan, ms(today.minusDays(200)), today, zone)
        assertEquals(31, over.daysBack)
        assertEquals(R.string.sync_older_days_skipped, over.note)
    }

    @Test
    fun `truncated plan falls back, keeps its deletions, notes skipped changes`() {
        val truncated = ChangesPlanner.Plan(sortedSetOf(), listOf("a", "b"), fallback = true, truncated = true)
        val d = SyncDecision.decide(truncated, ms(today.minusDays(200)), today, zone)
        assertEquals(Mode.FALLBACK, d.mode)
        assertEquals(listOf("a", "b"), d.deletedIds)
        assertEquals(31, d.daysBack)
        assertTrue(d.takeFreshToken)
        assertEquals(R.string.sync_older_skipped, d.note)
    }

    @Test
    fun `clean non-empty send advances token and lastSync in both modes`() {
        val token = SyncDecision.decide(tokenPlan, 0L, today, zone)
        val fallback = SyncDecision.decide(noTokenPlan, 0L, today, zone)
        assertEquals(Commit(saveToken = true, saveLastSync = true), token.commit(readAnyDays = true, clean = true))
        assertEquals(Commit(saveToken = true, saveLastSync = true), fallback.commit(readAnyDays = true, clean = true))
    }

    @Test
    fun `deletions alone count as a non-empty send`() {
        val truncated = ChangesPlanner.Plan(sortedSetOf(), listOf("a"), fallback = true, truncated = true)
        val d = SyncDecision.decide(truncated, 0L, today, zone)
        assertEquals(Commit(saveToken = true, saveLastSync = true), d.commit(readAnyDays = false, clean = true))
    }

    @Test
    fun `unreadable metric persists nothing`() {
        val token = SyncDecision.decide(tokenPlan, 0L, today, zone)
        val fallback = SyncDecision.decide(noTokenPlan, 0L, today, zone)
        assertEquals(Commit(saveToken = false, saveLastSync = false), token.commit(readAnyDays = true, clean = false))
        assertEquals(Commit(saveToken = false, saveLastSync = false), fallback.commit(readAnyDays = false, clean = false))
    }

    @Test
    fun `token mode with nothing to send advances the token only`() {
        val quiet = ChangesPlanner.Plan(sortedSetOf(today.minusDays(1), today), emptyList(), fallback = false, nextToken = "t2")
        val d = SyncDecision.decide(quiet, 0L, today, zone)
        assertEquals(Commit(saveToken = true, saveLastSync = false), d.commit(readAnyDays = false, clean = true))
        assertFalse(d.hasPayload(readAnyDays = false))
    }

    @Test
    fun `empty fallback read persists nothing, so the window is re-read next run`() {
        val d = SyncDecision.decide(noTokenPlan, 0L, today, zone)
        assertEquals(Commit(saveToken = false, saveLastSync = false), d.commit(readAnyDays = false, clean = true))
    }

    @Test
    fun `daysToRead reads back to the last sync's day, at least yesterday`() {
        assertEquals(2, SyncDecision.daysToRead(0L, today, zone))
        assertEquals(3, SyncDecision.daysToRead(ms(today.minusDays(2)), today, zone))
    }
}

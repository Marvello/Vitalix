package com.android.vitalix.health

import androidx.health.connect.client.records.Record
import kotlinx.coroutines.test.runTest
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.reflect.KClass
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChangesPlannerTest {
    private val zone = ZoneId.of("Asia/Jakarta")
    private val today = LocalDate.of(2026, 10, 5)
    private fun at(d: Int, h: Int) = ZonedDateTime.of(2026, 10, d, h, 0, 0, 0, zone).toInstant()
    private fun page(
        upserts: List<Pair<java.time.Instant, java.time.Instant>> = emptyList(),
        deleted: List<String> = emptyList(),
        next: String = "t1", hasMore: Boolean = false, expired: Boolean = false,
    ) = ChangesPage(upserts, deleted, next, hasMore, expired)

    @Test fun `no changes still re-reads yesterday and today`() {
        val plan = ChangesPlanner.plan(listOf(page()), zone, today)
        assertEquals(listOf(today.minusDays(1), today), plan.days.toList())
        assertFalse(plan.fallback)
        assertEquals("t1", plan.nextToken)
    }

    @Test fun `an interval crossing midnight marks both local dates`() {
        // 23:00 on the 1st to 07:00 on the 2nd (a night's sleep): the end date is in.
        val plan = ChangesPlanner.plan(listOf(page(upserts = listOf(at(1, 23) to at(2, 7)))), zone, today)
        assertEquals(
            listOf(LocalDate.of(2026, 10, 1), LocalDate.of(2026, 10, 2), today.minusDays(1), today),
            plan.days.toList(),
        )
    }

    @Test fun `deletions across pages are collected once, last page's token wins`() {
        val plan = ChangesPlanner.plan(
            listOf(page(deleted = listOf("a", "b"), next = "t1", hasMore = true), page(deleted = listOf("b", "c"), next = "t2")),
            zone, today,
        )
        assertEquals(listOf("a", "b", "c"), plan.deletedIds)
        assertEquals("t2", plan.nextToken)
    }

    @Test fun `more than MAX_CHANGED_DAYS changed days falls back but keeps deletions`() {
        // 29 old days + yesterday + today = 31 -> still token mode
        val ok = (1..29).map { LocalDate.of(2026, 9, 1).plusDays(it.toLong()).atTime(8, 0).atZone(zone).toInstant().let { t -> t to t } }
        val p31 = ChangesPlanner.plan(listOf(page(upserts = ok, deleted = listOf("a"))), zone, today)
        assertEquals(31, p31.days.size)
        assertFalse(p31.fallback)
        assertFalse(p31.truncated)
        val more = ok + (LocalDate.of(2026, 8, 1).atTime(8, 0).atZone(zone).toInstant().let { t -> t to t })
        val p32 = ChangesPlanner.plan(listOf(page(upserts = more, deleted = listOf("a", "b"))), zone, today)
        assertTrue(p32.fallback)
        assertTrue(p32.truncated)
        assertNull(p32.nextToken)
        assertEquals(listOf("a", "b"), p32.deletedIds)
    }

    @Test fun `an expired page means fallback`() {
        val plan = ChangesPlanner.plan(listOf(page(deleted = listOf("a")), page(expired = true)), zone, today)
        assertTrue(plan.fallback)
        assertNull(plan.nextToken)
    }

    private class FakeChangesSource(private val pages: Map<String, ChangesPage>, private val fail: Boolean = false) : ChangesSource {
        val asked = mutableListOf<String>()
        override suspend fun token(types: Set<KClass<out Record>>) = "fresh"
        override suspend fun changes(token: String): ChangesPage {
            asked += token
            if (fail) throw IllegalStateException("boom")
            return pages.getValue(token)
        }
    }

    @Test fun `pages getChanges until hasMore is false`() = runTest {
        val src = FakeChangesSource(mapOf(
            "t0" to page(deleted = listOf("a"), next = "t1", hasMore = true),
            "t1" to page(upserts = listOf(at(3, 8) to at(3, 8)), next = "t2"),
        ))
        val plan = ChangesPlanner.planFrom(src, "t0", zone, today)
        assertEquals(listOf("t0", "t1"), src.asked)
        assertFalse(plan.fallback)
        assertEquals(listOf("a"), plan.deletedIds)
        assertEquals(listOf(LocalDate.of(2026, 10, 3), today.minusDays(1), today), plan.days.toList())
        assertEquals("t2", plan.nextToken)
    }

    @Test fun `no token or a getChanges failure falls back to the window read`() = runTest {
        assertTrue(ChangesPlanner.planFrom(FakeChangesSource(emptyMap()), null, zone, today).fallback)
        val warned = mutableListOf<String>()
        assertTrue(ChangesPlanner.planFrom(FakeChangesSource(emptyMap(), fail = true), "t0", zone, today) { m, _ -> warned += m }.fallback)
        assertEquals(1, warned.size)
    }

    @Test fun `recordSpan reads interval and instantaneous records`() {
        val t = at(2, 7)
        val steps = androidx.health.connect.client.records.StepsRecord(
            startTime = t, startZoneOffset = null, endTime = t.plusSeconds(60), endZoneOffset = null,
            count = 5, metadata = fakeMetadata("s", "pkg"))
        val weight = androidx.health.connect.client.records.WeightRecord(
            weight = androidx.health.connect.client.units.Mass.kilograms(70.0), time = t,
            zoneOffset = null, metadata = fakeMetadata("w", "pkg"))
        assertEquals(t to t.plusSeconds(60), recordSpan(steps))
        assertEquals(t to t, recordSpan(weight))
    }

    @Test fun `an upsert whose time can't be read means fallback, not a skipped day`() = runTest {
        val unknown = object : Record { override val metadata = fakeMetadata("u", "pkg") }
        val response = androidx.health.connect.client.response.ChangesResponse(
            listOf(androidx.health.connect.client.changes.UpsertionChange(unknown)), "t1", false, false)
        val src = object : ChangesSource {
            override suspend fun token(types: Set<KClass<out Record>>) = "fresh"
            override suspend fun changes(token: String) = response.toPage()
        }
        assertTrue(ChangesPlanner.planFrom(src, "t0", zone, today) { _, _ -> }.fallback)
    }
}

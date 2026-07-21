package com.android.vitalix

import com.android.vitalix.health.Aggregation
import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals

class AggregationTest {
    @Test fun computesMinMaxAvg() {
        val r = Aggregation.minMaxAvg(listOf(52.0, 68.0, 146.0))
        assertEquals(52.0, r.min); assertEquals(146.0, r.max)
        assertEquals(88.6667, r.avg!!, 0.001)
    }

    @Test fun emptyIsAllNull() {
        val r = Aggregation.minMaxAvg(emptyList())
        assertEquals(null, r.min); assertEquals(null, r.avg); assertEquals(null, r.max)
    }

    @Test fun singleValueMinMaxAvgEqual() {
        val r = Aggregation.minMaxAvg(listOf(70.0))
        assertEquals(70.0, r.min); assertEquals(70.0, r.max); assertEquals(70.0, r.avg)
    }

    @Test fun bucketByDayUsesZone() {
        // 2026-07-20T23:30:00Z is still 2026-07-20 in UTC but 2026-07-21 in +02:00.
        val instant = Instant.parse("2026-07-20T23:30:00Z")
        assertEquals("2026-07-20", Aggregation.bucketByDay(instant, ZoneId.of("UTC")).toString())
        assertEquals("2026-07-21", Aggregation.bucketByDay(instant, ZoneId.of("+02:00")).toString())
    }

    @Test fun bucketByDayGroupsSameDay() {
        val zone = ZoneId.of("UTC")
        val a = Aggregation.bucketByDay(Instant.parse("2026-07-20T00:00:00Z"), zone)
        val b = Aggregation.bucketByDay(Instant.parse("2026-07-20T23:59:59Z"), zone)
        assertEquals(a, b)
    }
}

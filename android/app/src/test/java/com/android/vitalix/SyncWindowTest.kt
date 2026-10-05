package com.android.vitalix

import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.assertEquals

class SyncWindowTest {
    private val zone = ZoneId.of("Asia/Jakarta")
    private val today = LocalDate.of(2026, 10, 5)
    private fun ms(y: Int, m: Int, d: Int, h: Int) = ZonedDateTime.of(y, m, d, h, 0, 0, 0, zone).toInstant().toEpochMilli()

    @Test
    fun `window starts at local midnight, today counted as day one`() {
        assertEquals(ZonedDateTime.of(2026, 10, 4, 0, 0, 0, 0, zone).toInstant(),
            HealthConnectManager.windowStart(today, 2, zone))
        assertEquals(ZonedDateTime.of(2026, 10, 5, 0, 0, 0, 0, zone).toInstant(),
            HealthConnectManager.windowStart(today, 1, zone))
    }

    @Test
    fun `auto sync reads back to the last sync's day, at least yesterday`() {
        assertEquals(2, ExportWorker.daysToRead(0L, today, zone))
        assertEquals(2, ExportWorker.daysToRead(ms(2026, 10, 5, 8), today, zone))
        assertEquals(2, ExportWorker.daysToRead(ms(2026, 10, 4, 23), today, zone))
        // 47h gap: old code truncated to 1 day (24h) and lost the rest.
        assertEquals(3, ExportWorker.daysToRead(ms(2026, 10, 3, 13), today, zone))
    }
}

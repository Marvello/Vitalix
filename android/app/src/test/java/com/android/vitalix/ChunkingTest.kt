package com.android.vitalix

import com.android.vitalix.models.DailyHealthData
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChunkingTest {

    private fun fakeDays(n: Int): List<DailyHealthData> = (1..n).map { day ->
        DailyHealthData(date = "2026-08-0${day.coerceAtMost(9)}")
    }

    @Test
    fun `splitIntoChunks splits evenly`() {
        val days = fakeDays(14)
        val chunks = ServerForwarder.splitIntoChunks(days, 7)
        assertEquals(2, chunks.size)
        assertEquals(7, chunks[0].size)
        assertEquals(7, chunks[1].size)
    }

    @Test
    fun `splitIntoChunks handles remainder`() {
        val days = fakeDays(10)
        val chunks = ServerForwarder.splitIntoChunks(days, 7)
        assertEquals(2, chunks.size)
        assertEquals(7, chunks[0].size)
        assertEquals(3, chunks[1].size)
    }

    @Test
    fun `splitIntoChunks single day stays single`() {
        val days = fakeDays(1)
        val chunks = ServerForwarder.splitIntoChunks(days, 7)
        assertEquals(1, chunks.size)
        assertEquals(1, chunks[0].size)
    }

    @Test
    fun `splitIntoChunks empty list returns empty`() {
        val chunks = ServerForwarder.splitIntoChunks(emptyList(), 7)
        assertTrue(chunks.isEmpty())
    }

    @Test
    fun `buildPayload includes chunk metadata`() {
        val days = fakeDays(2)
        val meta = PayloadMeta("1.0", "test", 2)
        val json = ServerForwarder.buildPayload(days, meta, chunkIndex = 1, chunkTotal = 3)
        assertTrue(json.contains("\"chunk\""))
        assertTrue(json.contains("\"index\":1"))
        assertTrue(json.contains("\"total\":3"))
    }

    @Test
    fun `buildPayload omits chunk metadata when not chunked`() {
        val days = fakeDays(2)
        val meta = PayloadMeta("1.0", "test", 2)
        val json = ServerForwarder.buildPayload(days, meta)
        assertTrue(!json.contains("\"chunk\""))
    }
}

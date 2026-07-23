package com.android.vitalix.health

import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.delay
import java.time.Instant
import kotlin.reflect.KClass

/**
 * Abstracts [HealthConnectClient.readRecords] so aggregation logic is testable
 * with fake record lists (no on-device HC client required).
 */
interface RecordReader {
    /** @throws PermanentlyUnavailable when the type can't be read at all. */
    suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T>

    /** The record type is not readable (permission declined); not worth retrying. */
    class PermanentlyUnavailable(val type: String) : Exception("no permission for $type")
}

class HealthConnectRecordReader(private val client: HealthConnectClient) : RecordReader {

    /**
     * Reads every page for [type], retrying transient failures.
     *
     * Health Connect throttles reads, and a throttled call throws rather than
     * returning empty. Retrying matters because the caller cannot tell the two
     * apart afterwards: a swallowed rate-limit looks exactly like "the user has
     * no data", which silently drops whole metrics from an export.
     */
    override suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T> {
        var attempt = 0
        while (true) {
            try {
                return readAllPages(type, start, end)
            } catch (e: SecurityException) {
                // Per-record-type grant declined. A different failure from a
                // throttle, and no amount of retrying will change it.
                throw RecordReader.PermanentlyUnavailable(type.simpleName ?: "record")
            } catch (e: Exception) {
                attempt++
                if (attempt > MAX_RETRIES) throw e
                val backoff = BASE_BACKOFF_MS * (1L shl (attempt - 1))
                Log.w(TAG, "Read of ${type.simpleName} failed (attempt $attempt), retrying in ${backoff}ms: ${e.message}")
                delay(backoff)
            }
        }
    }

    private suspend fun <T : Record> readAllPages(
        type: KClass<T>,
        start: Instant,
        end: Instant,
    ): List<T> {
        val all = mutableListOf<T>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = type,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = 1000,
                    pageToken = pageToken,
                )
            )
            all += response.records
            pageToken = response.pageToken
        } while (pageToken != null)
        return all
    }

    private companion object {
        const val TAG = "RecordReader"
        const val MAX_RETRIES = 4
        const val BASE_BACKOFF_MS = 1500L // 1.5s, 3s, 6s, 12s
    }
}

package com.android.vitalix.health

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import kotlin.reflect.KClass

/**
 * Abstracts [HealthConnectClient.readRecords] so aggregation logic is testable
 * with fake record lists (no on-device HC client required).
 */
interface RecordReader {
    suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T>
}

class HealthConnectRecordReader(private val client: HealthConnectClient) : RecordReader {
    override suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T> {
        val all = mutableListOf<T>()
        var pageToken: String? = null
        try {
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
        } catch (_: SecurityException) {
            // Health Connect lets the user grant per record type. A type they
            // declined is simply absent from the export, not a failed sync.
            return emptyList()
        }
        return all
    }
}

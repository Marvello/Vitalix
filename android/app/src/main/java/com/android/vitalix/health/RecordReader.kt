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
    override suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T> =
        client.readRecords(
            ReadRecordsRequest(type, TimeRangeFilter.between(start, end))
        ).records
}

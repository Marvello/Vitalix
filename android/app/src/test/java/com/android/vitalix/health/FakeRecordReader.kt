package com.android.vitalix.health

import androidx.health.connect.client.records.Record
import java.time.Instant
import kotlin.reflect.KClass

/**
 * In-memory [RecordReader] for unit tests: returns the canned list registered
 * for a record type (empty if none was registered), regardless of the
 * requested window. Lets [com.android.vitalix.HealthConnectManager] be
 * exercised end-to-end (aggregation + sample emission) without a real Health
 * Connect client or device.
 */
class FakeRecordReader(private val byType: Map<KClass<out Record>, List<Record>>) : RecordReader {
    @Suppress("UNCHECKED_CAST")
    override suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T> =
        (byType[type] ?: emptyList()) as List<T>
}

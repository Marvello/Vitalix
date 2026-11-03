package com.android.vitalix.health

import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
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

/**
 * Builds a [Metadata] with an explicit id + dataOrigin, as HC would hand back a
 * record written by another app. connect-client 1.2.0-alpha04's public factories
 * stamp `dataOrigin` to the calling app, so the full-arg constructor (internal in
 * Kotlin, public in bytecode) is reached by reflection.
 */
fun fakeMetadata(id: String, pkg: String): Metadata {
    val ctor = Metadata::class.java.getDeclaredConstructor(
        Int::class.javaPrimitiveType, String::class.java, DataOrigin::class.java,
        Instant::class.java, String::class.java, Long::class.javaPrimitiveType, Device::class.java,
    )
    ctor.isAccessible = true
    return ctor.newInstance(
        Metadata.RECORDING_METHOD_MANUAL_ENTRY, id, DataOrigin(pkg),
        Instant.EPOCH, null, 0L, null,
    )
}

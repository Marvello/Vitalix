package com.android.vitalix.health

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import android.util.Log
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ChangesTokenRequest
import java.time.Instant
import kotlin.reflect.KClass

/**
 * One page of Health Connect changes, reduced to what sync needs: the time span
 * of every upserted record (to know which days to re-read) and the UIDs of
 * deleted ones. Abstracts the client so [ChangesPlanner] is testable.
 */
data class ChangesPage(
    val upserts: List<Pair<Instant, Instant>>,
    val deletedIds: List<String>,
    val nextToken: String,
    val hasMore: Boolean,
    val expired: Boolean,
)

interface ChangesSource {
    suspend fun token(types: Set<KClass<out Record>>): String
    suspend fun changes(token: String): ChangesPage
}

class HealthConnectChangesSource(private val client: HealthConnectClient) : ChangesSource {
    override suspend fun token(types: Set<KClass<out Record>>): String =
        client.getChangesToken(ChangesTokenRequest(types))

    override suspend fun changes(token: String): ChangesPage {
        val r = client.getChanges(token)
        val upserts = mutableListOf<Pair<Instant, Instant>>()
        val deleted = mutableListOf<String>()
        for (c in r.changes) when (c) {
            is UpsertionChange -> recordSpan(c.record)?.let { upserts += it }
                ?: Log.w("ChangesSource", "No time on ${c.record::class.simpleName}, not re-read")
            is DeletionChange -> deleted += c.recordId
        }
        return ChangesPage(upserts, deleted, r.nextChangesToken, r.hasMore, r.changesTokenExpired)
    }
}

/**
 * A record's (start, end), or (time, time) for an instantaneous one. The
 * IntervalRecord / InstantaneousRecord interfaces are internal in connect-client,
 * so their public getters are reached by reflection (no minification in this app).
 */
internal fun recordSpan(rec: Record): Pair<Instant, Instant>? {
    fun get(name: String) = try { rec.javaClass.getMethod(name).invoke(rec) as? Instant } catch (_: Exception) { null }
    get("getTime")?.let { return it to it }
    val start = get("getStartTime") ?: return null
    return start to (get("getEndTime") ?: start)
}

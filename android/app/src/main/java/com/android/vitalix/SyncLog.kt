package com.android.vitalix

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Local history of sync runs — what kind, when, how it ended, and which dates it
 * covered. Kept in plain prefs as JSON rather than a database: the log is small,
 * capped, and holds nothing sensitive (no tokens, no health values, just ranges
 * and counts), so it stays outside the encrypted store.
 */
class SyncLog(context: Context) {

    private val prefs = context.getSharedPreferences("vitalix_synclog", Context.MODE_PRIVATE)

    enum class Kind(val label: String) {
        MANUAL("Manual"), AUTO("Auto"), FULL("Full history");

        companion object {
            fun from(name: String?) = entries.firstOrNull { it.name == name } ?: MANUAL
        }
    }

    enum class Status(val label: String) {
        RUNNING("Running"), SENT("Sent"), FAILED("Failed"), PARTIAL("Sent with gaps");

        companion object {
            fun from(name: String?) = entries.firstOrNull { it.name == name } ?: RUNNING
        }
    }

    data class Entry(
        val id: String,
        val kind: Kind,
        val startedAt: Long,
        val finishedAt: Long?,
        val status: Status,
        /** Inclusive first date of the window this run covered, ISO yyyy-MM-dd. */
        val from: String?,
        val to: String?,
        val days: Int,
        val message: String?,
    )

    /** Records the start of a run and returns its id, for [finish] to update. */
    fun start(kind: Kind, from: String?, to: String?): String = synchronized(LOCK) {
        val id = "${System.currentTimeMillis()}-${(0..9999).random()}"
        val entry = Entry(id, kind, System.currentTimeMillis(), null, Status.RUNNING, from, to, 0, null)
        write(listOf(entry) + entries())
        return@synchronized id
    }

    /** Closes out a run. Unknown ids are ignored, so a stale id can't throw. */
    fun finish(
        id: String,
        status: Status,
        days: Int = 0,
        message: String? = null,
        from: String? = null,
        to: String? = null,
    ) = synchronized(LOCK) {
        write(entries().map { e ->
            if (e.id != id) e
            else e.copy(
                finishedAt = System.currentTimeMillis(),
                status = status,
                days = days,
                message = message,
                from = from ?: e.from,
                to = to ?: e.to,
            )
        })
    }

    /**
     * Updates a run in flight. The backfill walks backwards, so its earliest date
     * and day count only become known as it goes — without this the log would show
     * an empty period for the whole run.
     */
    fun progress(id: String, from: String?, days: Int) = synchronized(LOCK) {
        write(entries().map { e ->
            if (e.id != id) e else e.copy(from = from ?: e.from, days = days)
        })
    }

    /**
     * Closes out runs that can no longer be in flight. A killed process — app
     * reinstalled, worker stopped, phone rebooted — leaves an entry stuck on
     * "Running" forever, because nothing survives to call [finish].
     *
     * @param backfillActive whether WorkManager still has a backfill in flight;
     *   only the caller can know that, and a live run must not be closed.
     */
    fun reconcile(backfillActive: Boolean) = synchronized(LOCK) {
        val now = System.currentTimeMillis()
        val all = entries()
        // The backfill is unique work, so at most one run can be live — and it is
        // the newest. Any older entry still marked Running was killed, whether or
        // not a backfill is going now.
        val liveFullId = if (!backfillActive) null
        else all.firstOrNull { it.kind == Kind.FULL && it.status == Status.RUNNING }?.id

        write(all.map { e ->
            if (e.status != Status.RUNNING) return@map e
            val stillRunning = when (e.kind) {
                Kind.FULL -> e.id == liveFullId
                // A foreground sync dies with its Activity, so anything this old
                // is not coming back.
                else -> now - e.startedAt < STALE_AFTER_MS
            }
            if (stillRunning) e
            else e.copy(finishedAt = e.finishedAt ?: now, status = Status.FAILED,
                message = e.message ?: "Interrupted")
        })
    }

    fun entries(): List<Entry> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Entry(
                    id = o.getString("id"),
                    kind = Kind.from(o.optString("kind")),
                    startedAt = o.optLong("startedAt"),
                    finishedAt = if (o.isNull("finishedAt")) null else o.optLong("finishedAt"),
                    status = Status.from(o.optString("status")),
                    from = o.optString("from").ifBlank { null },
                    to = o.optString("to").ifBlank { null },
                    days = o.optInt("days"),
                    message = o.optString("message").ifBlank { null },
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun clear() = synchronized(LOCK) { prefs.edit().remove(KEY).apply() }

    private fun write(entries: List<Entry>) {
        val arr = JSONArray()
        entries.take(MAX_ENTRIES).forEach { e ->
            arr.put(JSONObject().apply {
                put("id", e.id)
                put("kind", e.kind.name)
                put("startedAt", e.startedAt)
                if (e.finishedAt == null) put("finishedAt", JSONObject.NULL) else put("finishedAt", e.finishedAt)
                put("status", e.status.name)
                put("from", e.from ?: "")
                put("to", e.to ?: "")
                put("days", e.days)
                put("message", e.message ?: "")
            })
        }
        prefs.edit().putString(KEY, arr.toString()).apply()
    }

    companion object {
        /**
         * Serialises the read-modify-write cycle. The backfill worker and the log
         * screen update the same prefs from different threads, and interleaved
         * snapshots silently drop entries.
         */
        private val LOCK = Any()

        private const val KEY = "entries"
        private const val MAX_ENTRIES = 200
        /** A foreground run still "Running" after this long was killed, not slow. */
        private const val STALE_AFTER_MS = 30 * 60 * 1000L

        /** ISO date for an instant, in the device's zone — matches how days are bucketed. */
        fun dateOf(instant: Instant): String =
            LocalDate.ofInstant(instant, ZoneId.systemDefault()).toString()

        /** The window a trailing-days sync covers, as (from, to). */
        fun trailingWindow(daysBack: Int): Pair<String, String> {
            val today = LocalDate.now(ZoneId.systemDefault())
            return today.minusDays((daysBack - 1).coerceAtLeast(0).toLong()).toString() to today.toString()
        }
    }
}

package com.android.vitalix

import android.content.Context
import com.android.vitalix.auth.AuthStore
import com.android.vitalix.auth.AuthedHttp
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

data class JournalEntry(val id: Long, val kind: String, val valueNum: Double?, val valueText: String?) {
    /** One-line label for the day's list. */
    fun label(): String = when (kind) {
        "mood" -> "Mood ${valueNum?.toInt()}/5"
        "caffeine" -> "Caffeine ${valueNum?.toInt()} cups"
        "alcohol" -> "Alcohol ${valueNum?.toInt()} drinks"
        else -> "${kind.replaceFirstChar { it.uppercase() }}: $valueText"
    }
}

/** Pure request/response mapping, unit-tested on the JVM. */
object JournalApi {
    /** POST body: exactly one of [num] / [text]; the server derives `day` from `logged_at`. */
    fun postBody(kind: String, num: Int? = null, text: String? = null, loggedAt: Instant = Instant.now()): String =
        JSONObject().put("kind", kind).put("logged_at", loggedAt.toString()).apply {
            if (num != null) put("value_num", num)
            if (text != null) put("value_text", text.trim())
        }.toString()

    fun parseEntries(json: String): List<JournalEntry> {
        val arr = JSONObject(json).optJSONArray("entries") ?: JSONArray()
        return (0 until arr.length()).map { parseEntry(arr.getJSONObject(it)) }
    }

    fun parseEntry(o: JSONObject) = JournalEntry(
        id = o.getLong("id"),
        kind = o.getString("kind"),
        valueNum = if (o.isNull("value_num")) null else o.getDouble("value_num"),
        valueText = if (o.isNull("value_text")) null else o.getString("value_text"),
    )
}

/** Blocking calls (run on Dispatchers.IO); each returns null / false on any failure. */
class JournalClient(private val context: Context) {
    private fun url(path: String) = SyncSettings(context).serverUrl?.toHttpUrlOrNull()?.resolve(path)

    private fun call(req: Request.Builder): okhttp3.Response {
        AuthStore(context).accessToken?.let { req.header("Authorization", "Bearer $it") }
        return AuthedHttp.client(context).newCall(req.build()).execute()
    }

    /** Entries for the user's current day (server decides the day). */
    fun today(): List<JournalEntry>? = runCatching {
        call(Request.Builder().url(url("/api/journal")!!).get()).use { r ->
            if (r.isSuccessful) JournalApi.parseEntries(r.body?.string() ?: "{}") else null
        }
    }.getOrNull()

    fun add(kind: String, num: Int? = null, text: String? = null): Boolean = runCatching {
        val body = JournalApi.postBody(kind, num, text).toRequestBody("application/json".toMediaType())
        call(Request.Builder().url(url("/api/journal")!!).post(body)).use { it.isSuccessful }
    }.getOrDefault(false)

    fun delete(id: Long): Boolean = runCatching {
        call(Request.Builder().url(url("/api/journal/$id")!!).delete()).use { it.isSuccessful }
    }.getOrDefault(false)
}

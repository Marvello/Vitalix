package com.android.vitalix

import android.content.Context
import com.android.vitalix.auth.AuthStore
import com.android.vitalix.auth.AuthedHttp
import com.android.vitalix.models.DailyHealthData
import com.android.vitalix.models.HealthSample
import com.android.vitalix.models.MinMaxAvg
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

data class PayloadMeta(
    val appVersion: String,
    val device: String,
    val rangeDays: Int,
    val profileHeightM: Double? = null,
    val bmiScale: String? = null,
)

object ServerForwarder {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    const val DEFAULT_CHUNK_DAYS = 7
    const val MAX_PAYLOAD_BYTES = 512 * 1024 // 512 KB

    fun splitIntoChunks(days: List<DailyHealthData>, chunkSize: Int): List<List<DailyHealthData>> {
        if (days.isEmpty()) return emptyList()
        return days.chunked(chunkSize.coerceAtLeast(1))
    }

    private fun toJsonValue(v: Any?): Any? = when (v) {
        is MinMaxAvg -> JSONObject().apply {
            v.min?.let { put("min", it) }; v.max?.let { put("max", it) }; v.avg?.let { put("avg", it) }
        }
        is Map<*, *> -> {
            val o = JSONObject()
            for ((k, sub) in v) { val jv = toJsonValue(sub); if (k is String && jv != null) o.put(k, jv) }
            if (o.length() == 0) null else o
        }
        else -> v
    }

    private fun section(map: Map<String, Any?>): JSONObject? {
        if (map.isEmpty()) return null
        val o = JSONObject()
        for ((k, v) in map) if (v != null) { val jv = toJsonValue(v); if (jv != null) o.put(k, jv) }
        return if (o.length() == 0) null else o
    }

    private fun sampleJson(s: HealthSample) = JSONObject().apply {
        put("metric", s.metric); put("start", s.start)
        s.end?.let { put("end", it) }; s.value?.let { put("value", it) }
        s.value2?.let { put("value2", it) }; s.text?.let { put("text", it) }
        s.source?.let { put("source", it) }
        s.hcId?.let { put("hcId", it) }
        s.meta?.takeIf { it.isNotEmpty() }?.let { put("meta", JSONObject(it as Map<*, *>)) }
    }

    fun buildPayload(
        days: List<DailyHealthData>,
        meta: PayloadMeta,
        chunkIndex: Int? = null,
        chunkTotal: Int? = null,
    ): String {
        val root = JSONObject()
        root.put("source", "vitalix")
        root.put("appVersion", meta.appVersion)
        root.put("device", meta.device)
        root.put("exportedAt", java.time.Instant.now().toString())
        root.put("rangeDays", meta.rangeDays)
        if (chunkIndex != null && chunkTotal != null) {
            root.put("chunk", JSONObject().apply {
                put("index", chunkIndex)
                put("total", chunkTotal)
            })
        }
        meta.profileHeightM?.let { root.put("profileHeightM", it) }
        meta.bmiScale?.let { root.put("bmiScale", it) }
        val arr = JSONArray()
        for (d in days) {
            val o = JSONObject().put("date", d.date)
            section(d.activityData)?.let { o.put("activity", it) }
            section(d.bodyMeasurementData)?.let { o.put("body", it) }
            section(d.vitalsData)?.let { o.put("vitals", it) }
            section(d.sleepData)?.let { o.put("sleep", it) }
            section(d.cycleTrackingData)?.let { o.put("cycle", it) }
            section(d.nutritionData)?.let { o.put("nutrition", it) }
            if (d.exercises.isNotEmpty()) o.put("exercises", JSONArray(d.exercises.map { ex ->
                JSONObject().put("name", ex.exerciseName).put("start", ex.startDateTime).put("durationMinutes", ex.durationMinutes)
                    .apply {
                        ex.source?.let { put("source", it) }; ex.hcId?.let { put("hcId", it) }
                        if (ex.laps.isNotEmpty()) put("laps", JSONArray(ex.laps.map { l ->
                            JSONObject().put("start", l.start).put("end", l.end)
                                .apply { l.lengthMeters?.let { put("lengthMeters", it) } }
                        }))
                        if (ex.segments.isNotEmpty()) put("segments", JSONArray(ex.segments.map { s ->
                            JSONObject().put("start", s.start).put("end", s.end).put("type", s.type)
                        }))
                        if (ex.route.isNotEmpty()) put("route", JSONArray(ex.route.map { p ->
                            JSONObject().put("time", p.time).put("lat", p.lat).put("lng", p.lng)
                                .apply {
                                    p.altitudeMeters?.let { put("altitudeMeters", it) }
                                    p.horizontalAccuracyMeters?.let { put("horizontalAccuracyMeters", it) }
                                    p.verticalAccuracyMeters?.let { put("verticalAccuracyMeters", it) }
                                }
                        }))
                    }
            }))
            if (d.samples.isNotEmpty()) o.put("samples", JSONArray(d.samples.map { sampleJson(it) }))
            arr.put(o)
        }
        root.put("days", arr)
        return root.toString()
    }

    suspend fun forward(context: Context, url: String, json: String): Result<Int> = withContext(Dispatchers.IO) {
        try {
            val access = AuthStore(context).accessToken
            val builder = Request.Builder().url(url).post(json.toRequestBody(JSON))
            if (!access.isNullOrBlank()) builder.header("Authorization", "Bearer $access")
            AuthedHttp.client(context).newCall(builder.build()).execute().use { resp ->
                if (resp.isSuccessful) Result.success(resp.code)
                else Result.failure(HttpException(resp.code))
            }
        } catch (e: Exception) { Result.failure(e) }
    }

    suspend fun forwardChunked(
        context: Context,
        url: String,
        days: List<DailyHealthData>,
        meta: PayloadMeta,
        chunkDays: Int = DEFAULT_CHUNK_DAYS,
    ): Result<Unit> {
        val chunks = splitIntoChunks(days, chunkDays)
        if (chunks.isEmpty()) return Result.success(Unit)

        val total = chunks.size
        for ((i, chunk) in chunks.withIndex()) {
            val json = buildPayload(chunk, meta, chunkIndex = i + 1, chunkTotal = total)
            val bytes = json.toByteArray()

            // Tier 2: if a chunk exceeds MAX_PAYLOAD_BYTES, sub-split it
            if (bytes.size > MAX_PAYLOAD_BYTES && chunk.size > 1) {
                val subResult = forwardChunked(context, url, chunk, meta, (chunk.size / 2).coerceAtLeast(1))
                if (subResult.isFailure) return subResult
                continue
            }

            // Single-day escape hatch: send even if over size limit
            if (bytes.size > MAX_PAYLOAD_BYTES) {
                android.util.Log.w("ServerForwarder", "Single day exceeds ${MAX_PAYLOAD_BYTES}B (${bytes.size}B), sending anyway")
            }

            val result = forward(context, url, json)
            if (result.isFailure) {
                val err = result.exceptionOrNull()
                if (err is HttpException && err.code == 413) {
                    throw PayloadTooLargeException(err.code)
                }
                return Result.failure(err ?: Exception("Unknown error"))
            }
        }
        return Result.success(Unit)
    }

    class HttpException(val code: Int) : Exception("HTTP $code")
    class PayloadTooLargeException(val code: Int = 413) : Exception("Server rejected payload: HTTP $code")
}

package com.android.vitalix

import com.android.vitalix.models.DailyHealthData
import com.android.vitalix.models.HealthSample
import com.android.vitalix.models.MinMaxAvg
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class PayloadMeta(val appVersion: String, val device: String, val rangeDays: Int)

object ServerForwarder {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun section(map: Map<String, Any?>): JSONObject? {
        if (map.isEmpty()) return null
        val o = JSONObject()
        for ((k, v) in map) if (v != null) when (v) {
            is MinMaxAvg -> o.put(k, JSONObject().apply {
                v.min?.let { put("min", it) }; v.max?.let { put("max", it) }; v.avg?.let { put("avg", it) }
            })
            else -> o.put(k, v)
        }
        return if (o.length() == 0) null else o
    }

    private fun sampleJson(s: HealthSample) = JSONObject().apply {
        put("metric", s.metric); put("start", s.start)
        s.end?.let { put("end", it) }; s.value?.let { put("value", it) }
        s.value2?.let { put("value2", it) }; s.text?.let { put("text", it) }
    }

    fun buildPayload(days: List<DailyHealthData>, meta: PayloadMeta): String {
        val root = JSONObject()
        root.put("source", "vitalix")
        root.put("appVersion", meta.appVersion)
        root.put("device", meta.device)
        root.put("exportedAt", java.time.Instant.now().toString())
        root.put("rangeDays", meta.rangeDays)
        val arr = JSONArray()
        for (d in days) {
            val o = JSONObject().put("date", d.date)
            section(d.activityData)?.let { o.put("activity", it) }
            section(d.bodyMeasurementData)?.let { o.put("body", it) }
            section(d.vitalsData)?.let { o.put("vitals", it) }
            section(d.sleepData)?.let { o.put("sleep", it) }
            section(d.cycleTrackingData)?.let { o.put("cycle", it) }
            section(d.nutritionData)?.let { o.put("nutrition", it) }
            if (d.exercises.isNotEmpty()) o.put("exercises", JSONArray(d.exercises.map {
                JSONObject().put("name", it.exerciseName).put("start", it.startDateTime).put("durationMinutes", it.durationMinutes)
            }))
            if (d.samples.isNotEmpty()) o.put("samples", JSONArray(d.samples.map { sampleJson(it) }))
            arr.put(o)
        }
        root.put("days", arr)
        return root.toString()
    }

    suspend fun forward(url: String, token: String?, json: String): Result<Int> = withContext(Dispatchers.IO) {
        try {
            val builder = Request.Builder().url(url).post(json.toRequestBody(JSON))
            if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
            client.newCall(builder.build()).execute().use { resp ->
                if (resp.isSuccessful) Result.success(resp.code)
                else Result.failure(HttpException(resp.code))
            }
        } catch (e: Exception) { Result.failure(e) }
    }

    class HttpException(val code: Int) : Exception("HTTP $code")
}

package com.android.vitalix.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class Tokens(val access: String, val refresh: String)

class AuthClient(private val baseUrl: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private suspend fun post(path: String, body: JSONObject): Result<String> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(AuthClient.authBaseFrom(baseUrl) + path)
                .post(body.toString().toRequestBody(JSON)).build()
            client.newCall(req).execute().use { r ->
                val text = r.body?.string() ?: ""
                if (r.isSuccessful) Result.success(text)
                else Result.failure(AuthException(r.code, errorMessage(text)))
            }
        } catch (e: Exception) { Result.failure(e) }
    }

    suspend fun login(email: String, password: String): Result<Tokens> =
        post("/api/auth/login", JSONObject().put("email", email).put("password", password)).map { parseTokens(it) }
    suspend fun signup(inviteCode: String, email: String, password: String): Result<Tokens> =
        post("/api/auth/signup", JSONObject().put("token", inviteCode).put("email", email).put("password", password)).map { parseTokens(it) }
    suspend fun forgot(email: String): Result<Unit> =
        post("/api/auth/forgot", JSONObject().put("email", email)).map { }
    suspend fun refresh(refreshToken: String): Result<Tokens> =
        post("/api/auth/refresh", JSONObject().put("refresh", refreshToken)).map { parseTokens(it) }

    class AuthException(val code: Int, message: String) : Exception(message)

    companion object {
        fun parseTokens(json: String): Tokens {
            val o = JSONObject(json)
            return Tokens(o.getString("access"), o.getString("refresh"))
        }
        fun authBaseFrom(serverUrl: String): String {
            // strip path: keep scheme://host[:port]
            val noScheme = serverUrl.substringAfter("://", serverUrl)
            val scheme = if (serverUrl.contains("://")) serverUrl.substringBefore("://") else "http"
            val hostPort = noScheme.substringBefore("/")
            return "$scheme://$hostPort"
        }
        private fun errorMessage(body: String) = try { JSONObject(body).optString("error", "request failed") } catch (_: Exception) { "request failed" }
    }
}

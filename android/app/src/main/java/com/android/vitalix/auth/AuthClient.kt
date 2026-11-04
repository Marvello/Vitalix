package com.android.vitalix.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
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
    suspend fun logout(refreshToken: String): Result<Unit> =
        post("/api/auth/logout", JSONObject().put("refresh", refreshToken)).map { }
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

/** Outcome of DELETE /api/account, mapped from the HTTP response. */
sealed class DeleteResult {
    object Deleted : DeleteResult()
    object WrongPassword : DeleteResult()
    /** No server URL configured; nothing was sent. */
    object NoServer : DeleteResult()
    /** 401 even after AuthedHttp's refresh: the session is dead, sign in again. */
    object SignedOut : DeleteResult()
    /** Network failure (timeout, DNS, offline). */
    object Unreachable : DeleteResult()
    /** [message] is the server's own text, or null to show the generic string. */
    data class Refused(val message: String?) : DeleteResult()
    /** [code] is the HTTP status (null when no response arrived); [message] the server's text if any. */
    data class Failed(val code: Int?, val message: String?) : DeleteResult()
}

/** Pure request/response mapping for account deletion, unit-tested on the JVM. */
object AccountApi {
    fun deleteBody(password: String): String = JSONObject().put("password", password).toString()

    fun mapDelete(code: Int, body: String): DeleteResult {
        val msg = try { JSONObject(body).optString("error", "") } catch (_: Exception) { "" }
        return when {
            code in 200..299 -> DeleteResult.Deleted
            code == 401 -> DeleteResult.SignedOut
            code == 403 -> DeleteResult.WrongPassword
            code == 409 -> DeleteResult.Refused(msg.ifBlank { null })
            else -> DeleteResult.Failed(code, msg.ifBlank { null })
        }
    }

    /** Runs [call] (server URL → HTTP code + body) and maps every outcome, failures included. */
    fun delete(serverUrl: String?, call: (String) -> Pair<Int, String>): DeleteResult {
        if (serverUrl.isNullOrBlank()) return DeleteResult.NoServer
        return try {
            val (code, body) = call(serverUrl)
            mapDelete(code, body)
        } catch (_: IOException) {
            DeleteResult.Unreachable
        } catch (_: Exception) {
            DeleteResult.Failed(null, null)
        }
    }
}

/** Blocking (run on Dispatchers.IO). The authenticator refreshes an expired access token once. */
fun deleteAccount(context: android.content.Context, password: String): DeleteResult =
    AccountApi.delete(com.android.vitalix.SyncSettings(context).serverUrl) { base ->
        val req = Request.Builder().url(AuthClient.authBaseFrom(base) + "/api/account")
            .method("DELETE", AccountApi.deleteBody(password).toRequestBody("application/json; charset=utf-8".toMediaType()))
        AuthStore(context).accessToken?.let { req.header("Authorization", "Bearer $it") }
        AuthedHttp.client(context).newCall(req.build()).execute().use { it.code to (it.body?.string() ?: "") }
    }

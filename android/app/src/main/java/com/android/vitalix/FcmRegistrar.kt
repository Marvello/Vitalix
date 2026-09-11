package com.android.vitalix

import android.content.Context
import com.android.vitalix.auth.AuthStore
import com.android.vitalix.auth.AuthedHttp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Registers this device's FCM token with the server so the backend can push a
 * "device stopped syncing" nudge to the right user. Fire-and-forget, idempotent
 * (server upserts on the unique token). Called from [MainActivity.onCreate] —
 * covers both app-open and post-login, since login routes into MainActivity.
 */
object FcmRegistrar {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    fun register(context: Context) {
        val serverUrl = SyncSettings(context).serverUrl ?: return
        if (AuthStore(context).accessToken.isNullOrBlank()) return // not logged in
        // Same origin as the /api/health endpoint, whatever its path/port.
        val endpoint = serverUrl.toHttpUrlOrNull()?.resolve("/api/fcm/register") ?: return

        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val body = JSONObject()
                        .put("token", token)
                        .put("app_id", BuildConfig.APPLICATION_ID)
                        .toString()
                    val req = Request.Builder().url(endpoint)
                        .post(body.toRequestBody(JSON))
                    AuthStore(context).accessToken?.let { req.header("Authorization", "Bearer $it") }
                    AuthedHttp.client(context).newCall(req.build()).execute().close()
                } catch (_: Exception) { /* best-effort; retried next app open */ }
            }
        }
    }
}

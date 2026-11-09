package com.android.vitalix

import android.content.Context
import com.android.vitalix.auth.AuthStore
import com.android.vitalix.auth.AuthedHttp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Registers this device's FCM token with the server so the backend can push
 * "no sync" / insight / alert notifications to the right user. Fire-and-forget,
 * idempotent (server upserts on the unique token).
 *
 * FID-based registration (firebase-messaging 26, opt-in via the
 * `firebase_messaging_installation_id_enabled` manifest flag): [register] asks
 * FCM to register, and FCM answers through
 * [VitalixFirebaseService.onRegistered] — on every call, cached token or new
 * one — which hands the token to [upload]. Called from
 * [MainActivity.onCreate], so it covers both app open and post-login.
 */
object FcmRegistrar {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    fun register(context: Context) {
        if (endpoint(context) == null) return // no server or not logged in: nothing to upload to
        FirebaseMessaging.getInstance().register()
    }

    fun upload(context: Context, token: String) {
        val endpoint = endpoint(context) ?: return
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

    // Same origin as the /api/health endpoint, whatever its path/port.
    private fun endpoint(context: Context): HttpUrl? {
        val serverUrl = SyncSettings(context).serverUrl ?: return null
        if (AuthStore(context).accessToken.isNullOrBlank()) return null
        return serverUrl.toHttpUrlOrNull()?.resolve("/api/fcm/register")
    }
}

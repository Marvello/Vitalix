package com.android.vitalix.auth

import android.content.Context
import com.android.vitalix.SyncSettings
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.Route
import java.util.concurrent.TimeUnit

/**
 * OkHttpClient factory whose [Authenticator] transparently refreshes the access
 * token on a 401 (using [AuthStore] + [AuthClient.refresh]) and retries the
 * request once. If the refresh fails or has already been attempted, the
 * authenticator gives up (returns null) and the 401 propagates; [AuthStore] is
 * cleared so the app routes back to login.
 */
object AuthedHttp {
    fun client(context: Context): OkHttpClient {
        val store = AuthStore(context)
        val settings = SyncSettings(context)
        val authenticator = Authenticator { _: Route?, response: Response ->
            if (responseCount(response) >= 2) return@Authenticator null // already retried once
            val refresh = store.refreshToken ?: return@Authenticator null
            val base = settings.serverUrl ?: return@Authenticator null
            val newTokens = runBlocking { AuthClient(base).refresh(refresh) }.getOrNull()
            if (newTokens == null) {
                store.clear()
                return@Authenticator null
            }
            store.save(newTokens.access, newTokens.refresh, store.email ?: "")
            response.request.newBuilder()
                .header("Authorization", "Bearer ${newTokens.access}")
                .build()
        }
        return OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .authenticator(authenticator)
            .build()
    }

    private fun responseCount(response: Response): Int {
        var r: Response? = response
        var c = 1
        while (r?.priorResponse != null) {
            c++
            r = r.priorResponse
        }
        return c
    }
}

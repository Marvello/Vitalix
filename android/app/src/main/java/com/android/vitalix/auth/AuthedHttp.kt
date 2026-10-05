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
 * request once. If the server rejects the refresh token, [AuthStore] is cleared
 * and the 401 propagates so the app routes back to login.
 */
object AuthedHttp {
    // One refresh at a time across every client (ExportWorker, FcmRegistrar, the
    // UI): the server rotates refresh tokens, so a second concurrent refresh with
    // the same token gets a 401 and would log the user out.
    private val refreshLock = Any()

    fun client(context: Context): OkHttpClient {
        val store = AuthStore(context)
        val settings = SyncSettings(context)
        val authenticator = Authenticator { _: Route?, response: Response ->
            if (responseCount(response) >= 2) return@Authenticator null // already retried once
            val base = settings.serverUrl ?: return@Authenticator null
            val sent = response.request.header("Authorization")?.removePrefix("Bearer ")
            val access = synchronized(refreshLock) {
                nextAccessToken(
                    sent = sent,
                    current = store.accessToken,
                    refreshToken = store.refreshToken,
                    refresh = { runBlocking { AuthClient(base).refresh(it) } },
                    save = { store.save(it.access, it.refresh, store.email ?: "") },
                    clear = store::clear,
                )
            } ?: return@Authenticator null
            response.request.newBuilder()
                .header("Authorization", "Bearer $access")
                .build()
        }
        return OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .authenticator(authenticator)
            .build()
    }

    /**
     * The access token to retry a 401'd request with, or null to give up.
     * Call under [refreshLock].
     */
    internal fun nextAccessToken(
        sent: String?,
        current: String?,
        refreshToken: String?,
        refresh: (String) -> Result<Tokens>,
        save: (Tokens) -> Unit,
        clear: () -> Unit,
    ): String? {
        // Another request refreshed while this one waited for the lock.
        if (current != null && current != sent) return current
        if (refreshToken == null) { clear(); return null }
        return refresh(refreshToken).fold(
            onSuccess = { save(it); it.access },
            onFailure = { e ->
                // Only the server rejecting the refresh token ends the session; a
                // timeout or an offline phone keeps it for the next attempt.
                if (e is AuthClient.AuthException && e.code == 401) clear()
                null
            },
        )
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

package com.android.vitalix.auth

import android.content.Context
import com.android.vitalix.security.SecurePrefs

class AuthStore(context: Context) {
    private val prefs = SecurePrefs(context, "vitalix_auth")

    var accessToken: String?
        get() = prefs.getString("access")
        set(v) { if (v != null) prefs.putString("access", v) else prefs.remove("access") }
    var refreshToken: String?
        get() = prefs.getString("refresh")
        set(v) { if (v != null) prefs.putString("refresh", v) else prefs.remove("refresh") }
    var email: String?
        get() = prefs.getString("email")
        set(v) { if (v != null) prefs.putString("email", v) else prefs.remove("email") }

    fun isLoggedIn() = !accessToken.isNullOrBlank() && !refreshToken.isNullOrBlank()
    fun save(access: String, refresh: String, email: String) {
        prefs.putString("access", access)
        prefs.putString("refresh", refresh)
        prefs.putString("email", email)
    }
    fun clear() { prefs.clear() }
}

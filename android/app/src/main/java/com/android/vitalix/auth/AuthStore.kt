package com.android.vitalix.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class AuthStore(context: Context) {
    private val prefs = run {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "vitalix_auth", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    var accessToken: String?
        get() = prefs.getString("access", null); set(v) { prefs.edit().putString("access", v).apply() }
    var refreshToken: String?
        get() = prefs.getString("refresh", null); set(v) { prefs.edit().putString("refresh", v).apply() }
    var email: String?
        get() = prefs.getString("email", null); set(v) { prefs.edit().putString("email", v).apply() }

    fun isLoggedIn() = !accessToken.isNullOrBlank() && !refreshToken.isNullOrBlank()
    fun save(access: String, refresh: String, email: String) {
        prefs.edit().putString("access", access).putString("refresh", refresh).putString("email", email).apply()
    }
    fun clear() { prefs.edit().clear().apply() }
}

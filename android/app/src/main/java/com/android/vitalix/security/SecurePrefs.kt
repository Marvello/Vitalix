package com.android.vitalix.security

import android.content.Context
import android.util.Base64
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager

/**
 * AES-256-GCM encrypted string storage backed by Tink — the replacement for the
 * deprecated Jetpack Security `EncryptedSharedPreferences`.
 *
 * A per-install data-encryption keyset is generated on first use and wrapped by
 * an Android Keystore master key (`android-keystore://`), so the key material
 * never leaves the Keystore. Only values are encrypted (the key names here are
 * non-secret constants); the pref key is bound in as associated data so a
 * ciphertext can't be lifted from one entry and replayed under another.
 *
 * Ciphertext is stored Base64-encoded in an ordinary [android.content.SharedPreferences]
 * file — separate from the Keystore-backed keyset file so clearing values never
 * touches the key.
 */
class SecurePrefs(context: Context, name: String) {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    private val aead: Aead

    init {
        AeadConfig.register()
        val handle = AndroidKeysetManager.Builder()
            .withSharedPref(context, "${name}__keyset", "${name}__keyset_prefs")
            .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
            .withMasterKeyUri("android-keystore://${name}__master_key")
            .build()
            .keysetHandle
        aead = handle.getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    }

    fun getString(key: String): String? {
        val stored = prefs.getString(key, null) ?: return null
        return try {
            String(aead.decrypt(Base64.decode(stored, Base64.NO_WRAP), key.toByteArray()))
        } catch (e: Exception) {
            // Undecryptable (key rotated, corrupt, or written by another scheme):
            // treat as absent rather than crash — the caller re-derives or re-prompts.
            null
        }
    }

    fun putString(key: String, value: String) {
        val ct = aead.encrypt(value.toByteArray(), key.toByteArray())
        prefs.edit().putString(key, Base64.encodeToString(ct, Base64.NO_WRAP)).apply()
    }

    fun contains(key: String): Boolean = prefs.contains(key)
    fun remove(key: String) { prefs.edit().remove(key).apply() }
    fun clear() { prefs.edit().clear().apply() }
}

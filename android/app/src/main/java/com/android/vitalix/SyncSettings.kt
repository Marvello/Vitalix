package com.android.vitalix

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.android.vitalix.models.ExportConfig
import kotlin.reflect.full.memberProperties

class SyncSettings(context: Context) {
    private val secure: SharedPreferences = run {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "vitalix_secure", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    private val plain: SharedPreferences = context.getSharedPreferences("vitalix", Context.MODE_PRIVATE)

    init {
        // Fold URLs saved by the short-lived per-environment build back into one.
        val legacyEnv = secure.getString("server_url_development", null)
            ?: secure.getString("server_url_production", null)
        if (!legacyEnv.isNullOrBlank() && secure.getString(KEY_SERVER_URL, null) == null) {
            secure.edit().putString(KEY_SERVER_URL, legacyEnv).apply()
        }
        if (legacyEnv != null) {
            secure.edit().remove("server_url_development").remove("server_url_production").apply()
        }
    }

    /**
     * Receiver URL. Which server a build points at is a build-time decision
     * ([BuildConfig.DEFAULT_SERVER_URL]); this only holds a user override, so
     * clearing it falls back to the built-in default rather than to nothing.
     */
    var serverUrl: String?
        get() = secure.getString(KEY_SERVER_URL, null)?.takeIf { it.isNotBlank() } ?: defaultServerUrl
        set(v) { secure.edit().putString(KEY_SERVER_URL, v?.trim().orEmpty()).apply() }

    /** The URL this build ships with, or null if it was built without one. */
    val defaultServerUrl: String? = BuildConfig.DEFAULT_SERVER_URL.takeIf { it.isNotBlank() }

    /** True when [serverUrl] is a user override rather than the build default. */
    val serverUrlIsOverridden: Boolean
        get() = !secure.getString(KEY_SERVER_URL, null).isNullOrBlank() &&
            secure.getString(KEY_SERVER_URL, null) != defaultServerUrl

    fun resetServerUrl() { secure.edit().remove(KEY_SERVER_URL).apply() }

    var lastSync: Long
        get() = plain.getLong("last_sync", 0)
        set(v) { plain.edit().putLong("last_sync", v).apply() }
    var autoSyncEnabled: Boolean
        get() = plain.getBoolean("auto_sync", false)
        set(v) { plain.edit().putBoolean("auto_sync", v).apply() }
    var syncIntervalHours: Int
        get() = plain.getInt("sync_interval_hours", 12)
        set(v) { plain.edit().putInt("sync_interval_hours", v).apply() }

    /**
     * Health Connect permissions we have already shown a prompt for. Health
     * Connect won't re-prompt for a declined permission, so this is what tells a
     * *newly added* permission (never asked) apart from a declined one — without
     * it, an app that already holds some permissions can never ask for a new one.
     */
    var requestedPermissions: Set<String>
        get() = plain.getStringSet("requested_permissions", emptySet()) ?: emptySet()
        set(v) { plain.edit().putStringSet("requested_permissions", v).apply() }

    fun writeConfig(cfg: ExportConfig) {
        val e = plain.edit()
        for ((k, v) in configToMap(cfg)) when (v) { is Boolean -> e.putBoolean(k, v); is Int -> e.putInt(k, v) }
        e.apply()
    }
    fun readConfig(): ExportConfig {
        val map = HashMap<String, Any>()
        for (p in ExportConfig::class.memberProperties) {
            when (val d = p.get(ExportConfig())) {
                is Boolean -> map[p.name] = plain.getBoolean(p.name, d)
                is Int -> map[p.name] = plain.getInt(p.name, d)
                else -> {}
            }
        }
        return mapToConfig(map)
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"

        fun configToMap(cfg: ExportConfig): Map<String, Any> {
            val m = HashMap<String, Any>()
            for (p in ExportConfig::class.memberProperties) when (val v = p.get(cfg)) {
                is Boolean -> m[p.name] = v
                is Int -> m[p.name] = v
                else -> {}
            }
            return m
        }
        fun mapToConfig(map: Map<String, Any>): ExportConfig {
            val ctor = ExportConfig::class.constructors.first()
            val default = ctor.callBy(emptyMap())
            val args = ctor.parameters.associateWith { param ->
                map[param.name] ?: ExportConfig::class.memberProperties
                    .first { it.name == param.name }.get(default)
            }
            return ctor.callBy(args)
        }
    }
}

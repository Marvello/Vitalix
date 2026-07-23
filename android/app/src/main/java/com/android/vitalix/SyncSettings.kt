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
        // Carry a URL saved before environments existed into Development.
        val legacy = secure.getString("server_url", null)
        if (!legacy.isNullOrBlank() && secure.getString(Environment.DEVELOPMENT.prefKey, null) == null) {
            secure.edit()
                .putString(Environment.DEVELOPMENT.prefKey, legacy)
                .remove("server_url")
                .apply()
        }
    }

    /**
     * Which environment [serverUrl] resolves to. Each environment keeps its own
     * URL, so switching back and forth doesn't make you retype either one.
     */
    var environment: Environment
        get() = Environment.from(plain.getString("environment", null))
        set(v) { plain.edit().putString("environment", v.key).apply() }

    /** URL of the currently selected [environment]. */
    var serverUrl: String?
        get() = urlFor(environment)
        set(v) { setUrlFor(environment, v) }

    fun urlFor(env: Environment): String? =
        secure.getString(env.prefKey, null)?.takeIf { it.isNotBlank() } ?: env.defaultUrl

    fun setUrlFor(env: Environment, url: String?) {
        secure.edit().putString(env.prefKey, url?.trim().orEmpty()).apply()
    }

    enum class Environment(val key: String, val label: String, val defaultUrl: String?) {
        DEVELOPMENT("development", "Development", "http://localhost:3000/api/health"),

        // No default: the production receiver isn't stood up yet, so an empty
        // field is the honest state rather than a URL that would silently fail.
        PRODUCTION("production", "Production", null);

        val prefKey get() = "server_url_$key"

        companion object {
            fun from(key: String?) = entries.firstOrNull { it.key == key } ?: DEVELOPMENT
        }
    }
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

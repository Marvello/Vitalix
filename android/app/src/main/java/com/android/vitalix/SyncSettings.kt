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

    var serverUrl: String?
        get() = secure.getString("server_url", null)
        set(v) { secure.edit().putString("server_url", v).apply() }
    var lastSync: Long
        get() = plain.getLong("last_sync", 0)
        set(v) { plain.edit().putLong("last_sync", v).apply() }
    var autoSyncEnabled: Boolean
        get() = plain.getBoolean("auto_sync", false)
        set(v) { plain.edit().putBoolean("auto_sync", v).apply() }
    var syncIntervalHours: Int
        get() = plain.getInt("sync_interval_hours", 12)
        set(v) { plain.edit().putInt("sync_interval_hours", v).apply() }

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

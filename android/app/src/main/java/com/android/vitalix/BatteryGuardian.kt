package com.android.vitalix

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Keeps the periodic [ExportWorker] alive when the app is closed.
 *
 * WorkManager is the correct background mechanism, but two OS-level gates stop it
 * from firing without the app open:
 *
 *  1. **Doze / battery optimization** — every OEM. The OS defers or drops background
 *     jobs for apps that aren't exempt. Fixable programmatically: [isExempt] +
 *     [requestExemption] show the system exemption dialog.
 *  2. **OEM app-killers** — Samsung "Sleeping apps", Xiaomi/MIUI autostart, Oppo/Vivo
 *     "startup manager", Huawei "protected apps". Not fixable via API; the user must
 *     flip a switch in a vendor settings screen. [oemHint] describes it and
 *     [openOemSettings] tries to deep-link there, falling back to the app's own
 *     details page.
 */
object BatteryGuardian {

    /** True when the OS is NOT throttling our background work for battery reasons. */
    fun isExempt(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Fires the system "allow app to run in background?" dialog. No-op that returns
     * false if already exempt or the dialog can't be shown.
     */
    fun requestExemption(context: Context): Boolean {
        if (isExempt(context)) return false
        return try {
            @Suppress("BatteryLife")
            context.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:${context.packageName}"))
            )
            true
        } catch (_: ActivityNotFoundException) {
            // Some ROMs strip the direct dialog; drop to the full battery-opt list.
            openBatteryOptimizationList(context)
        }
    }

    /** Opens the OS list of apps + their battery-optimization state. */
    fun openBatteryOptimizationList(context: Context): Boolean = try {
        context.startActivity(
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        )
        true
    } catch (_: ActivityNotFoundException) {
        openAppDetails(context)
    }

    /**
     * A one-liner telling the user which vendor switch to flip, or null on stock
     * Android where the battery-optimization exemption alone is enough.
     */
    fun oemHint(): String? = when (Build.MANUFACTURER.lowercase()) {
        "samsung" ->
            "Samsung: also turn off \"Put app to sleep\" — Settings ▸ Battery ▸ " +
                "Background usage limits ▸ Never sleeping apps ▸ add Vitalix."
        "xiaomi", "redmi", "poco" ->
            "Xiaomi/MIUI: enable Autostart for Vitalix and set battery saver to " +
                "\"No restrictions\" in the app's settings."
        "oppo", "realme", "oneplus" ->
            "Oppo/Realme/OnePlus: allow Auto-launch / background activity for " +
                "Vitalix in the app info screen."
        "vivo", "iqoo" ->
            "Vivo/iQOO: enable \"Auto-start\" and \"High background power " +
                "consumption\" for Vitalix."
        "huawei", "honor" ->
            "Huawei/Honor: set Vitalix to Manage manually and enable Auto-launch " +
                "and Run in background."
        "asus" ->
            "Asus: add Vitalix to the Auto-start Manager allow list."
        else -> null
    }

    /** True when this device's vendor is a known aggressive background-killer. */
    fun hasAggressiveOem(): Boolean = oemHint() != null

    /**
     * Best-effort deep link to the vendor's autostart / background-manager screen.
     * These component names are unofficial and vary by ROM version, so every hop
     * falls back to the app's own details page, which always exists.
     */
    fun openOemSettings(context: Context): Boolean {
        for (intent in oemAutostartIntents()) {
            try {
                context.startActivity(intent)
                return true
            } catch (_: Exception) {
                // Wrong component for this ROM — try the next candidate.
            }
        }
        return openAppDetails(context)
    }

    private fun openAppDetails(context: Context): Boolean = try {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}"))
        )
        true
    } catch (_: ActivityNotFoundException) {
        false
    }

    private fun oemAutostartIntents(): List<Intent> {
        fun component(pkg: String, cls: String) =
            Intent().setClassName(pkg, cls)
        return when (Build.MANUFACTURER.lowercase()) {
            "xiaomi", "redmi", "poco" -> listOf(
                component(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity",
                )
            )
            "oppo", "realme" -> listOf(
                component(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                ),
                component(
                    "com.oppo.safe",
                    "com.oppo.safe.permission.startup.StartupAppListActivity",
                ),
            )
            "vivo", "iqoo" -> listOf(
                component(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                )
            )
            "huawei", "honor" -> listOf(
                component(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                )
            )
            "asus" -> listOf(
                component(
                    "com.asus.mobilemanager",
                    "com.asus.mobilemanager.autostart.AutoStartActivity",
                )
            )
            else -> emptyList()
        }
    }
}

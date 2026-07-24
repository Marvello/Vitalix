package com.android.vitalix

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.switchmaterial.SwitchMaterial
import com.google.android.material.textfield.TextInputEditText

/**
 * Server destination and auto-sync schedule, kept off the sync screen so they
 * aren't edited by accident during normal use.
 *
 * [SyncSettings] is the source of truth: the form is reloaded from it on every
 * resume, so a stale restored view state can never contradict what is stored.
 */
class SettingsActivity : AppCompatActivity() {

    private val settings by lazy { SyncSettings(this) }

    private lateinit var txtServerUrl: TextView
    private lateinit var btnChangeServerUrl: Button
    private lateinit var switchAutoSync: SwitchMaterial
    private lateinit var editSyncInterval: TextInputEditText
    private lateinit var txtAutoSyncState: TextView
    private lateinit var cardBattery: MaterialCardView
    private lateinit var txtBatteryHint: TextView
    private lateinit var btnAllowBackground: Button
    private lateinit var btnOpenDeviceSettings: Button

    /** Suppresses the switch listener while the form is being populated. */
    private var loading = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        txtServerUrl = findViewById(R.id.txtServerUrl)
        btnChangeServerUrl = findViewById(R.id.btnChangeServerUrl)
        switchAutoSync = findViewById(R.id.switchAutoSync)
        editSyncInterval = findViewById(R.id.editSyncInterval)
        txtAutoSyncState = findViewById(R.id.txtAutoSyncState)
        cardBattery = findViewById(R.id.cardBattery)
        txtBatteryHint = findViewById(R.id.txtBatteryHint)
        btnAllowBackground = findViewById(R.id.btnAllowBackground)
        btnOpenDeviceSettings = findViewById(R.id.btnOpenDeviceSettings)

        btnChangeServerUrl.setOnClickListener {
            ServerUrlDialog.show(this, settings) { showServerUrl() }
        }

        switchAutoSync.setOnCheckedChangeListener { _, enabled ->
            if (loading) return@setOnCheckedChangeListener
            if (enabled) tryEnableAutoSync() else commitAutoSync(false)
        }

        btnAllowBackground.setOnClickListener {
            // Already-exempt devices land here only via an aggressive OEM; send them
            // to the vendor screen instead of a dialog that would do nothing.
            if (BatteryGuardian.isExempt(this)) BatteryGuardian.openOemSettings(this)
            else BatteryGuardian.requestExemption(this)
        }
        btnOpenDeviceSettings.setOnClickListener { BatteryGuardian.openOemSettings(this) }
    }

    /**
     * Auto-sync can only go on once background work will actually survive. Two gates:
     * the OS battery exemption (queryable) and, on aggressive OEMs, a one-time
     * confirmation that the app was added to the vendor allow-list (not queryable).
     * A failed gate snaps the switch back off and drives the user to the fix.
     */
    private fun tryEnableAutoSync() {
        if (!BatteryGuardian.isExempt(this)) {
            revertSwitchOff()
            BatteryGuardian.requestExemption(this)
            refreshBatteryCard()
            Toast.makeText(this, "Allow background activity first, then enable auto-sync",
                Toast.LENGTH_LONG).show()
            return
        }
        val hint = BatteryGuardian.oemHint()
        if (hint != null && !settings.neverSleepingAcknowledged) {
            revertSwitchOff()
            MaterialAlertDialogBuilder(this)
                .setTitle("One more step")
                .setMessage(hint)
                .setPositiveButton("I've added it") { _, _ ->
                    settings.neverSleepingAcknowledged = true
                    setSwitchOn()
                    commitAutoSync(true)
                }
                .setNeutralButton("Open settings") { _, _ -> BatteryGuardian.openOemSettings(this) }
                .setNegativeButton("Cancel", null)
                .show()
            return
        }
        commitAutoSync(true)
    }

    /** Applies an auto-sync decision: persist, (re)schedule, refresh the UI. */
    private fun commitAutoSync(enabled: Boolean) {
        settings.autoSyncEnabled = enabled
        applySchedule(enabled)
        describeSchedule()
        refreshBatteryCard()
    }

    private fun revertSwitchOff() {
        loading = true
        switchAutoSync.isChecked = false
        loading = false
    }

    private fun setSwitchOn() {
        loading = true
        switchAutoSync.isChecked = true
        loading = false
    }

    override fun onResume() {
        super.onResume()
        load()
    }

    override fun onPause() {
        super.onPause()
        persistInterval()
    }

    private fun load() {
        loading = true
        showServerUrl()
        switchAutoSync.isChecked = settings.autoSyncEnabled
        editSyncInterval.setText(settings.syncIntervalHours.toString())
        loading = false
        // Re-assert the schedule: the stored flag and WorkManager can drift apart
        // if work was cancelled behind our back (force stop, cleared data).
        applySchedule(settings.autoSyncEnabled)
        describeSchedule()
        refreshBatteryCard()
    }

    /**
     * Shows the warning card whenever auto-sync is on but the OS could still throttle
     * background work — either we're not battery-exempt, or the device is a known
     * aggressive OEM (Samsung, Xiaomi, …) whose app-killer we can't disable via API.
     */
    private fun refreshBatteryCard() {
        val exempt = BatteryGuardian.isExempt(this)
        val oemHint = BatteryGuardian.oemHint()
        val oemPending = oemHint != null && !settings.neverSleepingAcknowledged
        val show = settings.autoSyncEnabled && (!exempt || oemPending)
        cardBattery.visibility = if (show) View.VISIBLE else View.GONE
        if (!show) return

        txtBatteryHint.text = when {
            !exempt && oemPending ->
                "Vitalix isn't allowed to run in the background, so scheduled syncs " +
                    "may not fire while the app is closed.\n\n$oemHint"
            !exempt ->
                "Vitalix isn't allowed to run in the background, so scheduled syncs " +
                    "may not fire while the app is closed."
            else ->
                "Battery access is granted, but this device aggressively stops apps.\n\n$oemHint"
        }
        btnAllowBackground.visibility = if (exempt) View.GONE else View.VISIBLE
        btnOpenDeviceSettings.visibility = if (oemHint != null) View.VISIBLE else View.GONE
    }

    private fun persistInterval() {
        val hours = editSyncInterval.text?.toString()?.trim()?.toIntOrNull()?.coerceAtLeast(1) ?: 12
        if (hours == settings.syncIntervalHours) return
        settings.syncIntervalHours = hours
        if (settings.autoSyncEnabled) applySchedule(true)
    }

    private fun applySchedule(enabled: Boolean) {
        if (enabled) ExportWorker.schedule(this, settings.syncIntervalHours)
        else ExportWorker.cancel(this)
    }

    private fun showServerUrl() {
        val url = settings.serverUrl
        txtServerUrl.text = when {
            url.isNullOrBlank() -> "Not set — tap Change"
            settings.serverUrlIsOverridden -> "$url (custom)"
            else -> url
        }
    }

    /** Reports what WorkManager actually holds, not just what the flag says. */
    private fun describeSchedule() {
        if (!settings.autoSyncEnabled) {
            txtAutoSyncState.text = "Auto-sync is off. Only manual syncs will run."
            return
        }
        val future = WorkManager.getInstance(this).getWorkInfosForUniqueWork(ExportWorker.NAME)
        future.addListener({
            val scheduled = try {
                future.get().any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING }
            } catch (_: Exception) {
                false
            }
            runOnUiThread {
                txtAutoSyncState.text = if (scheduled) {
                    "Scheduled every ${settings.syncIntervalHours}h. Runs when the device has a network."
                } else {
                    "Enabled, but no run is queued yet."
                }
            }
        }, ContextCompat.getMainExecutor(this))
    }
}

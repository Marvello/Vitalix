package com.android.vitalix

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
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

        btnChangeServerUrl.setOnClickListener {
            ServerUrlDialog.show(this, settings) { showServerUrl() }
        }

        switchAutoSync.setOnCheckedChangeListener { _, enabled ->
            if (loading) return@setOnCheckedChangeListener
            settings.autoSyncEnabled = enabled
            applySchedule(enabled)
            describeSchedule()
        }
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

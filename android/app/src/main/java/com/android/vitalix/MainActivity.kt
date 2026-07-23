package com.android.vitalix

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.auth.AuthClient
import com.android.vitalix.auth.AuthStore
import com.android.vitalix.models.ExportConfig
import com.google.android.material.switchmaterial.SwitchMaterial
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Configuration + sync screen. The form is loaded from and persisted to
 * [SyncSettings] (the single SharedPreferences owner). "Sync now" checks Health
 * Connect permissions (requesting them if missing), reads the selected metrics,
 * builds a payload and forwards it to the configured server.
 */
class MainActivity : AppCompatActivity() {

    // Server
    private lateinit var editServerUrl: TextInputEditText

    // Activity
    private lateinit var checkActiveCalories: CheckBox
    private lateinit var checkDistance: CheckBox
    private lateinit var checkElevationGained: CheckBox
    private lateinit var checkExercise: CheckBox
    private lateinit var checkFloorsClimbed: CheckBox
    private lateinit var checkPower: CheckBox
    private lateinit var checkSpeed: CheckBox
    private lateinit var checkSteps: CheckBox
    private lateinit var checkTotalCalories: CheckBox
    private lateinit var checkVO2Max: CheckBox
    private lateinit var checkWheelchairPushes: CheckBox

    // Body
    private lateinit var checkBodyFat: CheckBox
    private lateinit var checkBoneMass: CheckBox
    private lateinit var checkHeight: CheckBox
    private lateinit var checkLeanBodyMass: CheckBox
    private lateinit var checkWeight: CheckBox

    // Cycle
    private lateinit var checkCervicalMucus: CheckBox
    private lateinit var checkMenstruation: CheckBox
    private lateinit var checkOvulationTest: CheckBox
    private lateinit var checkSexualActivity: CheckBox

    // Nutrition
    private lateinit var checkHydration: CheckBox
    private lateinit var checkNutrition: CheckBox

    // Sleep
    private lateinit var checkSleepSession: CheckBox

    // Vitals
    private lateinit var checkBloodGlucose: CheckBox
    private lateinit var checkBloodPressure: CheckBox
    private lateinit var checkBodyTemperature: CheckBox
    private lateinit var checkHeartRate: CheckBox
    private lateinit var checkHeartRateVariability: CheckBox
    private lateinit var checkOxygenSaturation: CheckBox
    private lateinit var checkRespiratoryRate: CheckBox
    private lateinit var checkRestingHeartRate: CheckBox

    // Options
    private lateinit var editDaysBack: TextInputEditText
    private lateinit var switchSaferExport: SwitchMaterial
    private lateinit var switchAutoSync: SwitchMaterial
    private lateinit var editSyncInterval: TextInputEditText

    private lateinit var btnSyncNow: Button
    private lateinit var btnLogout: Button
    private lateinit var txtStatus: TextView
    private lateinit var txtLastSync: TextView

    // Metric selection
    private lateinit var checkAllMetrics: CheckBox
    private lateinit var txtSelectedTotal: TextView
    private lateinit var categories: List<Category>

    /** Set while select-all propagates, so listeners don't fight each other. */
    private var syncingChecks = false

    private val settings by lazy { SyncSettings(this) }
    private val healthConnectManager by lazy { HealthConnectManager(this) }
    private val authStore by lazy { AuthStore(this) }

    private val appVersion: String
        get() = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
        } catch (_: Exception) {
            "1.0.0"
        }

    /** HC permission request contract. On grant of everything we need, run the sync. */
    private val requestPermissions = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        // Partial grants are normal: Health Connect is per-record-type, and users
        // rarely share every category. Sync whatever was allowed.
        if (granted.any { it in healthConnectManager.permissions }) {
            runSync()
        } else {
            showStatus("Failed: no Health Connect data shared. Grant access in Health Connect › App permissions › Vitalix.")
        }
    }

    /** True once the sync UI is inflated + bound. Guards lifecycle hooks (onPause) that
     *  touch views, since the login gate can finish() this Activity before bindViews() runs. */
    private var uiReady = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!authStore.isLoggedIn()) {
            startActivity(Intent(this, LoginActivity::class.java)); finish(); return
        }

        setContentView(R.layout.activity_main)

        bindViews()
        loadSettingsIntoForm()
        wireSelectionUi()
        uiReady = true

        switchAutoSync.setOnCheckedChangeListener { _, enabled ->
            settings.autoSyncEnabled = enabled
            if (enabled) {
                ExportWorker.schedule(this, settings.syncIntervalHours)
            } else {
                ExportWorker.cancel(this)
            }
        }

        btnSyncNow.setOnClickListener { onSyncClicked() }
        btnLogout.setOnClickListener { onLogoutClicked() }
    }

    private fun onLogoutClicked() {
        // Revoke server-side so the refresh token can't outlive the session, but
        // never block logout on it: the local session is cleared either way.
        val url = settings.serverUrl
        val refresh = authStore.refreshToken
        if (!url.isNullOrBlank() && !refresh.isNullOrBlank()) {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            scope.launch { runCatching { AuthClient(url).logout(refresh) } }
        }
        authStore.clear()
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    override fun onPause() {
        super.onPause()
        if (uiReady) persistForm()
    }

    private fun bindViews() {
        editServerUrl = findViewById(R.id.editServerUrl)

        checkActiveCalories = findViewById(R.id.checkActiveCalories)
        checkDistance = findViewById(R.id.checkDistance)
        checkElevationGained = findViewById(R.id.checkElevationGained)
        checkExercise = findViewById(R.id.checkExercise)
        checkFloorsClimbed = findViewById(R.id.checkFloorsClimbed)
        checkPower = findViewById(R.id.checkPower)
        checkSpeed = findViewById(R.id.checkSpeed)
        checkSteps = findViewById(R.id.checkSteps)
        checkTotalCalories = findViewById(R.id.checkTotalCalories)
        checkVO2Max = findViewById(R.id.checkVO2Max)
        checkWheelchairPushes = findViewById(R.id.checkWheelchairPushes)

        checkBodyFat = findViewById(R.id.checkBodyFat)
        checkBoneMass = findViewById(R.id.checkBoneMass)
        checkHeight = findViewById(R.id.checkHeight)
        checkLeanBodyMass = findViewById(R.id.checkLeanBodyMass)
        checkWeight = findViewById(R.id.checkWeight)

        checkCervicalMucus = findViewById(R.id.checkCervicalMucus)
        checkMenstruation = findViewById(R.id.checkMenstruation)
        checkOvulationTest = findViewById(R.id.checkOvulationTest)
        checkSexualActivity = findViewById(R.id.checkSexualActivity)

        checkHydration = findViewById(R.id.checkHydration)
        checkNutrition = findViewById(R.id.checkNutrition)

        checkSleepSession = findViewById(R.id.checkSleepSession)

        checkBloodGlucose = findViewById(R.id.checkBloodGlucose)
        checkBloodPressure = findViewById(R.id.checkBloodPressure)
        checkBodyTemperature = findViewById(R.id.checkBodyTemperature)
        checkHeartRate = findViewById(R.id.checkHeartRate)
        checkHeartRateVariability = findViewById(R.id.checkHeartRateVariability)
        checkOxygenSaturation = findViewById(R.id.checkOxygenSaturation)
        checkRespiratoryRate = findViewById(R.id.checkRespiratoryRate)
        checkRestingHeartRate = findViewById(R.id.checkRestingHeartRate)

        editDaysBack = findViewById(R.id.editDaysBack)
        switchSaferExport = findViewById(R.id.switchSaferExport)
        switchAutoSync = findViewById(R.id.switchAutoSync)
        editSyncInterval = findViewById(R.id.editSyncInterval)

        btnSyncNow = findViewById(R.id.btnSyncNow)
        btnLogout = findViewById(R.id.btnLogout)
        txtStatus = findViewById(R.id.txtStatus)
        txtLastSync = findViewById(R.id.txtLastSync)

        checkAllMetrics = findViewById(R.id.checkAllMetrics)
        txtSelectedTotal = findViewById(R.id.txtSelectedTotal)
    }

    /**
     * One collapsible metric group: a header that expands/collapses [body], a
     * checkbox that selects/clears every metric in it, and a "n/m" count.
     */
    private inner class Category(
        headerId: Int, checkAllId: Int, countId: Int, chevronId: Int, bodyId: Int,
        val metrics: List<CheckBox>,
    ) {
        private val header: View = findViewById(headerId)
        private val body: View = findViewById(bodyId)
        private val chevron: TextView = findViewById(chevronId)
        private val count: TextView = findViewById(countId)
        val checkAll: CheckBox = findViewById(checkAllId)

        val selected: Int get() = metrics.count { it.isChecked }

        fun wire() {
            header.setOnClickListener { setExpanded(body.visibility != View.VISIBLE) }
            checkAll.setOnCheckedChangeListener { _, checked ->
                if (syncingChecks) return@setOnCheckedChangeListener
                metrics.forEach { it.isChecked = checked }
            }
            metrics.forEach { box ->
                box.setOnCheckedChangeListener { _, _ ->
                    if (!syncingChecks) refreshSelectionUi()
                }
            }
            setExpanded(false)
        }

        private fun setExpanded(expanded: Boolean) {
            body.visibility = if (expanded) View.VISIBLE else View.GONE
            chevron.text = if (expanded) "▴" else "▾"
        }

        fun refresh() {
            count.text = "$selected/${metrics.size}"
            checkAll.isChecked = selected == metrics.size
        }
    }

    private fun buildCategories() = listOf(
        Category(
            R.id.headerActivity, R.id.checkCategoryActivity, R.id.countActivity,
            R.id.chevronActivity, R.id.layoutActivitySubtypes,
            listOf(
                checkActiveCalories, checkDistance, checkElevationGained, checkExercise,
                checkFloorsClimbed, checkPower, checkSpeed, checkSteps, checkTotalCalories,
                checkVO2Max, checkWheelchairPushes,
            )
        ),
        Category(
            R.id.headerBodyMeasurements, R.id.checkCategoryBodyMeasurements,
            R.id.countBodyMeasurements, R.id.chevronBodyMeasurements,
            R.id.layoutBodyMeasurementsSubtypes,
            listOf(checkBodyFat, checkBoneMass, checkHeight, checkLeanBodyMass, checkWeight)
        ),
        Category(
            R.id.headerVitals, R.id.checkCategoryVitals, R.id.countVitals,
            R.id.chevronVitals, R.id.layoutVitalsSubtypes,
            listOf(
                checkBloodGlucose, checkBloodPressure, checkBodyTemperature, checkHeartRate,
                checkHeartRateVariability, checkOxygenSaturation, checkRespiratoryRate,
                checkRestingHeartRate,
            )
        ),
        Category(
            R.id.headerSleep, R.id.checkCategorySleep, R.id.countSleep,
            R.id.chevronSleep, R.id.layoutSleepSubtypes,
            listOf(checkSleepSession)
        ),
        Category(
            R.id.headerCycleTracking, R.id.checkCategoryCycleTracking, R.id.countCycleTracking,
            R.id.chevronCycleTracking, R.id.layoutCycleTrackingSubtypes,
            listOf(checkCervicalMucus, checkMenstruation, checkOvulationTest, checkSexualActivity)
        ),
        Category(
            R.id.headerNutrition, R.id.checkCategoryNutrition, R.id.countNutrition,
            R.id.chevronNutrition, R.id.layoutNutritionSubtypes,
            listOf(checkHydration, checkNutrition)
        ),
    )

    private fun wireSelectionUi() {
        categories = buildCategories()
        categories.forEach { it.wire() }
        checkAllMetrics.setOnCheckedChangeListener { _, checked ->
            if (syncingChecks) return@setOnCheckedChangeListener
            syncingChecks = true
            categories.forEach { cat -> cat.metrics.forEach { it.isChecked = checked } }
            syncingChecks = false
            refreshSelectionUi()
        }
        refreshSelectionUi()
    }

    /**
     * Recompute every count and the two select-all boxes from the metric
     * checkboxes, which are the single source of truth. [syncingChecks] stops
     * the programmatic writes here from re-entering the listeners.
     */
    private fun refreshSelectionUi() {
        syncingChecks = true
        categories.forEach { it.refresh() }
        val selected = categories.sumOf { it.selected }
        val total = categories.sumOf { it.metrics.size }
        txtSelectedTotal.text = "$selected of $total selected"
        checkAllMetrics.isChecked = selected == total
        syncingChecks = false
    }

    private fun loadSettingsIntoForm() {
        editServerUrl.setText(settings.serverUrl ?: "")

        val cfg = settings.readConfig()

        checkActiveCalories.isChecked = cfg.includeActiveCalories
        checkDistance.isChecked = cfg.includeDistance
        checkElevationGained.isChecked = cfg.includeElevationGained
        checkExercise.isChecked = cfg.includeExercise
        checkFloorsClimbed.isChecked = cfg.includeFloorsClimbed
        checkPower.isChecked = cfg.includePower
        checkSpeed.isChecked = cfg.includeSpeed
        checkSteps.isChecked = cfg.includeSteps
        checkTotalCalories.isChecked = cfg.includeTotalCalories
        checkVO2Max.isChecked = cfg.includeVO2Max
        checkWheelchairPushes.isChecked = cfg.includeWheelchairPushes

        checkBodyFat.isChecked = cfg.includeBodyFat
        checkBoneMass.isChecked = cfg.includeBoneMass
        checkHeight.isChecked = cfg.includeHeight
        checkLeanBodyMass.isChecked = cfg.includeLeanBodyMass
        checkWeight.isChecked = cfg.includeWeight

        checkCervicalMucus.isChecked = cfg.includeCervicalMucus
        checkMenstruation.isChecked = cfg.includeMenstruation
        checkOvulationTest.isChecked = cfg.includeOvulationTest
        checkSexualActivity.isChecked = cfg.includeSexualActivity

        checkHydration.isChecked = cfg.includeHydration
        checkNutrition.isChecked = cfg.includeNutrition

        checkSleepSession.isChecked = cfg.includeSleepSession

        checkBloodGlucose.isChecked = cfg.includeBloodGlucose
        checkBloodPressure.isChecked = cfg.includeBloodPressure
        checkBodyTemperature.isChecked = cfg.includeBodyTemperature
        checkHeartRate.isChecked = cfg.includeHeartRate
        checkHeartRateVariability.isChecked = cfg.includeHeartRateVariability
        checkOxygenSaturation.isChecked = cfg.includeOxygenSaturation
        checkRespiratoryRate.isChecked = cfg.includeRespiratoryRate
        checkRestingHeartRate.isChecked = cfg.includeRestingHeartRate

        editDaysBack.setText(cfg.daysBack.toString())
        switchSaferExport.isChecked = cfg.saferExportMode
        switchAutoSync.isChecked = settings.autoSyncEnabled
        editSyncInterval.setText(settings.syncIntervalHours.toString())

        updateLastSyncLabel()
    }

    /** Build an [ExportConfig] from the current form state. */
    private fun buildConfigFromForm(): ExportConfig = ExportConfig(
        includeActiveCalories = checkActiveCalories.isChecked,
        includeDistance = checkDistance.isChecked,
        includeElevationGained = checkElevationGained.isChecked,
        includeExercise = checkExercise.isChecked,
        includeFloorsClimbed = checkFloorsClimbed.isChecked,
        includePower = checkPower.isChecked,
        includeSpeed = checkSpeed.isChecked,
        includeSteps = checkSteps.isChecked,
        includeTotalCalories = checkTotalCalories.isChecked,
        includeVO2Max = checkVO2Max.isChecked,
        includeWheelchairPushes = checkWheelchairPushes.isChecked,

        includeBodyFat = checkBodyFat.isChecked,
        includeBoneMass = checkBoneMass.isChecked,
        includeHeight = checkHeight.isChecked,
        includeLeanBodyMass = checkLeanBodyMass.isChecked,
        includeWeight = checkWeight.isChecked,

        includeCervicalMucus = checkCervicalMucus.isChecked,
        includeMenstruation = checkMenstruation.isChecked,
        includeOvulationTest = checkOvulationTest.isChecked,
        includeSexualActivity = checkSexualActivity.isChecked,

        includeHydration = checkHydration.isChecked,
        includeNutrition = checkNutrition.isChecked,

        includeSleepSession = checkSleepSession.isChecked,

        includeBloodGlucose = checkBloodGlucose.isChecked,
        includeBloodPressure = checkBloodPressure.isChecked,
        includeBodyTemperature = checkBodyTemperature.isChecked,
        includeHeartRate = checkHeartRate.isChecked,
        includeHeartRateVariability = checkHeartRateVariability.isChecked,
        includeOxygenSaturation = checkOxygenSaturation.isChecked,
        includeRespiratoryRate = checkRespiratoryRate.isChecked,
        includeRestingHeartRate = checkRestingHeartRate.isChecked,

        daysBack = editDaysBack.text?.toString()?.trim()?.toIntOrNull()?.coerceAtLeast(1) ?: 7,
        saferExportMode = switchSaferExport.isChecked,
        autoSync = switchAutoSync.isChecked
    )

    /** Persist the whole form back into [SyncSettings]. */
    private fun persistForm() {
        settings.serverUrl = editServerUrl.text?.toString()?.trim().orEmpty()
        settings.writeConfig(buildConfigFromForm())
        settings.autoSyncEnabled = switchAutoSync.isChecked
        settings.syncIntervalHours =
            editSyncInterval.text?.toString()?.trim()?.toIntOrNull()?.coerceAtLeast(1) ?: 12
    }

    private fun onSyncClicked() {
        val url = editServerUrl.text?.toString()?.trim().orEmpty()
        if (url.isBlank()) {
            showStatus("Enter a server URL to sync")
            return
        }
        persistForm()

        // Check granted HC permissions; request the missing ones before syncing.
        lifecycleScope.launch {
            val granted = try {
                HealthConnectClient.getOrCreate(this@MainActivity)
                    .permissionController.getGrantedPermissions()
            } catch (e: Exception) {
                showStatus("Failed: Health Connect unavailable (${e.message})")
                return@launch
            }
            val held = granted.intersect(healthConnectManager.permissions)
            when {
                // Everything we can ask for is already granted.
                held.size == healthConnectManager.permissions.size -> runSync()
                // Nothing yet — first run, so show the Health Connect prompt.
                held.isEmpty() -> requestPermissions.launch(healthConnectManager.permissions)
                // Partially granted. Health Connect will not re-prompt for types the
                // user already declined, so asking again would hang on a dialog that
                // never appears. Sync what we're allowed to read.
                else -> runSync()
            }
        }
    }

    private fun runSync() {
        val url = settings.serverUrl?.trim().orEmpty()
        if (url.isBlank()) {
            showStatus("Enter a server URL to sync")
            return
        }
        setSyncing(true)
        showStatus("Exporting…")

        lifecycleScope.launch {
            try {
                val cfg = settings.readConfig()
                healthConnectManager.setSaferExportMode(cfg.saferExportMode)
                val result = withContext(Dispatchers.IO) {
                    val days = healthConnectManager.readHealthDataByDay(cfg)
                    val json = ServerForwarder.buildPayload(
                        days,
                        PayloadMeta(appVersion, Build.MODEL, cfg.daysBack)
                    )
                    ServerForwarder.forward(this@MainActivity, url, json)
                }
                if (result.isSuccess) {
                    settings.lastSync = System.currentTimeMillis()
                    updateLastSyncLabel()
                    showStatus("Sent (HTTP ${result.getOrNull()})")
                } else {
                    val err = result.exceptionOrNull()
                    if (err is ServerForwarder.HttpException && err.code == 401) {
                        // AuthedHttp's authenticator already tried to refresh and failed,
                        // clearing AuthStore. Route back to login.
                        startActivity(Intent(this@MainActivity, LoginActivity::class.java))
                        finish()
                        return@launch
                    }
                    val detail = when (err) {
                        is ServerForwarder.HttpException -> "HTTP ${err.code}"
                        else -> err?.message ?: "unknown error"
                    }
                    showStatus("Failed: $detail")
                }
            } catch (e: Exception) {
                showStatus("Failed: ${e.message}")
            } finally {
                setSyncing(false)
            }
        }
    }

    private fun setSyncing(syncing: Boolean) {
        btnSyncNow.isEnabled = !syncing
    }

    private fun showStatus(message: String) {
        txtStatus.text = "Status: $message"
    }

    private fun updateLastSyncLabel() {
        val last = settings.lastSync
        txtLastSync.text = if (last > 0L) {
            val df = SimpleDateFormat("MMM dd, yyyy HH:mm", Locale.getDefault())
            "Last sync: ${df.format(Date(last))}"
        } else {
            "Last sync: Never"
        }
    }
}

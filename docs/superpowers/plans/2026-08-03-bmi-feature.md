# BMI Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add BMI tracking — Android collects user profile + manual weight input (writing to Health Connect), web dashboard computes and displays BMI with forward-fill, gauge, trend, and historical chart.

**Architecture:** Android gains an onboarding activity for user profile (name, height, weight), HC write capability for weight/height, manual weight dialog, and sends `profileHeightM` + `bmiScale` in the sync payload. Web gains a migration for user profile columns, extracts those fields on ingest, computes BMI server-side via SQL forward-fill, and renders a composite BMI card (gauge + trend + line chart) on the dashboard.

**Tech Stack:** Kotlin/Android (Views/XML, Health Connect SDK, OkHttp), Node.js/Express (EJS, PostgreSQL, node-pg-migrate)

## Global Constraints

- Android: `compileSdk 36`, `minSdk 30`, Java 11, Gradle 9.5, version catalog in `gradle/libs.versions.toml`
- Web: Node ≥ 20, ESM, Express 4, EJS 6, PostgreSQL via `pg`
- Tests: Android JVM unit tests via `./gradlew testDebugUnitTest`; Web tests via `node --test`
- UI: Views/XML on Android; server-rendered EJS on web
- `SyncSettings` is the single source of truth for Android prefs — no direct `SharedPreferences` access elsewhere
- `HealthConnectManager` knows only Health Connect — no network, no settings
- BMI formula: `weight(kg) / height(m)²` — WHO standard
- BMI scales: Standard WHO (Normal < 25, Overweight < 30, Obese ≥ 30) and Asian WHO (Normal < 23, Overweight < 27.5, Obese ≥ 27.5)
- Auto-detect scale from `Locale.getDefault().country`: Asian for `CN,JP,KR,IN,TW,HK,SG,MY,TH,PH,ID,VN,BD,LK,PK,MM,KH,LA,NP,BN`

---

### Task 1: Android — SyncSettings profile fields

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/SyncSettings.kt`

**Interfaces:**
- Produces: `SyncSettings.userName: String?`, `SyncSettings.userHeightCm: Double?`, `SyncSettings.userWeightKg: Double?`, `SyncSettings.onboardingComplete: Boolean`, `SyncSettings.bmiScale: String?`, `SyncSettings.resolvedBmiScale(context: Context): String`

- [ ] **Step 1: Add profile properties to SyncSettings**

Add after the `neverSleepingAcknowledged` property in `SyncSettings.kt`:

```kotlin
var userName: String?
    get() = plain.getString("user_name", null)
    set(v) { plain.edit().putString("user_name", v).apply() }

var userHeightCm: Double?
    get() = if (plain.contains("user_height_cm")) plain.getFloat("user_height_cm", 0f).toDouble() else null
    set(v) { if (v != null) plain.edit().putFloat("user_height_cm", v.toFloat()).apply() else plain.edit().remove("user_height_cm").apply() }

var userWeightKg: Double?
    get() = if (plain.contains("user_weight_kg")) plain.getFloat("user_weight_kg", 0f).toDouble() else null
    set(v) { if (v != null) plain.edit().putFloat("user_weight_kg", v.toFloat()).apply() else plain.edit().remove("user_weight_kg").apply() }

var onboardingComplete: Boolean
    get() = plain.getBoolean("onboarding_complete", false)
    set(v) { plain.edit().putBoolean("onboarding_complete", v).apply() }

var bmiScale: String?
    get() = plain.getString("bmi_scale", null)
    set(v) { plain.edit().putString("bmi_scale", v).apply() }
```

- [ ] **Step 2: Add resolvedBmiScale method**

Add in the `SyncSettings` class body:

```kotlin
fun resolvedBmiScale(): String {
    bmiScale?.let { return it }
    val country = java.util.Locale.getDefault().country
    val asianCountries = setOf(
        "CN", "JP", "KR", "IN", "TW", "HK", "SG", "MY", "TH", "PH",
        "ID", "VN", "BD", "LK", "PK", "MM", "KH", "LA", "NP", "BN"
    )
    return if (country in asianCountries) "asian" else "standard"
}
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/marvellooni/Project/Vitalix/android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/SyncSettings.kt
git commit -m "feat(android): add user profile fields and BMI scale to SyncSettings"
```

---

### Task 2: Android — Health Connect write permissions and insert methods

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`

**Interfaces:**
- Consumes: Health Connect SDK `WeightRecord`, `HeightRecord`
- Produces: `HealthConnectManager.insertWeightRecord(kg: Double, date: LocalDate)`, `HealthConnectManager.insertHeightRecord(cm: Double, date: LocalDate)`, `HealthConnectManager.writePermissions: Set<String>`

- [ ] **Step 1: Add WRITE permissions to AndroidManifest.xml**

Add after the existing `READ_HEIGHT` permission line:

```xml
<uses-permission android:name="android.permission.health.WRITE_WEIGHT"/>
<uses-permission android:name="android.permission.health.WRITE_HEIGHT"/>
```

- [ ] **Step 2: Add write permissions to HealthConnectManager.permissions set**

In `HealthConnectManager.kt`, add to the `permissions` set (after the read permissions):

```kotlin
HealthPermission.getWritePermission(WeightRecord::class),
HealthPermission.getWritePermission(HeightRecord::class),
```

- [ ] **Step 3: Add insertWeightRecord method**

Add to the `HealthConnectManager` class:

```kotlin
suspend fun insertWeightRecord(kg: Double, date: java.time.LocalDate) {
    val time = date.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant()
    val record = WeightRecord(
        weight = androidx.health.connect.client.units.Mass.kilograms(kg),
        time = time,
        zoneOffset = java.time.ZoneId.systemDefault().rules.getOffset(time),
    )
    client.insertRecords(listOf(record))
}
```

- [ ] **Step 4: Add insertHeightRecord method**

Add to the `HealthConnectManager` class:

```kotlin
suspend fun insertHeightRecord(cm: Double, date: java.time.LocalDate) {
    val time = date.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant()
    val record = HeightRecord(
        height = androidx.health.connect.client.units.Length.meters(cm / 100.0),
        time = time,
        zoneOffset = java.time.ZoneId.systemDefault().rules.getOffset(time),
    )
    client.insertRecords(listOf(record))
}
```

- [ ] **Step 5: Verify build**

Run: `cd /Users/marvellooni/Project/Vitalix/android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt
git commit -m "feat(android): add HC write permissions and insert methods for weight/height"
```

---

### Task 3: Android — OnboardingActivity

**Files:**
- Create: `android/app/src/main/res/layout/activity_onboarding.xml`
- Create: `android/app/src/main/java/com/android/vitalix/OnboardingActivity.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/app/src/main/java/com/android/vitalix/MainActivity.kt`

**Interfaces:**
- Consumes: `SyncSettings.userName`, `SyncSettings.userHeightCm`, `SyncSettings.userWeightKg`, `SyncSettings.onboardingComplete`, `HealthConnectManager.insertWeightRecord(kg, date)`, `HealthConnectManager.insertHeightRecord(cm, date)`
- Produces: `OnboardingActivity` (launched from `MainActivity.onCreate` when `onboardingComplete == false`)

- [ ] **Step 1: Create activity_onboarding.xml**

```xml
<?xml version="1.0" encoding="utf-8"?>
<ScrollView xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:fillViewport="true">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:padding="24dp"
        android:gravity="center_horizontal">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="48dp"
            android:layout_marginBottom="8dp"
            android:text="Welcome to Vitalix"
            android:textSize="24sp"
            android:textStyle="bold" />

        <TextView
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="32dp"
            android:text="Set up your profile to get started."
            android:textSize="14sp"
            android:gravity="center" />

        <com.google.android.material.textfield.TextInputLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="16dp"
            android:hint="Name"
            app:boxBackgroundMode="outline">
            <com.google.android.material.textfield.TextInputEditText
                android:id="@+id/editName"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:inputType="textPersonName" />
        </com.google.android.material.textfield.TextInputLayout>

        <com.google.android.material.textfield.TextInputLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="16dp"
            android:hint="Height (cm)"
            app:boxBackgroundMode="outline"
            app:suffixText="cm">
            <com.google.android.material.textfield.TextInputEditText
                android:id="@+id/editHeight"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:inputType="numberDecimal" />
        </com.google.android.material.textfield.TextInputLayout>

        <com.google.android.material.textfield.TextInputLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="24dp"
            android:hint="Weight (kg)"
            app:boxBackgroundMode="outline"
            app:suffixText="kg">
            <com.google.android.material.textfield.TextInputEditText
                android:id="@+id/editWeight"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:inputType="numberDecimal" />
        </com.google.android.material.textfield.TextInputLayout>

        <TextView
            android:id="@+id/txtStatus"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="16dp"
            android:textSize="13sp"
            android:visibility="gone" />

        <Button
            android:id="@+id/btnContinue"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Continue" />

        <Button
            android:id="@+id/btnSkip"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Skip for now"
            style="@style/Widget.MaterialComponents.Button.TextButton" />

    </LinearLayout>
</ScrollView>
```

- [ ] **Step 2: Create OnboardingActivity.kt**

```kotlin
package com.android.vitalix

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.launch
import java.time.LocalDate

class OnboardingActivity : AppCompatActivity() {

    private lateinit var editName: TextInputEditText
    private lateinit var editHeight: TextInputEditText
    private lateinit var editWeight: TextInputEditText
    private lateinit var txtStatus: TextView
    private lateinit var btnContinue: Button
    private lateinit var btnSkip: Button

    private val settings by lazy { SyncSettings(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_onboarding)

        editName = findViewById(R.id.editName)
        editHeight = findViewById(R.id.editHeight)
        editWeight = findViewById(R.id.editWeight)
        txtStatus = findViewById(R.id.txtStatus)
        btnContinue = findViewById(R.id.btnContinue)
        btnSkip = findViewById(R.id.btnSkip)

        btnContinue.setOnClickListener { submit() }
        btnSkip.setOnClickListener { finish(skipProfile = true) }
    }

    private fun submit() {
        val name = editName.text?.toString()?.trim()
        val heightCm = editHeight.text?.toString()?.trim()?.toDoubleOrNull()
        val weightKg = editWeight.text?.toString()?.trim()?.toDoubleOrNull()

        if (name.isNullOrBlank()) {
            editName.error = "Required"
            return
        }
        if (heightCm == null || heightCm <= 0) {
            editHeight.error = "Enter a valid height"
            return
        }
        if (weightKg == null || weightKg <= 0) {
            editWeight.error = "Enter a valid weight"
            return
        }

        btnContinue.isEnabled = false
        btnSkip.isEnabled = false
        txtStatus.text = "Saving…"
        txtStatus.visibility = View.VISIBLE

        settings.userName = name
        settings.userHeightCm = heightCm
        settings.userWeightKg = weightKg

        lifecycleScope.launch {
            try {
                val hcm = HealthConnectManager(this@OnboardingActivity)
                val today = LocalDate.now()
                hcm.insertHeightRecord(heightCm, today)
                hcm.insertWeightRecord(weightKg, today)
            } catch (e: Exception) {
                // HC write is best-effort during onboarding; profile is saved regardless
                Toast.makeText(this@OnboardingActivity,
                    "Profile saved. Health Connect write failed — you can sync later.",
                    Toast.LENGTH_LONG).show()
            }
            finish(skipProfile = false)
        }
    }

    private fun finish(skipProfile: Boolean) {
        settings.onboardingComplete = true
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
```

- [ ] **Step 3: Register OnboardingActivity in AndroidManifest.xml**

Add after the `SyncLogActivity` entry:

```xml
<activity
    android:name=".OnboardingActivity"
    android:exported="false"
    android:theme="@style/Theme.Vitalix" />
```

- [ ] **Step 4: Gate MainActivity on onboarding completion**

In `MainActivity.onCreate`, add at the top of the method (after `super.onCreate(savedInstanceState)`), before `setContentView`:

```kotlin
if (!SyncSettings(this).onboardingComplete) {
    startActivity(Intent(this, OnboardingActivity::class.java))
    finish()
    return
}
```

- [ ] **Step 5: Verify build**

Run: `cd /Users/marvellooni/Project/Vitalix/android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/res/layout/activity_onboarding.xml \
        android/app/src/main/java/com/android/vitalix/OnboardingActivity.kt \
        android/app/src/main/AndroidManifest.xml \
        android/app/src/main/java/com/android/vitalix/MainActivity.kt
git commit -m "feat(android): add onboarding activity for user profile setup"
```

---

### Task 4: Android — Profile section in SettingsActivity + manual weight dialog

**Files:**
- Modify: `android/app/src/main/res/layout/activity_settings.xml`
- Modify: `android/app/src/main/java/com/android/vitalix/SettingsActivity.kt`

**Interfaces:**
- Consumes: `SyncSettings.userName`, `SyncSettings.userHeightCm`, `SyncSettings.userWeightKg`, `SyncSettings.bmiScale`, `SyncSettings.resolvedBmiScale()`, `HealthConnectManager.insertWeightRecord(kg, date)`, `HealthConnectManager.insertHeightRecord(cm, date)`

- [ ] **Step 1: Add Profile card to activity_settings.xml**

Add before the Server card (the first `MaterialCardView`):

```xml
<!-- Profile -->
<com.google.android.material.card.MaterialCardView
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:layout_marginBottom="16dp"
    app:cardCornerRadius="8dp"
    app:cardElevation="4dp">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:padding="16dp">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginBottom="12dp"
            android:text="Profile"
            android:textSize="16sp"
            android:textStyle="bold" />

        <com.google.android.material.textfield.TextInputLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="8dp"
            android:hint="Name"
            app:boxBackgroundMode="outline">
            <com.google.android.material.textfield.TextInputEditText
                android:id="@+id/editProfileName"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:inputType="textPersonName" />
        </com.google.android.material.textfield.TextInputLayout>

        <com.google.android.material.textfield.TextInputLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="8dp"
            android:hint="Height (cm)"
            app:boxBackgroundMode="outline"
            app:suffixText="cm">
            <com.google.android.material.textfield.TextInputEditText
                android:id="@+id/editProfileHeight"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:inputType="numberDecimal" />
        </com.google.android.material.textfield.TextInputLayout>

        <com.google.android.material.textfield.TextInputLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="12dp"
            android:hint="Weight (kg)"
            app:boxBackgroundMode="outline"
            app:suffixText="kg">
            <com.google.android.material.textfield.TextInputEditText
                android:id="@+id/editProfileWeight"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:inputType="numberDecimal" />
        </com.google.android.material.textfield.TextInputLayout>

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginBottom="8dp"
            android:text="BMI Scale"
            android:textSize="14sp" />

        <com.google.android.material.button.MaterialButtonToggleGroup
            android:id="@+id/toggleBmiScale"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginBottom="12dp"
            app:singleSelection="true"
            app:selectionRequired="true">

            <com.google.android.material.button.MaterialButton
                android:id="@+id/btnScaleAuto"
                style="@style/Widget.MaterialComponents.Button.OutlinedButton"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Auto" />

            <com.google.android.material.button.MaterialButton
                android:id="@+id/btnScaleStandard"
                style="@style/Widget.MaterialComponents.Button.OutlinedButton"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Standard" />

            <com.google.android.material.button.MaterialButton
                android:id="@+id/btnScaleAsian"
                style="@style/Widget.MaterialComponents.Button.OutlinedButton"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Asian" />

        </com.google.android.material.button.MaterialButtonToggleGroup>

        <Button
            android:id="@+id/btnSaveProfile"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Save profile" />

        <Button
            android:id="@+id/btnManualWeight"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="8dp"
            android:text="Log weight manually"
            style="@style/Widget.MaterialComponents.Button.OutlinedButton" />

    </LinearLayout>
</com.google.android.material.card.MaterialCardView>
```

- [ ] **Step 2: Add profile field bindings and load in SettingsActivity.kt**

Add field declarations after existing `lateinit var` block:

```kotlin
private lateinit var editProfileName: TextInputEditText
private lateinit var editProfileHeight: TextInputEditText
private lateinit var editProfileWeight: TextInputEditText
private lateinit var toggleBmiScale: com.google.android.material.button.MaterialButtonToggleGroup
private lateinit var btnSaveProfile: Button
private lateinit var btnManualWeight: Button
```

In `onCreate`, after existing `findViewById` calls:

```kotlin
editProfileName = findViewById(R.id.editProfileName)
editProfileHeight = findViewById(R.id.editProfileHeight)
editProfileWeight = findViewById(R.id.editProfileWeight)
toggleBmiScale = findViewById(R.id.toggleBmiScale)
btnSaveProfile = findViewById(R.id.btnSaveProfile)
btnManualWeight = findViewById(R.id.btnManualWeight)

btnSaveProfile.setOnClickListener { saveProfile() }
btnManualWeight.setOnClickListener { showManualWeightDialog() }

toggleBmiScale.addOnButtonCheckedListener { _, checkedId, isChecked ->
    if (!isChecked || loading) return@addOnButtonCheckedListener
    settings.bmiScale = when (checkedId) {
        R.id.btnScaleStandard -> "standard"
        R.id.btnScaleAsian -> "asian"
        else -> null
    }
}
```

- [ ] **Step 3: Add load/save profile methods**

In the `load()` method, add after existing loading code (before `loading = false`):

```kotlin
editProfileName.setText(settings.userName ?: "")
editProfileHeight.setText(settings.userHeightCm?.let { "%.1f".format(it) } ?: "")
editProfileWeight.setText(settings.userWeightKg?.let { "%.1f".format(it) } ?: "")
toggleBmiScale.check(when (settings.bmiScale) {
    "standard" -> R.id.btnScaleStandard
    "asian" -> R.id.btnScaleAsian
    else -> R.id.btnScaleAuto
})
```

Add the `saveProfile` method:

```kotlin
private fun saveProfile() {
    val name = editProfileName.text?.toString()?.trim()
    val heightCm = editProfileHeight.text?.toString()?.trim()?.toDoubleOrNull()
    val weightKg = editProfileWeight.text?.toString()?.trim()?.toDoubleOrNull()

    settings.userName = name
    settings.userHeightCm = heightCm
    settings.userWeightKg = weightKg

    if (heightCm != null && heightCm > 0 || weightKg != null && weightKg!! > 0) {
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main).launch {
            try {
                val hcm = HealthConnectManager(this@SettingsActivity)
                val today = java.time.LocalDate.now()
                if (heightCm != null && heightCm > 0) hcm.insertHeightRecord(heightCm, today)
                if (weightKg != null && weightKg > 0) hcm.insertWeightRecord(weightKg, today)
            } catch (_: Exception) { }
        }
    }
    Toast.makeText(this, "Profile saved", Toast.LENGTH_SHORT).show()
}
```

- [ ] **Step 4: Add showManualWeightDialog method**

```kotlin
private fun showManualWeightDialog() {
    val view = layoutInflater.inflate(android.R.layout.simple_list_item_1, null)
    // Build a simple dialog with an EditText for weight and a date picker
    val input = TextInputEditText(this).apply {
        hint = "Weight (kg)"
        inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
        settings.userWeightKg?.let { setText("%.1f".format(it)) }
    }

    var selectedDate = java.time.LocalDate.now()

    val layout = android.widget.LinearLayout(this).apply {
        orientation = android.widget.LinearLayout.VERTICAL
        setPadding(64, 32, 64, 0)
        addView(input)
        addView(Button(this@SettingsActivity).apply {
            text = "Date: $selectedDate"
            setOnClickListener {
                android.app.DatePickerDialog(
                    this@SettingsActivity,
                    { _, year, month, day ->
                        selectedDate = java.time.LocalDate.of(year, month + 1, day)
                        this.text = "Date: $selectedDate"
                    },
                    selectedDate.year, selectedDate.monthValue - 1, selectedDate.dayOfMonth
                ).show()
            }
        })
    }

    MaterialAlertDialogBuilder(this)
        .setTitle("Log weight")
        .setView(layout)
        .setPositiveButton("Save") { dialog, _ ->
            val kg = input.text?.toString()?.trim()?.toDoubleOrNull()
            if (kg == null || kg <= 0) {
                Toast.makeText(this, "Enter a valid weight", Toast.LENGTH_SHORT).show()
                return@setPositiveButton
            }
            settings.userWeightKg = kg
            editProfileWeight.setText("%.1f".format(kg))
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main).launch {
                try {
                    HealthConnectManager(this@SettingsActivity).insertWeightRecord(kg, selectedDate)
                    Toast.makeText(this@SettingsActivity, "Weight logged", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Toast.makeText(this@SettingsActivity, "HC write failed: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
        .setNegativeButton("Cancel", null)
        .show()
}
```

- [ ] **Step 5: Verify build**

Run: `cd /Users/marvellooni/Project/Vitalix/android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/res/layout/activity_settings.xml \
        android/app/src/main/java/com/android/vitalix/SettingsActivity.kt
git commit -m "feat(android): add profile section to settings with BMI scale toggle and manual weight dialog"
```

---

### Task 5: Android — Send profileHeightM and bmiScale in sync payload

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/ExportWorker.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/MainActivity.kt` (manual sync path)

**Interfaces:**
- Consumes: `SyncSettings.userHeightCm`, `SyncSettings.resolvedBmiScale()`, `PayloadMeta`
- Produces: JSON payload with `profileHeightM` and `bmiScale` top-level fields

- [ ] **Step 1: Add profileHeightM and bmiScale to PayloadMeta**

In `ServerForwarder.kt`, update the `PayloadMeta` data class:

```kotlin
data class PayloadMeta(
    val appVersion: String,
    val device: String,
    val rangeDays: Int,
    val profileHeightM: Double? = null,
    val bmiScale: String? = null,
)
```

- [ ] **Step 2: Add fields to buildPayload JSON output**

In `ServerForwarder.buildPayload`, after `root.put("rangeDays", meta.rangeDays)`:

```kotlin
meta.profileHeightM?.let { root.put("profileHeightM", it) }
meta.bmiScale?.let { root.put("bmiScale", it) }
```

- [ ] **Step 3: Update ExportWorker to pass profile fields**

In `ExportWorker.doWork()`, change the `PayloadMeta` construction:

```kotlin
val meta = PayloadMeta(
    appVersion = appVersion(),
    device = Build.MODEL,
    rangeDays = cfg.daysBack,
    profileHeightM = settings.userHeightCm?.let { it / 100.0 },
    bmiScale = settings.resolvedBmiScale(),
)
```

- [ ] **Step 4: Update MainActivity manual sync to pass profile fields**

Find where `PayloadMeta` is constructed in `MainActivity.kt` for the manual "Sync now" flow and add the same `profileHeightM` and `bmiScale` fields. Search for `PayloadMeta(` in the file and update it the same way as ExportWorker.

- [ ] **Step 5: Verify build**

Run: `cd /Users/marvellooni/Project/Vitalix/android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/ServerForwarder.kt \
        android/app/src/main/java/com/android/vitalix/ExportWorker.kt \
        android/app/src/main/java/com/android/vitalix/MainActivity.kt
git commit -m "feat(android): send profileHeightM and bmiScale in sync payload"
```

---

### Task 6: Web — Database migration for user profile columns

**Files:**
- Create: `web/migrations/1722300000000_user_profile.cjs`

**Interfaces:**
- Produces: `users.profile_height_m` (double precision, nullable), `users.bmi_scale` (text, default `'standard'`)

- [ ] **Step 1: Create migration file**

```js
exports.up = (pgm) => {
  pgm.addColumn("users", {
    profile_height_m: { type: "double precision" },
    bmi_scale: { type: "text", notNull: true, default: "standard" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("users", "bmi_scale");
  pgm.dropColumn("users", "profile_height_m");
};
```

- [ ] **Step 2: Run migration**

Run: `cd /Users/marvellooni/Project/Vitalix/web && npm run migrate up`
Expected: Migration applied successfully

- [ ] **Step 3: Commit**

```bash
git add web/migrations/1722300000000_user_profile.cjs
git commit -m "feat(web): add profile_height_m and bmi_scale columns to users table"
```

---

### Task 7: Web — Extract profile fields from payload on ingest

**Files:**
- Modify: `web/src/routes/health.js`

**Interfaces:**
- Consumes: `req.body.profileHeightM`, `req.body.bmiScale`, `req.user.id`
- Produces: Updates `users.profile_height_m` and `users.bmi_scale` on each sync

- [ ] **Step 1: Update the POST /api/health handler**

In `health.js`, inside the `router.post("/api/health", ...)` handler, after the `const inserted = await persist(...)` line, add:

```js
    const profileHeightM = typeof body.profileHeightM === "number" ? body.profileHeightM : null;
    const bmiScale = body.bmiScale === "asian" ? "asian" : "standard";
    if (profileHeightM !== null || body.bmiScale) {
      const sets = [];
      const vals = [req.user.id];
      let i = 2;
      if (profileHeightM !== null) { sets.push(`profile_height_m = $${i++}`); vals.push(profileHeightM); }
      sets.push(`bmi_scale = $${i++}`); vals.push(bmiScale);
      await query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, vals);
    }
```

- [ ] **Step 2: Add query import if not present**

Verify `query` is imported from `../db.js` at the top of `health.js`. It already is — no change needed.

- [ ] **Step 3: Run tests**

Run: `cd /Users/marvellooni/Project/Vitalix/web && node --test`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/health.js
git commit -m "feat(web): extract profileHeightM and bmiScale from sync payload into users table"
```

---

### Task 8: Web — BMI computation with forward-fill SQL

**Files:**
- Modify: `web/src/stats.js`
- Create: `web/test/bmi.test.js`

**Interfaces:**
- Consumes: `health_days.weight`, `health_days.height`, `users.profile_height_m`, `users.bmi_scale`
- Produces: `stats.bmiSeries(userId, from, to): Promise<{day, weight, height, bmi}[]>`, `stats.userBmiScale(userId): Promise<string>`

- [ ] **Step 1: Write the failing test for bmiSeries shaping**

Create `web/test/bmi.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillForward, bmiFromWeightHeight, bmiCategory } from "../src/chartData.js";

test("fillForward carries last known value across gaps", () => {
  const rows = [
    { day: "2026-08-01", weight: 80 },
    { day: "2026-08-03", weight: 78 },
  ];
  const result = fillForward(rows, "2026-08-01", "2026-08-04", "weight");
  assert.deepEqual(result, [
    { date: "2026-08-01", value: 80 },
    { date: "2026-08-02", value: 80 },
    { date: "2026-08-03", value: 78 },
    { date: "2026-08-04", value: 78 },
  ]);
});

test("fillForward returns null before first data point", () => {
  const rows = [{ day: "2026-08-03", weight: 78 }];
  const result = fillForward(rows, "2026-08-01", "2026-08-03", "weight");
  assert.deepEqual(result, [
    { date: "2026-08-01", value: null },
    { date: "2026-08-02", value: null },
    { date: "2026-08-03", value: 78 },
  ]);
});

test("fillForward with all-null rows returns all null", () => {
  const rows = [];
  const result = fillForward(rows, "2026-08-01", "2026-08-03", "weight");
  assert.deepEqual(result, [
    { date: "2026-08-01", value: null },
    { date: "2026-08-02", value: null },
    { date: "2026-08-03", value: null },
  ]);
});

test("bmiFromWeightHeight computes correctly", () => {
  assert.equal(bmiFromWeightHeight(80, 1.78), 25.2);
  assert.equal(bmiFromWeightHeight(60, 1.65), 22.0);
  assert.equal(bmiFromWeightHeight(80, 0), null);
  assert.equal(bmiFromWeightHeight(null, 1.78), null);
  assert.equal(bmiFromWeightHeight(80, null), null);
});

test("bmiCategory standard WHO boundaries", () => {
  assert.equal(bmiCategory(17.0, "standard"), "Underweight");
  assert.equal(bmiCategory(18.5, "standard"), "Normal");
  assert.equal(bmiCategory(24.9, "standard"), "Normal");
  assert.equal(bmiCategory(25.0, "standard"), "Overweight");
  assert.equal(bmiCategory(29.9, "standard"), "Overweight");
  assert.equal(bmiCategory(30.0, "standard"), "Obese");
});

test("bmiCategory Asian WHO boundaries", () => {
  assert.equal(bmiCategory(17.0, "asian"), "Underweight");
  assert.equal(bmiCategory(18.5, "asian"), "Normal");
  assert.equal(bmiCategory(22.9, "asian"), "Normal");
  assert.equal(bmiCategory(23.0, "asian"), "Overweight");
  assert.equal(bmiCategory(27.4, "asian"), "Overweight");
  assert.equal(bmiCategory(27.5, "asian"), "Obese");
});

test("bmiCategory returns null for null input", () => {
  assert.equal(bmiCategory(null, "standard"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/marvellooni/Project/Vitalix/web && node --test test/bmi.test.js`
Expected: FAIL — `fillForward`, `bmiFromWeightHeight`, `bmiCategory` not exported

- [ ] **Step 3: Implement fillForward, bmiFromWeightHeight, bmiCategory in chartData.js**

Add to `web/src/chartData.js`:

```js
export function fillForward(rows, from, to, column) {
  const byDay = new Map(rows.map((r) => [toKey(r.day), r]));
  let last = null;
  return dateRange(from, to).map((date) => {
    const row = byDay.get(date);
    const value = row ? row[column] : null;
    if (value != null) last = Number(value);
    return { date, value: last };
  });
}

export function bmiFromWeightHeight(weightKg, heightM) {
  if (weightKg == null || heightM == null || heightM <= 0) return null;
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10;
}

export function bmiCategory(bmi, scale) {
  if (bmi == null) return null;
  if (scale === "asian") {
    if (bmi < 18.5) return "Underweight";
    if (bmi < 23) return "Normal";
    if (bmi < 27.5) return "Overweight";
    return "Obese";
  }
  if (bmi < 18.5) return "Underweight";
  if (bmi < 25) return "Normal";
  if (bmi < 30) return "Overweight";
  return "Obese";
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/marvellooni/Project/Vitalix/web && node --test test/bmi.test.js`
Expected: All PASS

- [ ] **Step 5: Run all tests to check for regressions**

Run: `cd /Users/marvellooni/Project/Vitalix/web && node --test`
Expected: All PASS

- [ ] **Step 6: Add bmiSeries and userBmiScale to stats.js**

Add to `web/src/stats.js`:

```js
export async function bmiSeries(userId, from, to) {
  const sql = `
    WITH date_series AS (
      SELECT generate_series($2::date, $3::date, '1 day')::date AS day
    ),
    raw AS (
      SELECT ds.day, hd.weight, hd.height
      FROM date_series ds
      LEFT JOIN health_days hd ON hd.day = ds.day AND hd.user_id = $1
    ),
    filled AS (
      SELECT
        day,
        LAST_VALUE(weight) FILTER (WHERE weight IS NOT NULL)
          OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS weight,
        COALESCE(
          LAST_VALUE(height) FILTER (WHERE height IS NOT NULL)
            OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
          (SELECT profile_height_m FROM users WHERE id = $1)
        ) AS height
      FROM raw
    )
    SELECT day, weight, height,
           CASE WHEN height > 0 THEN ROUND((weight / (height * height))::numeric, 1) END AS bmi
    FROM filled
    WHERE weight IS NOT NULL
    ORDER BY day`;
  const { rows } = await query(sql, [userId, from, to]);
  return rows;
}

export async function userBmiScale(userId) {
  const { rows } = await query("SELECT bmi_scale FROM users WHERE id = $1", [userId]);
  return rows[0]?.bmi_scale ?? "standard";
}
```

- [ ] **Step 7: Commit**

```bash
git add web/src/chartData.js web/src/stats.js web/test/bmi.test.js
git commit -m "feat(web): add BMI computation with forward-fill SQL and chartData helpers"
```

---

### Task 9: Web — BMI card on dashboard (CARD_CATALOG, route, template)

**Files:**
- Modify: `web/src/stats.js` (CARD_CATALOG entry)
- Modify: `web/src/routes/pages.js` (dashboard route — fetch BMI data, build chartData)
- Modify: `web/views/dashboard.ejs` (BMI card rendering — gauge, trend, chart)
- Modify: `web/src/chartData.js` (import `bmiFromWeightHeight`, `bmiCategory` — already added in Task 8)

**Interfaces:**
- Consumes: `stats.bmiSeries(userId, from, to)`, `stats.userBmiScale(userId)`, `chartData.fillForward`, `chartData.bmiFromWeightHeight`, `chartData.bmiCategory`

- [ ] **Step 1: Add BMI to CARD_CATALOG in stats.js**

In the `CARD_CATALOG` array, add after the `height` entry in the Body category:

```js
  { key: "bmi", label: "BMI", category: "Body", type: "bmi" },
```

- [ ] **Step 2: Fetch BMI data in dashboard route**

In `web/src/routes/pages.js`, update the `Promise.all` in the dashboard GET handler. Add `bmiFromWeightHeight`, `bmiCategory`, `fillForward` to the import from `../chartData.js`.

Add two more items to the existing `Promise.all`:

```js
stats.bmiSeries(req.user.id, fromKey, toKeyStr),
stats.userBmiScale(req.user.id),
```

And destructure them — add `bmiRows, bmiScale` to the destructuring.

- [ ] **Step 3: Build BMI chartData**

After the `chartData.recent` assignment, add:

```js
    const hasBmi = bmiRows.length > 0;
    if (hasBmi) {
      const latestBmi = Number(bmiRows[bmiRows.length - 1].bmi);
      const latestWeight = Number(bmiRows[bmiRows.length - 1].weight);
      const latestHeight = Number(bmiRows[bmiRows.length - 1].height);
      const category = bmiCategory(latestBmi, bmiScale);

      // Trend: compare latest BMI to the value at start of range
      const firstBmi = Number(bmiRows[0].bmi);
      const trendDelta = Math.round((latestBmi - firstBmi) * 10) / 10;
      const trendDir = trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "stable";

      const bmiPoints = fillForward(bmiRows, fromKey, toKeyStr, "bmi");

      chartData.bmi = {
        key: "bmi",
        label: "BMI",
        current: latestBmi,
        category,
        scale: bmiScale,
        trendDelta,
        trendDir,
        weight: latestWeight,
        height: latestHeight,
        points: bmiPoints,
        hasData: true,
      };
    }
```

- [ ] **Step 4: Update cardHasData to recognize BMI**

In the `cardHasData` function, add:

```js
      if (key === "bmi") return hasBmi;
```

- [ ] **Step 5: Add error state for BMI without height**

After the `hasBmi` block, add handling for "weight but no height":

```js
    if (!hasBmi) {
      // Check if there's weight data but no height — show a helpful message
      const hasWeight = (cover.weight ?? 0) > 0;
      const hasHeight = (cover.height ?? 0) > 0;
      const { rows: userRows } = await query("SELECT profile_height_m FROM users WHERE id = $1", [req.user.id]);
      const hasProfileHeight = userRows[0]?.profile_height_m != null;
      if (hasWeight && !hasHeight && !hasProfileHeight) {
        chartData.bmi = {
          key: "bmi", label: "BMI", hasData: false,
          message: "Set your height in the app to see BMI",
        };
      }
    }
```

Add `query` to the imports from `../db.js` if not already present.

- [ ] **Step 6: Pass bmiScale to template**

In the `res.render("dashboard", { ... })` call, add `bmiScale` to the template variables.

- [ ] **Step 7: Add BMI card rendering to dashboard.ejs**

In `dashboard.ejs`, inside the `cardList.forEach` loop, after the `hr_split` card `else if` block and before the `workouts` block, add:

```ejs
      <% } else if (card.type === 'bmi') { %>
        <% if (cd.hasData) { %>
          <div class="bmi-tile">
            <div class="bmi-value">
              <span class="bmi-number"><%= cd.current %></span>
              <span class="bmi-category" style="color: <%= cd.category === 'Normal' ? '#34D399' : cd.category === 'Underweight' ? '#60A5FA' : cd.category === 'Overweight' ? '#FBBF24' : '#F87171' %>"><%= cd.category %></span>
              <span class="bmi-trend"><%= cd.trendDir === 'up' ? '↑' : cd.trendDir === 'down' ? '↓' : '→' %> <%= Math.abs(cd.trendDelta) %></span>
            </div>
            <div class="bmi-gauge">
              <% var gaugeScale = cd.scale === 'asian'
                   ? [{max:18.5,color:'#60A5FA'},{max:23,color:'#34D399'},{max:27.5,color:'#FBBF24'},{max:40,color:'#F87171'}]
                   : [{max:18.5,color:'#60A5FA'},{max:25,color:'#34D399'},{max:30,color:'#FBBF24'},{max:40,color:'#F87171'}];
                 var gaugeMin = 15, gaugeMax = 40, gaugeRange = gaugeMax - gaugeMin;
                 var markerPos = Math.max(0, Math.min(100, ((Math.min(Math.max(cd.current, gaugeMin), gaugeMax) - gaugeMin) / gaugeRange) * 100));
              %>
              <div class="gauge-bar" style="position:relative;height:12px;border-radius:6px;overflow:hidden;display:flex">
                <% gaugeScale.forEach(function(seg, i) {
                     var prevMax = i === 0 ? gaugeMin : gaugeScale[i-1].max;
                     var width = ((seg.max - prevMax) / gaugeRange) * 100;
                %>
                  <div style="width:<%= width %>%;background:<%= seg.color %>;height:100%"></div>
                <% }); %>
              </div>
              <div class="gauge-marker" style="position:absolute;left:<%= markerPos %>%;top:-2px;width:8px;height:16px;background:#fff;border:2px solid #333;border-radius:4px;transform:translateX(-50%)"></div>
              <div class="gauge-labels" style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:4px">
                <span><%= gaugeMin %></span>
                <% gaugeScale.slice(0, -1).forEach(function(seg) { %><span><%= seg.max %></span><% }); %>
                <span><%= gaugeMax %></span>
              </div>
            </div>
            <div class="bmi-meta" style="font-size:12px;color:var(--muted);margin-top:8px">
              <%= cd.weight.toFixed(1) %> kg · <%= (cd.height * 100).toFixed(0) %> cm · <%= cd.scale === 'asian' ? 'Asian' : 'Standard' %> WHO
            </div>
          </div>
          <div class="chart" id="chart-bmi"></div>
          <div class="legend">
            <span><i style="background:#0FA9A0"></i>BMI</span>
          </div>
        <% } else if (cd.message) { %>
          <p class="empty"><%= cd.message %></p>
        <% } else { %>
          <p class="empty">No weight data</p>
        <% } %>
```

- [ ] **Step 8: Add BMI-specific CSS**

In the `<style>` block at the top of `dashboard.ejs`, add:

```css
.bmi-tile{padding:8px 0}
.bmi-value{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.bmi-number{font-size:32px;font-weight:700;letter-spacing:-0.5px}
.bmi-category{font-size:14px;font-weight:600}
.bmi-trend{font-size:13px;color:var(--muted)}
.bmi-gauge{position:relative;margin-top:12px}
```

- [ ] **Step 9: Add BMI chart rendering in the JavaScript section**

In the `<script>` block at the bottom of `dashboard.ejs`, where charts are drawn (look for the pattern that draws line charts), add after the existing chart rendering logic:

```js
// BMI chart
(function() {
  var cd = chartData.bmi;
  if (!cd || !cd.hasData || !cd.points) return;
  var el = document.getElementById('chart-bmi');
  if (!el) return;
  drawLine(el, cd.points, { color: '#0FA9A0' });
})();
```

Note: `drawLine` is the existing function in the dashboard template that renders line-type charts. Match the exact function name used in the template.

- [ ] **Step 10: Verify app runs**

Run: `cd /Users/marvellooni/Project/Vitalix/web && npm run dev`
Open the dashboard in a browser. If weight + height data exists, the BMI card should render with gauge and chart.

- [ ] **Step 11: Run all tests**

Run: `cd /Users/marvellooni/Project/Vitalix/web && node --test`
Expected: All PASS

- [ ] **Step 12: Commit**

```bash
git add web/src/stats.js web/src/routes/pages.js web/views/dashboard.ejs web/src/chartData.js
git commit -m "feat(web): add BMI card with gauge, trend, and chart to dashboard"
```

---

### Task 10: Web — Error state fallback in dashboard route

**Files:**
- Modify: `web/src/routes/pages.js` (error state for res.render 500 case)

**Interfaces:**
- Consumes: existing error handler in dashboard route

- [ ] **Step 1: Add bmiScale to error fallback**

In the `catch` block of the dashboard route (the `res.status(500).render("dashboard", { ... })` call), add `bmiScale: "standard"` to the template variables.

- [ ] **Step 2: Verify build**

Run: `cd /Users/marvellooni/Project/Vitalix/web && node --test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/pages.js
git commit -m "fix(web): add bmiScale to dashboard error fallback render"
```

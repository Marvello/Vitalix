# Vitalix Android Forwarder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `android/` project (`com.android.vitalix`, currently the Studio nav template) into the Vitalix app: read Health Connect data on-device (daily summary + raw samples for all enabled metrics) and forward it as JSON to a user-configured server via manual "Sync now" and a scheduled WorkManager job.

**Architecture:** Three isolated units — `HealthConnectManager` (HC only → `List<DailyHealthData>`), `ServerForwarder` (rows → JSON → HTTP POST), `SyncSettings` (the only `SharedPreferences` owner). `MainActivity` and `ExportWorker` orchestrate them. Pure logic (JSON build, settings↔config mapping, aggregation) is unit-tested off-device; the HC client sits behind an interface so aggregation tests use fake records.

**Tech Stack:** Kotlin, Views/XML, `androidx.health.connect:connect-client`, OkHttp, `androidx.security:security-crypto` (EncryptedSharedPreferences), WorkManager, Kotlin coroutines, JUnit + Robolectric-free pure JVM tests.

**Reference:** `android/healthexport/` is the recovered upstream — reuse its `models/HealthData.kt`, `ExportWorker.kt`, and `MainActivity.kt` UI as adaptation sources. **Do not modify the reference**; build only in `android/`.

## Global Constraints

- Build only in `android/` (root project `Vitalix`, package `com.android.vitalix`). Reference `android/healthexport/` is read-only.
- `compileSdk 36` / `minSdk 30` / Java 11 already set in `android/app/build.gradle.kts`. Keep them; add deps via the `gradle/libs.versions.toml` version catalog (this project uses `libs.*` aliases, unlike the reference).
- Unit is: `SyncSettings` is the ONLY thing that touches `SharedPreferences`. `HealthConnectManager` knows nothing of network/settings. `ServerForwarder` knows nothing of Health Connect.
- Metric string keys in JSON must exactly match the receiver's `KNOWN_SAMPLE_METRICS` and aggregate keys (see receiver spec / `mapPayload.js`): aggregates `heartRate, hrv, spo2, bloodGlucose, respiratoryRate, bpSystolic, bpDiastolic`; samples per the Raw samples table in the design doc.
- Payload schema is authoritative in `docs/superpowers/specs/2026-07-21-vitalix-health-forwarder-design.md`.
- All timestamps UTC ISO-8601.
- Verify end-to-end against the `web/` receiver (build that first, or run its docker-compose).

---

### Task 1: Dependencies + manifest permissions + drop template

**Files:**
- Modify: `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Delete: `android/app/src/main/java/com/android/vitalix/FirstFragment.kt`, `SecondFragment.kt`, and the nav/fragment layouts + `nav_graph.xml` (template leftovers)

**Interfaces:**
- Produces: HC/OkHttp/security-crypto/WorkManager on the classpath; HC read permissions + the HC permission-rationale intent declared in the manifest.

- [ ] **Step 1: Add version-catalog entries** to `android/gradle/libs.versions.toml`

Under `[versions]` add:
```toml
healthConnect = "1.1.0-alpha07"
okhttp = "4.12.0"
securityCrypto = "1.1.0-alpha06"
workManager = "2.9.1"
coroutines = "1.8.1"
```
Under `[libraries]` add:
```toml
health-connect-client = { group = "androidx.health.connect", name = "connect-client", version.ref = "healthConnect" }
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }
security-crypto = { group = "androidx.security", name = "security-crypto", version.ref = "securityCrypto" }
work-runtime-ktx = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "workManager" }
coroutines-android = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-android", version.ref = "coroutines" }
kotlin-test = { group = "org.jetbrains.kotlin", name = "kotlin-test-junit", version = "1.9.24" }
```

- [ ] **Step 2: Wire deps** in `android/app/build.gradle.kts` — add to `dependencies { }`:
```kotlin
implementation(libs.health.connect.client)
implementation(libs.okhttp)
implementation(libs.security.crypto)
implementation(libs.work.runtime.ktx)
implementation(libs.coroutines.android)
testImplementation(libs.kotlin.test)
```
Remove the `navigation.fragment.ktx` / `navigation.ui.ktx` implementation lines (template-only).

- [ ] **Step 3: Declare HC permissions + queries** in `AndroidManifest.xml`

Add above `<application>` a `<uses-permission>` for each read type the app supports, e.g.:
```xml
<uses-permission android:name="android.permission.health.READ_STEPS"/>
<uses-permission android:name="android.permission.health.READ_HEART_RATE"/>
<uses-permission android:name="android.permission.health.READ_DISTANCE"/>
<uses-permission android:name="android.permission.health.READ_ACTIVE_CALORIES_BURNED"/>
<uses-permission android:name="android.permission.health.READ_TOTAL_CALORIES_BURNED"/>
<uses-permission android:name="android.permission.health.READ_FLOORS_CLIMBED"/>
<uses-permission android:name="android.permission.health.READ_ELEVATION_GAINED"/>
<uses-permission android:name="android.permission.health.READ_POWER"/>
<uses-permission android:name="android.permission.health.READ_SPEED"/>
<uses-permission android:name="android.permission.health.READ_WHEELCHAIR_PUSHES"/>
<uses-permission android:name="android.permission.health.READ_VO2_MAX"/>
<uses-permission android:name="android.permission.health.READ_WEIGHT"/>
<uses-permission android:name="android.permission.health.READ_BODY_FAT"/>
<uses-permission android:name="android.permission.health.READ_BONE_MASS"/>
<uses-permission android:name="android.permission.health.READ_HEIGHT"/>
<uses-permission android:name="android.permission.health.READ_LEAN_BODY_MASS"/>
<uses-permission android:name="android.permission.health.READ_RESTING_HEART_RATE"/>
<uses-permission android:name="android.permission.health.READ_HEART_RATE_VARIABILITY"/>
<uses-permission android:name="android.permission.health.READ_OXYGEN_SATURATION"/>
<uses-permission android:name="android.permission.health.READ_RESPIRATORY_RATE"/>
<uses-permission android:name="android.permission.health.READ_BLOOD_GLUCOSE"/>
<uses-permission android:name="android.permission.health.READ_BLOOD_PRESSURE"/>
<uses-permission android:name="android.permission.health.READ_BODY_TEMPERATURE"/>
<uses-permission android:name="android.permission.health.READ_SLEEP"/>
<uses-permission android:name="android.permission.health.READ_EXERCISE"/>
<uses-permission android:name="android.permission.health.READ_HYDRATION"/>
<uses-permission android:name="android.permission.health.READ_NUTRITION"/>
<uses-permission android:name="android.permission.health.READ_MENSTRUATION"/>
<uses-permission android:name="android.permission.health.READ_CERVICAL_MUCUS"/>
<uses-permission android:name="android.permission.health.READ_OVULATION_TEST"/>
<uses-permission android:name="android.permission.health.READ_INTERMENSTRUAL_BLEEDING"/>
<uses-permission android:name="android.permission.health.READ_SEXUAL_ACTIVITY"/>
<uses-permission android:name="android.permission.INTERNET"/>
```
Add inside `<application>` an intent-filter on `MainActivity` (or a dedicated permissions rationale activity) for HC's rationale intent:
```xml
<intent-filter>
  <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" />
</intent-filter>
```
And a top-level `<queries>` for the HC package:
```xml
<queries>
  <package android:name="com.google.android.apps.healthdata" />
</queries>
```

- [ ] **Step 4: Delete template fragments/nav** and their layouts:
```bash
cd android/app/src/main
rm java/com/android/vitalix/FirstFragment.kt java/com/android/vitalix/SecondFragment.kt
rm res/layout/fragment_first.xml res/layout/fragment_second.xml res/layout/content_main.xml
rm res/navigation/nav_graph.xml
```
(MainActivity is rewritten in Task 6; leave a minimal stub if the build breaks before then.)

- [ ] **Step 5: Sync + build**

Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL (MainActivity may still reference removed fragments — if so, temporarily gut its body to an empty `setContentView` until Task 6).

- [ ] **Step 6: Commit**

```bash
git add android/gradle/libs.versions.toml android/app/build.gradle.kts android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/android/vitalix android/app/src/main/res
git commit -m "chore(android): HC/OkHttp/security deps, HC permissions, drop template"
```

---

### Task 2: Data models (reuse + extend with HealthSample)

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`

**Interfaces:**
- Produces: `DailyHealthData` (with `samples: List<HealthSample>`), `ExerciseData`, `ExportConfig`, `MinMaxAvg`, `HealthSample(metric, start, end?, value?, value2?, text?)`.

- [ ] **Step 1: Copy the reference models, repackage, add HealthSample**

Copy `android/healthexport/app/src/main/java/com/healthexport/models/HealthData.kt` into the new path, change `package com.healthexport.models` → `package com.android.vitalix.models`, and add:
```kotlin
data class HealthSample(
    val metric: String,
    val start: String,          // UTC ISO-8601
    val end: String? = null,
    val value: Double? = null,
    val value2: Double? = null, // diastolic for bloodPressure
    val text: String? = null    // sleep stage / cycle category
)
```
Add a `samples` field to `DailyHealthData`:
```kotlin
data class DailyHealthData(
    val date: String,
    val activityData: Map<String, Any?> = emptyMap(),
    val bodyMeasurementData: Map<String, Any?> = emptyMap(),
    val cycleTrackingData: Map<String, Any?> = emptyMap(),
    val nutritionData: Map<String, Any?> = emptyMap(),
    val sleepData: Map<String, Any?> = emptyMap(),
    val vitalsData: Map<String, Any?> = emptyMap(),
    val exercises: List<ExerciseData> = emptyList(),
    val samples: List<HealthSample> = emptyList()
)
```
Keep `ExportConfig`, `MinMaxAvg`, `BodyMeasurementData` as in the reference. Add `val saferExportMode: Boolean = false` and `val autoSync: Boolean = false` to `ExportConfig` if not present.

- [ ] **Step 2: Compile**

Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/models/HealthData.kt
git commit -m "feat(android): health data models + HealthSample"
```

---

### Task 3: SyncSettings (EncryptedSharedPreferences) — TDD

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/SyncSettings.kt`
- Test: `android/app/src/test/java/com/android/vitalix/SyncSettingsMappingTest.kt`

**Interfaces:**
- Produces:
  - `SyncSettings(context)` — instance backed by EncryptedSharedPreferences (URL+token) + plain prefs (flags/schedule/lastSync).
  - `var serverUrl: String?`, `var authToken: String?`, `var lastSync: Long`, `var autoSyncEnabled: Boolean`, `var syncIntervalHours: Int`
  - `fun readConfig(): ExportConfig` / `fun writeConfig(cfg: ExportConfig)`
  - Companion pure mappers `configToMap(cfg): Map<String,Boolean/Int>` and `mapToConfig(map): ExportConfig` (unit-testable without Android).
- Consumed by: `MainActivity`, `ExportWorker`.

- [ ] **Step 1: Write the failing test** — `SyncSettingsMappingTest.kt` (tests the PURE companion mappers, no Android context)

```kotlin
package com.android.vitalix

import com.android.vitalix.models.ExportConfig
import kotlin.test.Test
import kotlin.test.assertEquals

class SyncSettingsMappingTest {
    @Test fun roundTripsConfigFlags() {
        val cfg = ExportConfig(includeSteps = true, includeHeartRate = true, includeWeight = true, daysBack = 14, saferExportMode = true)
        val restored = SyncSettings.mapToConfig(SyncSettings.configToMap(cfg))
        assertEquals(cfg, restored)
    }

    @Test fun defaultsWhenKeysMissing() {
        val cfg = SyncSettings.mapToConfig(emptyMap())
        assertEquals(false, cfg.includeSteps)
        assertEquals(7, cfg.daysBack)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.SyncSettingsMappingTest"`
Expected: FAIL — unresolved `SyncSettings`.

- [ ] **Step 3: Implement `SyncSettings.kt`**

```kotlin
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
    var authToken: String?
        get() = secure.getString("auth_token", null)
        set(v) { secure.edit().putString("auth_token", v).apply() }
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
                is Boolean -> map[p.name] = plain.getBoolean(p.name, false)
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
                is Boolean -> m[p.name] = v; is Int -> m[p.name] = v; else -> {}
            }
            return m
        }
        fun mapToConfig(map: Map<String, Any>): ExportConfig {
            val ctor = ExportConfig::class.constructors.first()
            val args = ctor.parameters.associateWith { param ->
                val given = map[param.name]
                given ?: ctor.callBy(emptyMap()).let { def ->
                    ExportConfig::class.memberProperties.first { it.name == param.name }.get(def)
                }
            }
            return ctor.callBy(args)
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.SyncSettingsMappingTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/SyncSettings.kt android/app/src/test/java/com/android/vitalix/SyncSettingsMappingTest.kt
git commit -m "feat(android): SyncSettings with encrypted server creds + config mapping"
```

---

### Task 4: ServerForwarder (JSON build + POST) — TDD

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`
- Test: `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`

**Interfaces:**
- Consumes: `DailyHealthData`, `HealthSample`, `ExerciseData`.
- Produces:
  - `ServerForwarder.buildPayload(days: List<DailyHealthData>, meta: PayloadMeta): String` (pure, returns JSON string)
  - `data class PayloadMeta(appVersion, device, rangeDays)`
  - `suspend fun forward(url: String, token: String?, json: String): Result<Int>` (HTTP status in success)
- Consumed by: `ExportWorker`, `MainActivity`.

- [ ] **Step 1: Write the failing test** — `ServerForwarderTest.kt`

```kotlin
package com.android.vitalix

import com.android.vitalix.models.*
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ServerForwarderTest {
    private fun sampleDay() = DailyHealthData(
        date = "2026-07-20",
        activityData = mapOf("steps" to 8123),
        vitalsData = mapOf("heartRate" to MinMaxAvg(52.0, 146.0, 68.0)),
        exercises = listOf(ExerciseData("2026-07-20", "2026-07-20T06:12:00Z", "Running", 32)),
        samples = listOf(HealthSample("heartRate", "2026-07-20T10:04:12Z", value = 68.0))
    )

    @Test fun buildsSchemaWithEnabledMetricsAndSamples() {
        val json = JSONObject(ServerForwarder.buildPayload(listOf(sampleDay()), PayloadMeta("1.0.0", "Pixel 8", 7)))
        assertEquals("vitalix", json.getString("source"))
        val day = json.getJSONArray("days").getJSONObject(0)
        assertEquals(8123, day.getJSONObject("activity").getInt("steps"))
        val hr = day.getJSONObject("vitals").getJSONObject("heartRate")
        assertEquals(68, hr.getInt("avg"))
        val sample = day.getJSONArray("samples").getJSONObject(0)
        assertEquals("heartRate", sample.getString("metric"))
        assertEquals(1, day.getJSONArray("exercises").length())
    }

    @Test fun omitsDisabledMetricSections() {
        val day = DailyHealthData(date = "2026-07-20", activityData = mapOf("steps" to 10))
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val d0 = json.getJSONArray("days").getJSONObject(0)
        assertTrue(d0.has("activity"))
        assertFalse(d0.has("body"))   // empty section omitted, not null
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: FAIL — unresolved `ServerForwarder`.

- [ ] **Step 3: Implement `ServerForwarder.kt`**

```kotlin
package com.android.vitalix

import com.android.vitalix.models.DailyHealthData
import com.android.vitalix.models.HealthSample
import com.android.vitalix.models.MinMaxAvg
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class PayloadMeta(val appVersion: String, val device: String, val rangeDays: Int)

object ServerForwarder {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun section(map: Map<String, Any?>): JSONObject? {
        if (map.isEmpty()) return null
        val o = JSONObject()
        for ((k, v) in map) if (v != null) when (v) {
            is MinMaxAvg -> o.put(k, JSONObject().apply {
                v.min?.let { put("min", it) }; v.max?.let { put("max", it) }; v.avg?.let { put("avg", it) }
            })
            else -> o.put(k, v)
        }
        return if (o.length() == 0) null else o
    }

    private fun sampleJson(s: HealthSample) = JSONObject().apply {
        put("metric", s.metric); put("start", s.start)
        s.end?.let { put("end", it) }; s.value?.let { put("value", it) }
        s.value2?.let { put("value2", it) }; s.text?.let { put("text", it) }
    }

    fun buildPayload(days: List<DailyHealthData>, meta: PayloadMeta): String {
        val root = JSONObject()
        root.put("source", "vitalix")
        root.put("appVersion", meta.appVersion)
        root.put("device", meta.device)
        root.put("exportedAt", java.time.Instant.now().toString())
        root.put("rangeDays", meta.rangeDays)
        val arr = JSONArray()
        for (d in days) {
            val o = JSONObject().put("date", d.date)
            section(d.activityData)?.let { o.put("activity", it) }
            section(d.bodyMeasurementData)?.let { o.put("body", it) }
            section(d.vitalsData)?.let { o.put("vitals", it) }
            section(d.sleepData)?.let { o.put("sleep", it) }
            section(d.cycleTrackingData)?.let { o.put("cycle", it) }
            section(d.nutritionData)?.let { o.put("nutrition", it) }
            if (d.exercises.isNotEmpty()) o.put("exercises", JSONArray(d.exercises.map {
                JSONObject().put("name", it.exerciseName).put("start", it.startDateTime).put("durationMinutes", it.durationMinutes)
            }))
            if (d.samples.isNotEmpty()) o.put("samples", JSONArray(d.samples.map { sampleJson(it) }))
            arr.put(o)
        }
        root.put("days", arr)
        return root.toString()
    }

    fun forward(url: String, token: String?, json: String): Result<Int> = try {
        val builder = Request.Builder().url(url).post(json.toRequestBody(JSON))
        if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
        client.newCall(builder.build()).execute().use { resp ->
            if (resp.isSuccessful) Result.success(resp.code)
            else Result.failure(HttpException(resp.code))
        }
    } catch (e: Exception) { Result.failure(e) }

    class HttpException(val code: Int) : Exception("HTTP $code")
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/ServerForwarder.kt android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt
git commit -m "feat(android): ServerForwarder JSON builder + POST"
```

---

### Task 5: HealthConnectManager (read + aggregate + samples) — TDD on aggregation

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Create: `android/app/src/main/java/com/android/vitalix/health/RecordReader.kt` (interface abstracting the HC client)
- Create: `android/app/src/main/java/com/android/vitalix/health/Aggregation.kt` (pure helpers)
- Test: `android/app/src/test/java/com/android/vitalix/AggregationTest.kt`

**Interfaces:**
- Produces:
  - `Aggregation.minMaxAvg(values: List<Double>): MinMaxAvg` (pure)
  - `Aggregation.bucketByDay(instant: Instant, zone: ZoneId): LocalDate` (pure)
  - `HealthConnectManager(context)` with `suspend fun readHealthDataByDay(cfg: ExportConfig): List<DailyHealthData>` and `val permissions: Set<String>`
- Consumed by: `MainActivity`, `ExportWorker`.

- [ ] **Step 1: Write the failing pure test** — `AggregationTest.kt`

```kotlin
package com.android.vitalix

import com.android.vitalix.health.Aggregation
import kotlin.test.Test
import kotlin.test.assertEquals

class AggregationTest {
    @Test fun computesMinMaxAvg() {
        val r = Aggregation.minMaxAvg(listOf(52.0, 68.0, 146.0))
        assertEquals(52.0, r.min); assertEquals(146.0, r.max)
        assertEquals(88.6667, r.avg!!, 0.001)
    }
    @Test fun emptyIsAllNull() {
        val r = Aggregation.minMaxAvg(emptyList())
        assertEquals(null, r.min); assertEquals(null, r.avg)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.AggregationTest"`
Expected: FAIL — unresolved `Aggregation`.

- [ ] **Step 3: Implement `health/Aggregation.kt`**

```kotlin
package com.android.vitalix.health

import com.android.vitalix.models.MinMaxAvg
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

object Aggregation {
    fun minMaxAvg(values: List<Double>): MinMaxAvg =
        if (values.isEmpty()) MinMaxAvg()
        else MinMaxAvg(values.min(), values.max(), values.average())

    fun bucketByDay(instant: Instant, zone: ZoneId): LocalDate =
        instant.atZone(zone).toLocalDate()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.AggregationTest"`
Expected: PASS.

- [ ] **Step 5: Implement `health/RecordReader.kt` + `HealthConnectManager.kt`**

`RecordReader` wraps `HealthConnectClient.readRecords` so aggregation is testable with fakes:
```kotlin
package com.android.vitalix.health

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import kotlin.reflect.KClass

interface RecordReader {
    suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T>
}

class HealthConnectRecordReader(private val client: HealthConnectClient) : RecordReader {
    override suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T> =
        client.readRecords(ReadRecordsRequest(type, TimeRangeFilter.between(start, end))).records
}
```

`HealthConnectManager.kt` — declares permissions for every supported record type, reads per the `ExportConfig` window (chunked when `saferExportMode`), buckets records by day, and for each enabled metric fills the daily summary maps AND appends `HealthSample`s. Implement per record type using the design doc's metric table. Key structure:
```kotlin
package com.android.vitalix

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import com.android.vitalix.health.Aggregation
import com.android.vitalix.health.HealthConnectRecordReader
import com.android.vitalix.health.RecordReader
import com.android.vitalix.models.*
import java.time.*
import java.time.temporal.ChronoUnit

class HealthConnectManager(
    private val context: Context,
    private val reader: RecordReader =
        HealthConnectRecordReader(HealthConnectClient.getOrCreate(context))
) {
    val permissions: Set<String> = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(FloorsClimbedRecord::class),
        HealthPermission.getReadPermission(ElevationGainedRecord::class),
        HealthPermission.getReadPermission(PowerRecord::class),
        HealthPermission.getReadPermission(SpeedRecord::class),
        HealthPermission.getReadPermission(Vo2MaxRecord::class),
        HealthPermission.getReadPermission(WeightRecord::class),
        HealthPermission.getReadPermission(BodyFatRecord::class),
        HealthPermission.getReadPermission(BoneMassRecord::class),
        HealthPermission.getReadPermission(HeightRecord::class),
        HealthPermission.getReadPermission(LeanBodyMassRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HealthPermission.getReadPermission(OxygenSaturationRecord::class),
        HealthPermission.getReadPermission(RespiratoryRateRecord::class),
        HealthPermission.getReadPermission(BloodGlucoseRecord::class),
        HealthPermission.getReadPermission(BloodPressureRecord::class),
        HealthPermission.getReadPermission(BodyTemperatureRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(HydrationRecord::class),
        HealthPermission.getReadPermission(NutritionRecord::class),
        HealthPermission.getReadPermission(MenstruationFlowRecord::class),
        HealthPermission.getReadPermission(CervicalMucusRecord::class),
        HealthPermission.getReadPermission(OvulationTestRecord::class),
        HealthPermission.getReadPermission(SexualActivityRecord::class),
    )

    private val zone: ZoneId = ZoneId.systemDefault()

    suspend fun readHealthDataByDay(cfg: ExportConfig): List<DailyHealthData> {
        val end = Instant.now()
        val start = end.minus(cfg.daysBack.toLong(), ChronoUnit.DAYS)
        // Accumulators keyed by LocalDate
        val builders = HashMap<LocalDate, DayBuilder>()
        fun builder(d: LocalDate) = builders.getOrPut(d) { DayBuilder(d) }

        // Example: heart rate (instantaneous samples + daily aggregate)
        if (cfg.includeHeartRate) {
            reader.read(HeartRateRecord::class, start, end).forEach { rec ->
                rec.samples.forEach { s ->
                    val day = Aggregation.bucketByDay(s.time, zone)
                    val b = builder(day)
                    b.heartRates += s.beatsPerMinute.toDouble()
                    b.samples += HealthSample("heartRate", s.time.toString(), value = s.beatsPerMinute.toDouble())
                }
            }
        }
        // ...repeat per enabled metric following the design doc's Raw samples table:
        //   instantaneous -> add to aggregate list + HealthSample(start,value)
        //   interval       -> sum into daily total + HealthSample(start,end,value)
        //   bloodPressure  -> bpSystolic/bpDiastolic aggregates + HealthSample(start,value,value2)
        //   sleepStage     -> per-stage minutes + HealthSample(start,end,text=stage)
        //   exercise       -> ExerciseData entries
        //   cycle          -> text scalar + HealthSample(start,text)
        // saferExportMode: split [start,end] into <=7-day windows with a 2s delay between reads.

        return builders.values.sortedBy { it.date }.map { it.build() }
    }
}
```
Add a private `DayBuilder` inner class holding per-metric accumulators (lists for aggregates, running totals for intervals, sample list) with a `build(): DailyHealthData` that calls `Aggregation.minMaxAvg` and assembles the summary maps + `samples`. Implement every enabled metric branch; on a per-metric read exception, log and continue (per the design's error matrix).

- [ ] **Step 6: Compile + rerun unit tests**

Run: `cd android && ./gradlew :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, aggregation + earlier tests pass.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt android/app/src/main/java/com/android/vitalix/health android/app/src/test/java/com/android/vitalix/AggregationTest.kt
git commit -m "feat(android): HealthConnectManager read+aggregate+samples with pure aggregation tests"
```

---

### Task 6: MainActivity UI (adapt reference) + branding

**Files:**
- Rewrite: `android/app/src/main/java/com/android/vitalix/MainActivity.kt`
- Rewrite: `android/app/src/main/res/layout/activity_main.xml`
- Modify: `android/app/src/main/res/values/strings.xml` (app_name = "Vitalix"), `colors.xml`/`themes.xml` (Vital Teal `#0FA9A0`, Pulse Green `#34D399`)
- Create: launcher icon from `docs/branding/vitalix-icon.svg` (vector drawable + adaptive-icon mipmaps)

**Interfaces:**
- Consumes: `SyncSettings`, `HealthConnectManager`, `ServerForwarder`, `PayloadMeta`.
- Produces: the configuration + sync UI; registers the HC permission contract.

- [ ] **Step 1: Build `activity_main.xml`** — a scrollable form: server URL field, auth token field (password), the metric checkboxes grouped by category (Activity/Body/Vitals/Sleep/Cycle/Nutrition — copy the checkbox set from the reference `activity_main.xml`), date-range (daysBack) selector, "Safer export mode" switch, "Auto-sync" switch + interval selector, and a primary **"Sync now"** button styled Vital Teal. Reuse the reference layout's checkbox structure; drop all Google-account/spreadsheet/CSV controls.

- [ ] **Step 2: Rewrite `MainActivity.kt`** using the reference as a guide but wiring the new units:
  - Register `registerForActivityResult(PermissionController.createRequestPermissionResultContract())` with `healthConnectManager.permissions`.
  - Load state from `SyncSettings` into the form; persist on change.
  - "Sync now": validate `serverUrl` non-empty (else prompt); read `SyncSettings.readConfig()`; `lifecycleScope.launch { withContext(Dispatchers.IO) { val days = hcm.readHealthDataByDay(cfg); val json = ServerForwarder.buildPayload(days, meta); ServerForwarder.forward(url, token, json) } }`; reflect state Idle/Exporting/Sent/Failed per branding voice; on success set `SyncSettings.lastSync`.
  - Auto-sync switch: schedule/cancel the periodic worker (Task 7).
  - Build `PayloadMeta(BuildConfig-derived version, android.os.Build.MODEL, cfg.daysBack)`.

- [ ] **Step 3: Branding** — set `app_name` to `Vitalix`; add colors `vital_teal`/`pulse_green` and apply to the Material theme's primary/secondary; convert `docs/branding/vitalix-icon.svg` to a vector drawable and regenerate `ic_launcher` adaptive icons.

- [ ] **Step 4: Build the app**

Run: `cd android && ./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL, `app-debug.apk` produced.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main
git commit -m "feat(android): Vitalix sync UI, HC permission flow, branding"
```

---

### Task 7: ExportWorker (scheduled auto-forward)

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/ExportWorker.kt`

**Interfaces:**
- Consumes: `SyncSettings`, `HealthConnectManager`, `ServerForwarder`.
- Produces: `ExportWorker` (CoroutineWorker) + `companion` `schedule(context, hours)` / `cancel(context)` using WorkManager.

- [ ] **Step 1: Implement `ExportWorker.kt`** (adapt reference worker; swap SheetsManager → ServerForwarder)

```kotlin
package com.android.vitalix

import android.content.Context
import android.os.Build
import androidx.work.*
import com.android.vitalix.models.ExportConfig
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

class ExportWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val settings = SyncSettings(applicationContext)
        val url = settings.serverUrl
        if (url.isNullOrBlank()) return Result.failure()
        return try {
            val cfg = settings.readConfig().copy(daysBack = daysSinceLastSync(settings))
            val days = HealthConnectManager(applicationContext).readHealthDataByDay(cfg)
            val meta = PayloadMeta("1.0.0", Build.MODEL, cfg.daysBack)
            val json = ServerForwarder.buildPayload(days, meta)
            ServerForwarder.forward(url, settings.authToken, json).fold(
                onSuccess = { settings.lastSync = System.currentTimeMillis(); Result.success() },
                onFailure = { e ->
                    if (e is ServerForwarder.HttpException && e.code in 400..499) Result.failure()
                    else Result.retry()
                }
            )
        } catch (e: Exception) { Result.retry() }
    }

    private fun daysSinceLastSync(s: SyncSettings): Int {
        if (s.lastSync == 0L) return 1
        val days = ChronoUnit.DAYS.between(Instant.ofEpochMilli(s.lastSync), Instant.now())
        return (days.toInt().coerceAtLeast(1))
    }

    companion object {
        private const val NAME = "vitalix_auto_export"
        fun schedule(context: Context, hours: Int) {
            val req = PeriodicWorkRequestBuilder<ExportWorker>(hours.toLong(), TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
        fun cancel(context: Context) = WorkManager.getInstance(context).cancelUniqueWork(NAME)
    }
}
```

- [ ] **Step 2: Wire schedule/cancel** into MainActivity's auto-sync switch (call `ExportWorker.schedule(this, settings.syncIntervalHours)` / `ExportWorker.cancel(this)`).

- [ ] **Step 3: Build**

Run: `cd android && ./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/ExportWorker.kt android/app/src/main/java/com/android/vitalix/MainActivity.kt
git commit -m "feat(android): scheduled ExportWorker auto-forward"
```

---

### Task 8: End-to-end on device against the receiver

**Files:** none (manual verification)

- [ ] **Step 1: Start the receiver** — `cd web && docker compose up -d` (from the receiver plan). Note the machine's LAN IP.
- [ ] **Step 2: Install the app** — `cd android && ./gradlew :app:installDebug` onto a device/emulator that has Health Connect with some data.
- [ ] **Step 3: Grant HC permissions** via the app's permission flow.
- [ ] **Step 4: Configure** server URL `http://<LAN-IP>:3000/api/health` + token `change-me-optional`, enable a few metrics, tap **Sync now**. Expect "Sent".
- [ ] **Step 5: Verify** — `curl -s "http://localhost:3000/api/days" -H 'Authorization: Bearer change-me-optional'` shows the day; `GET /api/days/<date>` shows aggregates + samples.
- [ ] **Step 6: Toggle Auto-sync**, confirm a `vitalix_auto_export` work item is enqueued (`adb shell dumpsys jobscheduler | grep vitalix` or WorkManager inspector).
- [ ] **Step 7: Full unit suite** — `cd android && ./gradlew :app:testDebugUnitTest`. Expected: all pass.

---

## Self-Review notes

- **Spec coverage:** deps/permissions (T1), models+HealthSample (T2), SyncSettings encrypted+mapping (T3), ServerForwarder JSON+POST+samples (T4), HealthConnectManager read/aggregate/samples with pure-testable aggregation behind `RecordReader` (T5), MainActivity UI+branding+HC permission flow (T6), scheduled ExportWorker with 4xx=failure/5xx=retry (T7), e2e against receiver (T8). Dropped Sheets/CSV/reminder classes never created. ✅
- **Type consistency:** `DailyHealthData.samples`/`exercises` (T2) consumed by `ServerForwarder.buildPayload` (T4) and produced by `HealthConnectManager` (T5); `PayloadMeta` defined in T4 used in T6/T7; `SyncSettings.readConfig()/serverUrl/authToken/lastSync` (T3) used in T6/T7; metric JSON keys match receiver's `KNOWN_SAMPLE_METRICS`. ✅
- **Known adaptation points (not placeholders):** T5's per-metric branches and T6's checkbox layout are explicitly "follow the design doc's Raw samples table / copy the reference checkbox set" — the pattern and one worked example (heartRate) are given; remaining metrics are mechanical repetition of that pattern per the enumerated record types.
- **Caveat:** exact Health Connect record class/field names (e.g. `HeartRateVariabilityRmssdRecord`, `MenstruationFlowRecord`) should be confirmed against the resolved `connect-client` version during T5; adjust imports if the alpha API differs.

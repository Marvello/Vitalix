# Close Health Connect Data-Coverage Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the 10 missing Health Connect record types (all except PlannedExercise), full exercise detail (laps/segments/GPS route), all ~40 nutrition fields, and CervicalMucus `sensation` — so the server holds the user's complete on-device health history at native granularity.

**Architecture:** Everything except nested exercise detail rides the existing *generic* sample/records pipeline — a new metric needs only a permission, an `ExportConfig` flag, a `perMetric{}` block, a UI checkbox, and one aggregation-catalog entry; no DB migration. Nutrition fans out to one metric per nutrient (`nutrition.<field>`). Exercise laps/segments/route are nested, so they attach to `ExerciseData` and persist to a single new `exercises.detail jsonb` column — the plan's only migration.

**Tech Stack:** Kotlin / androidx.health.connect (Android app in `android/`), Node ESM + Express + Postgres + node-pg-migrate + node:test (receiver in `web/`).

## Global Constraints

- **Android project is `android/`** (root project `Vitalix`, package `com.android.vitalix`). Gradle 9.5, **`compileSdk 37`** / `minSdk 30` / Java 11, deps via `gradle/libs.versions.toml` `libs.*` aliases. Never touch `android/healthexport/` (reference only). (compileSdk was 36; Task 1 bumps it to 37 because `ActivityIntensityRecord` only ships in connect-client 1.2.0-alpha, which requires 37.)
- **connect-client must be bumped** from `1.1.0-alpha07` to a **1.2.0-alpha** version containing ActivityIntensity/SkinTemperature/BodyWaterMass/Mindfulness (Task 1). 1.1.0 stable has the other 9 types but NOT ActivityIntensity.
- **Component boundaries stay strict:** `HealthConnectManager` knows only HC (in `ExportConfig`, out `List<DailyHealthData>`); `MetaMappers` is pure enum→map; `ServerForwarder` knows only JSON+HTTP; `SyncSettings` is the only thing touching `SharedPreferences`.
- **Payload rule:** only user-enabled metrics appear; omitted not null; aggregates use `MinMaxAvg`.
- **Web runs from `web/`.** Tests: `npm test`. Migrations: `.cjs` in `web/migrations/`, run `npm run migrate`. Unit-testable logic stays free of the pg client.
- **Additive & non-breaking:** existing metrics, payloads, rollups, and the `records` idempotency key `UNIQUE(user_id, hc_id, start_at)` are untouched.
- **New metric keys** (exact strings — the cross-component contract): `activityIntensity`, `cyclingCadence`, `stepsCadence`, `basalMetabolicRate`, `bodyWaterMass`, `skinTemperature`, `basalBodyTemperature`, `intermenstrualBleeding`, `menstruationPeriod`, `mindfulness`, and `nutrition.<field>` per nutrient.
- **New `ExportConfig` flags:** `includeActivityIntensity`, `includeCyclingCadence`, `includeStepsCadence`, `includeBasalMetabolicRate`, `includeBodyWaterMass`, `includeSkinTemperature`, `includeBasalBodyTemperature`, `includeIntermenstrualBleeding`, `includeMenstruationPeriod`, `includeMindfulness`, `includeNutritionDetail`, `includeExerciseRoute`.

---

## File Structure

**Android (`android/app/src/main/java/com/android/vitalix/`)**
- `models/HealthData.kt` — add `ExerciseLap`, `ExerciseSegment`, `RoutePoint` data classes; add `laps`/`segments`/`route` to `ExerciseData`; add 12 flags to `ExportConfig`.
- `health/MetaMappers.kt` — new pure mappers (activityIntensity, mindfulness, skinTemperature, basalBodyTemperature, cervicalMucus sensation).
- `HealthConnectManager.kt` — new permissions, `perMetric{}` blocks, nutrient extractor table, exercise detail extraction.
- `ServerForwarder.kt` — serialize exercise laps/segments/route.
- `MainActivity.kt` + `res/layout/activity_main.xml` (verify exact name) — checkboxes + wiring for new flags; route consent.
- `AndroidManifest.xml` — exercise-route read permission.

**Android tests (`android/app/src/test/java/com/android/vitalix/`)**
- `health/FakeRecordReader.kt` (new test helper), `health/HealthConnectManagerTest.kt` (new), extend `health/MetaMappersTest.kt`, `ServerForwarderTest.kt`, `SyncSettingsMappingTest.kt`.

**Web (`web/`)**
- `src/records.js` — aggregation-catalog additions + `nutrition.*` prefix rule.
- `src/mapPayload.js` — `KNOWN_SAMPLE_METRICS` additions, `nutrition.*` passthrough, exercise `detail` mapping.
- `src/persist.js` — write `exercises.detail`.
- `migrations/1722100000000_exercise_detail.cjs` (new).
- `views/day.ejs` — lap/segment/route display.
- Tests: `test/records.test.js`, `test/mapPayload.test.js`.

**Docs**
- `docs/health-connect-data-coverage.md` — flip captured rows, drop closed field-gaps.

---

## Task 1: Bump connect-client + compileSdk

**Files:**
- Modify: `android/gradle/libs.versions.toml:13` (and the `compileSdk` alias if it lives there)
- Modify: `android/app/build.gradle.kts` (`compileSdk = 37`, and `targetSdk` if set to 36)

**Interfaces:**
- Produces: a connect-client version exposing `ActivityIntensityRecord`, `CyclingPedalingCadenceRecord`, `StepsCadenceRecord`, `BasalMetabolicRateRecord`, `BodyWaterMassRecord`, `SkinTemperatureRecord`, `BasalBodyTemperatureRecord`, `IntermenstrualBleedingRecord`, `MenstruationPeriodRecord`, `MindfulnessSessionRecord`, and exercise route/laps/segments accessors; compileSdk 37.

- [ ] **Step 1: Bump compileSdk to 37 and connect-client to 1.2.0-alpha**

`ActivityIntensityRecord` only ships in connect-client `1.2.0-alpha*`, which requires `compileSdk 37`. Set `compileSdk = 37` (and `targetSdk = 37` if present) in `android/app/build.gradle.kts`, and in `android/gradle/libs.versions.toml` set:

```toml
healthConnect = "1.2.0-alpha01"
```

Use the newest published `androidx.health.connect:connect-client` in the 1.2.0-alpha line if alpha01 is superseded (check https://maven.google.com/web/index.html#androidx.health.connect:connect-client). Verify `ActivityIntensityRecord` resolves. The build in Step 2 is the gate.

- [ ] **Step 2: Verify build + existing tests still green**

Run: `cd android && ./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL. If the alpha bump broke an existing API call in `HealthConnectManager.kt`/`RecordReader.kt`, fix the compile error minimally (accessor renames between alphas), keeping behavior identical, until green.

- [ ] **Step 3: Commit**

```bash
git add android/gradle/libs.versions.toml android/app/build.gradle.kts android/app/src/main/java/com/android/vitalix
git commit -m "build(android): compileSdk 37 + connect-client 1.2.0-alpha for new record types"
```

---

## Task 2: Exercise detail on the model + payload

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt:66-69`
- Test: `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`

**Interfaces:**
- Produces: `ExerciseLap(start: String, end: String, lengthMeters: Double?)`, `ExerciseSegment(start: String, end: String, type: String)`, `RoutePoint(time: String, lat: Double, lng: Double, altitudeMeters: Double?, horizontalAccuracyMeters: Double?, verticalAccuracyMeters: Double?)`; `ExerciseData` gains `laps: List<ExerciseLap> = emptyList()`, `segments: List<ExerciseSegment> = emptyList()`, `route: List<RoutePoint> = emptyList()`. `ServerForwarder` serializes them under each exercise object as `laps`/`segments`/`route` (omitted when empty).

- [ ] **Step 1: Write the failing test**

Add to `ServerForwarderTest.kt` (import the new model classes):

```kotlin
@Test
fun exerciseSerializesLapsSegmentsRoute() {
    val day = DailyHealthData(
        date = "2026-07-24",
        exercises = listOf(
            ExerciseData(
                date = "2026-07-24", startDateTime = "2026-07-24T06:00:00Z",
                exerciseName = "Running", durationMinutes = 30,
                source = "com.x", hcId = "ex-1",
                laps = listOf(ExerciseLap("2026-07-24T06:00:00Z", "2026-07-24T06:10:00Z", 2000.0)),
                segments = listOf(ExerciseSegment("2026-07-24T06:00:00Z", "2026-07-24T06:05:00Z", "running")),
                route = listOf(RoutePoint("2026-07-24T06:00:00Z", 1.29, 103.85, 15.0, 3.0, 5.0)),
            )
        )
    )
    val json = ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "Pixel", 7))
    val ex = JSONObject(json).getJSONArray("days").getJSONObject(0).getJSONArray("exercises").getJSONObject(0)
    assertEquals(2000.0, ex.getJSONArray("laps").getJSONObject(0).getDouble("lengthMeters"), 0.0)
    assertEquals("running", ex.getJSONArray("segments").getJSONObject(0).getString("type"))
    val pt = ex.getJSONArray("route").getJSONObject(0)
    assertEquals(1.29, pt.getDouble("lat"), 0.0)
    assertEquals(103.85, pt.getDouble("lng"), 0.0)
}

@Test
fun exerciseOmitsEmptyDetail() {
    val day = DailyHealthData(
        date = "2026-07-24",
        exercises = listOf(ExerciseData("2026-07-24", "2026-07-24T06:00:00Z", "Walk", 10, hcId = "ex-2"))
    )
    val json = ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "Pixel", 7))
    val ex = JSONObject(json).getJSONArray("days").getJSONObject(0).getJSONArray("exercises").getJSONObject(0)
    assertFalse(ex.has("laps")); assertFalse(ex.has("segments")); assertFalse(ex.has("route"))
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: FAIL to compile (`ExerciseLap` unresolved).

- [ ] **Step 3: Add the model classes**

In `models/HealthData.kt`, add after `ExerciseData`:

```kotlin
data class ExerciseLap(val start: String, val end: String, val lengthMeters: Double? = null)
data class ExerciseSegment(val start: String, val end: String, val type: String)
data class RoutePoint(
    val time: String,
    val lat: Double,
    val lng: Double,
    val altitudeMeters: Double? = null,
    val horizontalAccuracyMeters: Double? = null,
    val verticalAccuracyMeters: Double? = null,
)
```

And extend `ExerciseData` (append after `hcId`):

```kotlin
    val laps: List<ExerciseLap> = emptyList(),
    val segments: List<ExerciseSegment> = emptyList(),
    val route: List<RoutePoint> = emptyList(),
```

- [ ] **Step 4: Serialize in ServerForwarder**

Replace the exercises map block (`ServerForwarder.kt:66-69`) with:

```kotlin
            if (d.exercises.isNotEmpty()) o.put("exercises", JSONArray(d.exercises.map { ex ->
                JSONObject().put("name", ex.exerciseName).put("start", ex.startDateTime).put("durationMinutes", ex.durationMinutes)
                    .apply {
                        ex.source?.let { put("source", it) }; ex.hcId?.let { put("hcId", it) }
                        if (ex.laps.isNotEmpty()) put("laps", JSONArray(ex.laps.map { l ->
                            JSONObject().put("start", l.start).put("end", l.end)
                                .apply { l.lengthMeters?.let { put("lengthMeters", it) } }
                        }))
                        if (ex.segments.isNotEmpty()) put("segments", JSONArray(ex.segments.map { s ->
                            JSONObject().put("start", s.start).put("end", s.end).put("type", s.type)
                        }))
                        if (ex.route.isNotEmpty()) put("route", JSONArray(ex.route.map { p ->
                            JSONObject().put("time", p.time).put("lat", p.lat).put("lng", p.lng)
                                .apply {
                                    p.altitudeMeters?.let { put("altitudeMeters", it) }
                                    p.horizontalAccuracyMeters?.let { put("horizontalAccuracyMeters", it) }
                                    p.verticalAccuracyMeters?.let { put("verticalAccuracyMeters", it) }
                                }
                        }))
                    }
            }))
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/models/HealthData.kt android/app/src/main/java/com/android/vitalix/ServerForwarder.kt android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt
git commit -m "feat(android): serialize exercise laps/segments/route"
```

---

## Task 3: MetaMappers for new context enums

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/health/MetaMappers.kt`
- Test: `android/app/src/test/java/com/android/vitalix/health/MetaMappersTest.kt`

**Interfaces:**
- Produces: `MetaMappers.activityIntensityMeta(type: Int): Map<String,String>?` (key `intensityType`); `mindfulnessMeta(type: Int): Map<String,String>?` (key `sessionType`); `skinTemperatureMeta(location: Int, baselineCelsius: Double?): Map<String,String>?` (keys `measurementLocation`, `baseline`); `basalBodyTemperatureMeta(location: Int): Map<String,String>?` (key `measurementLocation`); `cervicalMucusMeta(sensation: Int): Map<String,String>?` (key `sensation`). Each returns null when nothing known — same `putIfKnown`/`nullIfEmpty` convention already in the file.

- [ ] **Step 1: Write the failing tests**

Add to `MetaMappersTest.kt`:

```kotlin
@Test fun activityIntensityKnownAndUnknown() {
    assertNotNull(MetaMappers.activityIntensityMeta(2))       // a real intensity type
    assertNull(MetaMappers.activityIntensityMeta(0))          // unknown → null
}
@Test fun mindfulnessMapsSessionType() {
    assertTrue(MetaMappers.mindfulnessMeta(1)!!.containsKey("sessionType"))
}
@Test fun skinTemperatureCarriesBaselineWhenPresent() {
    val m = MetaMappers.skinTemperatureMeta(1, 33.5)!!
    assertEquals("33.5", m["baseline"])
    assertTrue(m.containsKey("measurementLocation"))
    assertNull(MetaMappers.skinTemperatureMeta(0, null)) // nothing known → null
}
@Test fun cervicalMucusSensation() {
    assertTrue(MetaMappers.cervicalMucusMeta(1)!!.containsKey("sensation"))
    assertNull(MetaMappers.cervicalMucusMeta(0))
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.MetaMappersTest"`
Expected: FAIL (unresolved reference).

- [ ] **Step 3: Implement the mappers**

Add to `MetaMappers` (use HC's public `*_INT_TO_STRING_MAP` where it exists; if a given record class does not expose one in the resolved connect-client version, define a local `mapOf(...)` with the documented enum strings and pass it to `putIfKnown` — mirror the existing local-map fallback note in the file header). Import the new record classes as needed.

```kotlin
    fun activityIntensityMeta(type: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "intensityType", ActivityIntensityRecord.ACTIVITY_INTENSITY_TYPE_INT_TO_STRING_MAP, type)
        return nullIfEmpty(out)
    }
    fun mindfulnessMeta(type: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "sessionType", MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_INT_TO_STRING_MAP, type)
        return nullIfEmpty(out)
    }
    fun skinTemperatureMeta(location: Int, baselineCelsius: Double?): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "measurementLocation", SkinTemperatureRecord.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, location)
        baselineCelsius?.let { out["baseline"] = it.toString() }
        return nullIfEmpty(out)
    }
    fun basalBodyTemperatureMeta(location: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "measurementLocation", BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, location)
        return nullIfEmpty(out)
    }
    fun cervicalMucusMeta(sensation: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "sensation", CervicalMucusRecord.SENSATION_INT_TO_STRING_MAP, sensation)
        return nullIfEmpty(out)
    }
```

If any `*_INT_TO_STRING_MAP` constant above does not exist in the resolved version, substitute a local map — e.g. for skin temperature location `mapOf(1 to "finger", 2 to "toe", 3 to "wrist")` (use the values from the record class's KDoc). The build error names the missing symbol.

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.MetaMappersTest"`
Expected: PASS. Adjust the sample enum ints in the test to real known values if `2`/`1` map to unknown in your version.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/health/MetaMappers.kt android/app/src/test/java/com/android/vitalix/health/MetaMappersTest.kt
git commit -m "feat(android): meta mappers for new HC context enums"
```

---

## Task 4: ExportConfig flags + settings round-trip

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/models/HealthData.kt` (`ExportConfig`)
- Test: `android/app/src/test/java/com/android/vitalix/SyncSettingsMappingTest.kt`

**Interfaces:**
- Produces: the 12 new `include*` flags on `ExportConfig` (default `false`). `SyncSettings` needs no change — `configToMap`/`mapToConfig` reflect over `memberProperties`, so new flags persist automatically.

- [ ] **Step 1: Write the failing test**

Add to `SyncSettingsMappingTest.kt`:

```kotlin
@Test fun newFlagsRoundTripThroughMap() {
    val cfg = ExportConfig(includeSkinTemperature = true, includeMindfulness = true, includeNutritionDetail = true, includeExerciseRoute = true)
    val restored = SyncSettings.mapToConfig(SyncSettings.configToMap(cfg))
    assertTrue(restored.includeSkinTemperature)
    assertTrue(restored.includeMindfulness)
    assertTrue(restored.includeNutritionDetail)
    assertTrue(restored.includeExerciseRoute)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.SyncSettingsMappingTest"`
Expected: FAIL to compile (unknown named arg).

- [ ] **Step 3: Add the flags to ExportConfig**

In `ExportConfig`, add under the matching category comments:

```kotlin
    // Activity (new)
    val includeActivityIntensity: Boolean = false,
    val includeCyclingCadence: Boolean = false,
    val includeStepsCadence: Boolean = false,
    val includeExerciseRoute: Boolean = false,

    // Body Measurements (new)
    val includeBasalMetabolicRate: Boolean = false,
    val includeBodyWaterMass: Boolean = false,

    // Cycle Tracking (new)
    val includeBasalBodyTemperature: Boolean = false,
    val includeIntermenstrualBleeding: Boolean = false,
    val includeMenstruationPeriod: Boolean = false,

    // Nutrition (new)
    val includeNutritionDetail: Boolean = false,

    // Vitals (new)
    val includeSkinTemperature: Boolean = false,

    // Wellness (new)
    val includeMindfulness: Boolean = false,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.SyncSettingsMappingTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/models/HealthData.kt android/app/src/test/java/com/android/vitalix/SyncSettingsMappingTest.kt
git commit -m "feat(android): add ExportConfig flags for gap metrics"
```

---

## Task 5: FakeRecordReader + HealthConnectManager test harness

**Files:**
- Create: `android/app/src/test/java/com/android/vitalix/health/FakeRecordReader.kt`
- Create: `android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt`

**Interfaces:**
- Produces: `FakeRecordReader(private val byType: Map<KClass<out Record>, List<Record>>)` implementing `RecordReader`, returning the list for the requested type (empty if absent). Test helper `meta(id, pkg)` building `androidx.health.connect.client.records.metadata.Metadata`. A `HealthConnectManagerTest` that runs the manager with a fake reader via `kotlinx.coroutines.test.runTest` and asserts emitted samples.

- [ ] **Step 1: Write the fake reader**

```kotlin
package com.android.vitalix.health

import androidx.health.connect.client.records.Record
import java.time.Instant
import kotlin.reflect.KClass

class FakeRecordReader(private val byType: Map<KClass<out Record>, List<Record>>) : RecordReader {
    @Suppress("UNCHECKED_CAST")
    override suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T> =
        (byType[type] ?: emptyList()) as List<T>
}
```

- [ ] **Step 2: Write a smoke test proving the harness works on an existing metric**

Create `HealthConnectManagerTest.kt`. Construct a `Metadata` (its factory differs by connect-client version — use `Metadata.manualEntry()` / `Metadata.autoRecorded(Device(...))` or the constructor the resolved version exposes; the compile error tells you which):

```kotlin
package com.android.vitalix.health

import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Metadata
import com.android.vitalix.models.ExportConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class HealthConnectManagerTest {
    private fun meta(id: String, pkg: String) =
        Metadata.manualEntry(id = id, dataOrigin = DataOrigin(pkg))

    private fun manager(vararg records: Pair<kotlin.reflect.KClass<out androidx.health.connect.client.records.Record>, List<androidx.health.connect.client.records.Record>>) =
        com.android.vitalix.HealthConnectManager(
            context = org.mockito.Mockito.mock(android.content.Context::class.java),
            reader = FakeRecordReader(records.toMap()),
        )

    private val t0: Instant = Instant.parse("2026-07-24T06:00:00Z")

    @Test fun stepsEmitsSampleWithSourceAndHcId() = runTest {
        val rec = StepsRecord(
            startTime = t0, startZoneOffset = ZoneOffset.UTC,
            endTime = t0.plusSeconds(600), endZoneOffset = ZoneOffset.UTC,
            count = 412, metadata = meta("st-1", "com.samsung.health"),
        )
        val mgr = manager(StepsRecord::class to listOf(rec))
        val days = mgr.readHealthDataByDay(ExportConfig(includeSteps = true), t0.minusSeconds(1), t0.plusSeconds(601))
        val s = days.single().samples.single { it.metric == "steps" }
        assertEquals(412.0, s.value); assertEquals("com.samsung.health", s.source); assertEquals("st-1", s.hcId)
    }
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: PASS. If `Metadata.manualEntry`/`Context` mock is unavailable, adapt to the version's factory / add `org.mockito:mockito-core` to `testImplementation` in `android/app/build.gradle.kts`. This step establishes the harness every later capture task reuses.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/test/java/com/android/vitalix/health/FakeRecordReader.kt android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt android/app/build.gradle.kts
git commit -m "test(android): HealthConnectManager test harness + fake reader"
```

---

## Task 6: Capture simple instant/interval types

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Test: `android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt`

Covers: `basalMetabolicRate`, `bodyWaterMass`, `basalBodyTemperature`, `intermenstrualBleeding`, `menstruationPeriod`, `activityIntensity`, `mindfulness`.

**Interfaces:**
- Consumes: `ExportConfig` flags from Task 4; `MetaMappers` from Task 3; `FakeRecordReader` from Task 5.
- Produces: one `HealthSample` per record with these encodings:

| Metric | Record | start/end | value | text | meta |
|--------|--------|-----------|-------|------|------|
| `basalMetabolicRate` | `BasalMetabolicRateRecord` | `time` | `basalMetabolicRate.inKilocaloriesPerDay` | — | — |
| `bodyWaterMass` | `BodyWaterMassRecord` | `time` | `mass.inKilograms` | — | — |
| `basalBodyTemperature` | `BasalBodyTemperatureRecord` | `time` | `temperature.inCelsius` | — | `basalBodyTemperatureMeta(measurementLocation)` |
| `intermenstrualBleeding` | `IntermenstrualBleedingRecord` | `time` | `1.0` | — | — |
| `menstruationPeriod` | `MenstruationPeriodRecord` | `startTime`→`endTime` | `1.0` | — | — |
| `activityIntensity` | `ActivityIntensityRecord` | `startTime`→`endTime` | — | intensity type string | `activityIntensityMeta(activityIntensityType)` |
| `mindfulness` | `MindfulnessSessionRecord` | `startTime`→`endTime` | duration minutes | `title` ?: session type string | `mindfulnessMeta(mindfulnessSessionType)` |

- [ ] **Step 1: Write the failing tests**

Add to `HealthConnectManagerTest.kt` (constructing each record with `metadata = meta(...)`, following the smoke test's style). One representative:

```kotlin
@Test fun basalMetabolicRateEmitsKcalPerDay() = runTest {
    val rec = BasalMetabolicRateRecord(
        time = t0, zoneOffset = ZoneOffset.UTC,
        basalMetabolicRate = androidx.health.connect.client.units.Power.kilocaloriesPerDay(1500.0),
        metadata = meta("bmr-1", "com.x"),
    )
    val mgr = manager(BasalMetabolicRateRecord::class to listOf(rec))
    val days = mgr.readHealthDataByDay(ExportConfig(includeBasalMetabolicRate = true), t0.minusSeconds(1), t0.plusSeconds(1))
    assertEquals(1500.0, days.single().samples.single { it.metric == "basalMetabolicRate" }.value)
}

@Test fun menstruationPeriodEmitsSpanMarker() = runTest {
    val rec = MenstruationPeriodRecord(
        startTime = t0, startZoneOffset = ZoneOffset.UTC,
        endTime = t0.plusSeconds(86400), endZoneOffset = ZoneOffset.UTC,
        metadata = meta("mp-1", "com.x"),
    )
    val mgr = manager(MenstruationPeriodRecord::class to listOf(rec))
    val days = mgr.readHealthDataByDay(ExportConfig(includeMenstruationPeriod = true), t0.minusSeconds(1), t0.plusSeconds(90000))
    val s = days.first().samples.single { it.metric == "menstruationPeriod" }
    assertEquals("2026-07-24T06:00:00Z", s.start)
    assertEquals(1.0, s.value)
}
```

Write one test per metric in the table (mechanical — same shape, the record constructor + expected field from the table).

- [ ] **Step 2: Run to verify they fail**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: FAIL (unresolved record imports / no samples emitted).

- [ ] **Step 3: Add imports + permissions + perMetric blocks**

Add the seven record imports at the top of `HealthConnectManager.kt`. Add each to the `permissions` set via `HealthPermission.getReadPermission(<Record>::class)`. Then add `perMetric{}` blocks (place each in its category section):

```kotlin
        perMetric(cfg.includeBasalMetabolicRate, BasalMetabolicRateRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.basalMetabolicRate.inKilocaloriesPerDay
                builder(day(r.time))
                    .samples += HealthSample("basalMetabolicRate", r.time.toString(), value = v, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBodyWaterMass, BodyWaterMassRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.time)).samples += HealthSample("bodyWaterMass", r.time.toString(), value = r.mass.inKilograms, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeBasalBodyTemperature, BasalBodyTemperatureRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.time)).samples += HealthSample("basalBodyTemperature", r.time.toString(), value = r.temperature.inCelsius, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.basalBodyTemperatureMeta(r.measurementLocation))
            }
        }
        perMetric(cfg.includeIntermenstrualBleeding, IntermenstrualBleedingRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.time)).samples += HealthSample("intermenstrualBleeding", r.time.toString(), value = 1.0, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeMenstruationPeriod, MenstruationPeriodRecord::class) { recs ->
            recs.forEach { r ->
                builder(day(r.startTime)).samples += HealthSample("menstruationPeriod", r.startTime.toString(), r.endTime.toString(), value = 1.0, source = r.origin, hcId = r.uid)
            }
        }
        perMetric(cfg.includeActivityIntensity, ActivityIntensityRecord::class) { recs ->
            recs.forEach { r ->
                val label = MetaMappers.activityIntensityMeta(r.activityIntensityType)?.get("intensityType")
                builder(day(r.startTime)).samples += HealthSample("activityIntensity", r.startTime.toString(), r.endTime.toString(), text = label, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.activityIntensityMeta(r.activityIntensityType))
            }
        }
        perMetric(cfg.includeMindfulness, MindfulnessSessionRecord::class) { recs ->
            recs.forEach { r ->
                val mins = java.time.temporal.ChronoUnit.MINUTES.between(r.startTime, r.endTime)
                val label = r.title ?: MetaMappers.mindfulnessMeta(r.mindfulnessSessionType)?.get("sessionType")
                builder(day(r.startTime)).samples += HealthSample("mindfulness", r.startTime.toString(), r.endTime.toString(), value = mins.toDouble(), text = label, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.mindfulnessMeta(r.mindfulnessSessionType))
            }
        }
```

If a field accessor name differs in the resolved version (e.g. `activityIntensityType`), the compile error names it — fix to match.

- [ ] **Step 4: Run to verify they pass**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt
git commit -m "feat(android): capture BMR, body-water, basal-temp, intermenstrual, period, activity-intensity, mindfulness"
```

---

## Task 7: Capture series types (cadence + skin temperature)

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Test: `android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt`

Covers `cyclingCadence`, `stepsCadence`, `skinTemperature` — each fans out to one sample **per inner sample**, inheriting the parent record's `origin`/`uid` (same pattern as `power`/`heartRate`).

**Interfaces:**
- Produces:

| Metric | Record | Per-inner value | meta |
|--------|--------|-----------------|------|
| `cyclingCadence` | `CyclingPedalingCadenceRecord` | `sample.revolutionsPerMinute` | — |
| `stepsCadence` | `StepsCadenceRecord` | `sample.rate` | — |
| `skinTemperature` | `SkinTemperatureRecord` | `delta.delta.inCelsius` | `skinTemperatureMeta(record.measurementLocation, record.baseline?.inCelsius)` (same on every emitted sample) |

- [ ] **Step 1: Write the failing test**

```kotlin
@Test fun skinTemperatureFansOutDeltasWithBaselineMeta() = runTest {
    val rec = SkinTemperatureRecord(
        startTime = t0, startZoneOffset = ZoneOffset.UTC,
        endTime = t0.plusSeconds(120), endZoneOffset = ZoneOffset.UTC,
        deltas = listOf(
            SkinTemperatureRecord.Delta(t0, androidx.health.connect.client.units.TemperatureDelta.celsius(0.3)),
            SkinTemperatureRecord.Delta(t0.plusSeconds(60), androidx.health.connect.client.units.TemperatureDelta.celsius(0.5)),
        ),
        baseline = androidx.health.connect.client.units.Temperature.celsius(33.0),
        measurementLocation = SkinTemperatureRecord.MEASUREMENT_LOCATION_FINGER,
        metadata = meta("sk-1", "com.x"),
    )
    val mgr = manager(SkinTemperatureRecord::class to listOf(rec))
    val days = mgr.readHealthDataByDay(ExportConfig(includeSkinTemperature = true), t0.minusSeconds(1), t0.plusSeconds(200))
    val samples = days.single().samples.filter { it.metric == "skinTemperature" }
    assertEquals(2, samples.size)
    assertEquals(0.3, samples[0].value)
    assertEquals("33.0", samples[0].meta!!["baseline"])
}
```

Add analogous tests for `cyclingCadence` and `stepsCadence` (two inner samples → two emitted samples). Adjust constant/factory names to the resolved version if compile fails.

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: FAIL.

- [ ] **Step 3: Add imports + permissions + perMetric blocks**

```kotlin
        perMetric(cfg.includeCyclingCadence, CyclingPedalingCadenceRecord::class) { recs ->
            recs.forEach { r -> r.samples.forEach { s ->
                builder(day(s.time)).samples += HealthSample("cyclingCadence", s.time.toString(), value = s.revolutionsPerMinute, source = r.origin, hcId = r.uid)
            } }
        }
        perMetric(cfg.includeStepsCadence, StepsCadenceRecord::class) { recs ->
            recs.forEach { r -> r.samples.forEach { s ->
                builder(day(s.time)).samples += HealthSample("stepsCadence", s.time.toString(), value = s.rate, source = r.origin, hcId = r.uid)
            } }
        }
        perMetric(cfg.includeSkinTemperature, SkinTemperatureRecord::class) { recs ->
            recs.forEach { r ->
                val m = MetaMappers.skinTemperatureMeta(r.measurementLocation, r.baseline?.inCelsius)
                r.deltas.forEach { d ->
                    builder(day(d.time)).samples += HealthSample("skinTemperature", d.time.toString(), value = d.delta.inCelsius, source = r.origin, hcId = r.uid, meta = m)
                }
            }
        }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt
git commit -m "feat(android): capture cycling/steps cadence + skin temperature series"
```

---

## Task 8: Nutrition nutrient fan-out + CervicalMucus sensation

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Test: `android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt`

**Interfaces:**
- Produces: when `includeNutritionDetail` is on, one `HealthSample("nutrition.<field>", startTime→endTime, value=<amount>, meta=mealType)` per non-null nutrient field of a `NutritionRecord`. The existing `includeNutrition` (energy-only day rollup + `nutrition` sample) is unchanged. CervicalMucus samples gain `meta = cervicalMucusMeta(sensation)`.

- [ ] **Step 1: Write the failing test**

```kotlin
@Test fun nutritionDetailFansOutNonNullNutrients() = runTest {
    val rec = NutritionRecord(
        startTime = t0, startZoneOffset = ZoneOffset.UTC,
        endTime = t0.plusSeconds(60), endZoneOffset = ZoneOffset.UTC,
        protein = androidx.health.connect.client.units.Mass.grams(20.0),
        sugar = androidx.health.connect.client.units.Mass.grams(5.0),
        mealType = androidx.health.connect.client.records.MealType.MEAL_TYPE_BREAKFAST,
        metadata = meta("nu-1", "com.x"),
    )
    val mgr = manager(NutritionRecord::class to listOf(rec))
    val days = mgr.readHealthDataByDay(ExportConfig(includeNutritionDetail = true), t0.minusSeconds(1), t0.plusSeconds(120))
    val samples = days.single().samples.filter { it.metric.startsWith("nutrition.") }
    val protein = samples.single { it.metric == "nutrition.protein" }
    assertEquals(20.0, protein.value)
    assertEquals("breakfast", protein.meta!!["mealType"])
    assertTrue(samples.none { it.metric == "nutrition.totalFat" }) // null field omitted
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: FAIL.

- [ ] **Step 3: Add the nutrient extractor table + perMetric block**

Add a private extractor list near the companion (each entry maps a metric suffix to the record's nullable field in its canonical unit — grams for masses, kcal for energies):

```kotlin
    private val nutrientExtractors: List<Pair<String, (NutritionRecord) -> Double?>> = listOf(
        "biotin" to { r -> r.biotin?.inGrams }, "caffeine" to { r -> r.caffeine?.inGrams },
        "calcium" to { r -> r.calcium?.inGrams }, "energyFromFat" to { r -> r.energyFromFat?.inKilocalories },
        "chloride" to { r -> r.chloride?.inGrams }, "cholesterol" to { r -> r.cholesterol?.inGrams },
        "chromium" to { r -> r.chromium?.inGrams }, "copper" to { r -> r.copper?.inGrams },
        "dietaryFiber" to { r -> r.dietaryFiber?.inGrams }, "folate" to { r -> r.folate?.inGrams },
        "folicAcid" to { r -> r.folicAcid?.inGrams }, "iodine" to { r -> r.iodine?.inGrams },
        "iron" to { r -> r.iron?.inGrams }, "magnesium" to { r -> r.magnesium?.inGrams },
        "manganese" to { r -> r.manganese?.inGrams }, "molybdenum" to { r -> r.molybdenum?.inGrams },
        "monounsaturatedFat" to { r -> r.monounsaturatedFat?.inGrams }, "niacin" to { r -> r.niacin?.inGrams },
        "pantothenicAcid" to { r -> r.pantothenicAcid?.inGrams }, "phosphorus" to { r -> r.phosphorus?.inGrams },
        "polyunsaturatedFat" to { r -> r.polyunsaturatedFat?.inGrams }, "potassium" to { r -> r.potassium?.inGrams },
        "protein" to { r -> r.protein?.inGrams }, "riboflavin" to { r -> r.riboflavin?.inGrams },
        "saturatedFat" to { r -> r.saturatedFat?.inGrams }, "selenium" to { r -> r.selenium?.inGrams },
        "sodium" to { r -> r.sodium?.inGrams }, "sugar" to { r -> r.sugar?.inGrams },
        "thiamin" to { r -> r.thiamin?.inGrams }, "totalCarbohydrate" to { r -> r.totalCarbohydrate?.inGrams },
        "totalFat" to { r -> r.totalFat?.inGrams }, "transFat" to { r -> r.transFat?.inGrams },
        "unsaturatedFat" to { r -> r.unsaturatedFat?.inGrams }, "vitaminA" to { r -> r.vitaminA?.inGrams },
        "vitaminB12" to { r -> r.vitaminB12?.inGrams }, "vitaminB6" to { r -> r.vitaminB6?.inGrams },
        "vitaminC" to { r -> r.vitaminC?.inGrams }, "vitaminD" to { r -> r.vitaminD?.inGrams },
        "vitaminE" to { r -> r.vitaminE?.inGrams }, "vitaminK" to { r -> r.vitaminK?.inGrams },
        "zinc" to { r -> r.zinc?.inGrams },
    )
```

Then the perMetric block (reuse the existing `MetaMappers`-style meal-type lookup; energy is already covered by `includeNutrition`, so it is excluded here):

```kotlin
        perMetric(cfg.includeNutritionDetail, NutritionRecord::class) { recs ->
            recs.forEach { r ->
                val mealMeta = MetaMappers.bloodGlucoseMeta(r.mealType, 0, 0) // reuse MEAL_TYPE map → {mealType}
                val b = builder(day(r.startTime))
                nutrientExtractors.forEach { (name, extract) ->
                    extract(r)?.let { v ->
                        b.samples += HealthSample("nutrition.$name", r.startTime.toString(), r.endTime.toString(), value = v, source = r.origin, hcId = r.uid, meta = mealMeta)
                    }
                }
            }
        }
```

> If reusing `bloodGlucoseMeta` for meal type reads awkwardly, add a dedicated `MetaMappers.mealTypeMeta(mealType: Int)` returning `{mealType}` and use it here (still pure, one-line). Prefer this if the reviewer flags the reuse.

For CervicalMucus sensation, update the existing block (`HealthConnectManager.kt` ~line 575) to add `meta = MetaMappers.cervicalMucusMeta(r.sensation)` to the `HealthSample("cervicalMucus", ...)` call.

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: PASS. Adjust any nutrient accessor name/unit the compiler rejects (a few use `inGrams`; confirm against `NutritionRecord`).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt
git commit -m "feat(android): nutrition nutrient fan-out + cervical-mucus sensation"
```

---

## Task 9: Capture exercise laps/segments/route

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Test: `android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt`

**Interfaces:**
- Consumes: `ExerciseLap`/`ExerciseSegment`/`RoutePoint` from Task 2.
- Produces: the existing `ExerciseSessionRecord` block also fills `laps`, `segments`, and (when `includeExerciseRoute` and route data present) `route` on the emitted `ExerciseData`.

- [ ] **Step 1: Write the failing test**

```kotlin
@Test fun exerciseCapturesLapsAndSegments() = runTest {
    val rec = ExerciseSessionRecord(
        startTime = t0, startZoneOffset = ZoneOffset.UTC,
        endTime = t0.plusSeconds(1800), endZoneOffset = ZoneOffset.UTC,
        exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
        title = "Morning run",
        laps = listOf(ExerciseSessionRecord.ExerciseLap(t0, t0.plusSeconds(600), androidx.health.connect.client.units.Length.meters(2000.0))),
        segments = listOf(ExerciseSessionRecord.ExerciseSegment(t0, t0.plusSeconds(300), ExerciseSegment.EXERCISE_SEGMENT_TYPE_RUNNING)),
        metadata = meta("ex-1", "com.x"),
    )
    val mgr = manager(ExerciseSessionRecord::class to listOf(rec))
    val days = mgr.readHealthDataByDay(ExportConfig(includeExercise = true, includeExerciseRoute = true), t0.minusSeconds(1), t0.plusSeconds(2000))
    val ex = days.single().exercises.single()
    assertEquals(2000.0, ex.laps.single().lengthMeters!!, 0.0)
    assertEquals(1, ex.segments.size)
}
```

(Route requires an `ExerciseRouteResult.Data`, whose construction/consent behavior is version-specific; assert `laps`/`segments` here and verify route on-device in Task 14. If the resolved version lets you construct `ExerciseRoute`/`ExerciseRouteResult.Data` in a unit test, add a route assertion.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: FAIL.

- [ ] **Step 3: Fill laps/segments/route in the exercise block**

In the existing `perMetric(cfg.includeExercise, ExerciseSessionRecord::class)` block, before building `ExerciseData`, map the nested structures and pass them in:

```kotlin
                val laps = r.laps.map { l ->
                    ExerciseLap(l.startTime.toString(), l.endTime.toString(), l.length?.inMeters)
                }
                val segments = r.segments.map { s ->
                    val type = ExerciseSegment.EXERCISE_SEGMENT_TYPE_INT_TO_STRING_MAP[s.segmentType] ?: "unknown"
                    ExerciseSegment(s.startTime.toString(), s.endTime.toString(), type)
                }
                val route = if (cfg.includeExerciseRoute) {
                    (r.exerciseRouteResult as? ExerciseRouteResult.Data)?.exerciseRoute?.route?.map { p ->
                        RoutePoint(p.time.toString(), p.latitude, p.longitude,
                            p.altitude?.inMeters, p.horizontalAccuracy?.inMeters, p.verticalAccuracy?.inMeters)
                    } ?: emptyList()
                } else emptyList()
                b.exercises += ExerciseData(
                    date = day(r.startTime).toString(),
                    startDateTime = r.startTime.toString(),
                    exerciseName = name,
                    durationMinutes = durationMin,
                    source = r.origin, hcId = r.uid,
                    laps = laps, segments = segments, route = route,
                )
```

Add imports for `ExerciseRouteResult` and (if the segment-type map is nested) reference it via the record class. Adjust accessor names (`exerciseRouteResult`, `p.latitude`, `p.altitude`) to the resolved version if the compiler objects.

- [ ] **Step 4: Run to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.health.HealthConnectManagerTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt android/app/src/test/java/com/android/vitalix/health/HealthConnectManagerTest.kt
git commit -m "feat(android): capture exercise laps/segments/route"
```

---

## Task 10: Web aggregation catalog for new metrics

**Files:**
- Modify: `web/src/records.js:5-20`
- Test: `web/test/records.test.js`

**Interfaces:**
- Consumes: new metric keys.
- Produces: `aggregationFor("nutrition.protein") === "sum"`, `aggregationFor("mindfulness") === "sum"`, `aggregationFor("intermenstrualBleeding") === "sum"`, `aggregationFor("basalMetabolicRate"|"bodyWaterMass"|"basalBodyTemperature"|"menstruationPeriod") === "last"`, `aggregationFor("activityIntensity") === "text"`, `aggregationFor("cyclingCadence"|"stepsCadence"|"skinTemperature") === "minmaxavg"` (default).

- [ ] **Step 1: Write the failing tests**

Add to `records.test.js`:

```javascript
test("new metrics map to the right aggregation", () => {
  assert.equal(aggregationFor("mindfulness"), "sum");
  assert.equal(aggregationFor("intermenstrualBleeding"), "sum");
  assert.equal(aggregationFor("basalMetabolicRate"), "last");
  assert.equal(aggregationFor("bodyWaterMass"), "last");
  assert.equal(aggregationFor("basalBodyTemperature"), "last");
  assert.equal(aggregationFor("menstruationPeriod"), "last");
  assert.equal(aggregationFor("activityIntensity"), "text");
  assert.equal(aggregationFor("skinTemperature"), "minmaxavg");
});

test("all nutrition.* nutrients aggregate as sum", () => {
  assert.equal(aggregationFor("nutrition.protein"), "sum");
  assert.equal(aggregationFor("nutrition.vitaminB12"), "sum");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npm test`
Expected: FAIL (assertion errors — defaults to `minmaxavg`).

- [ ] **Step 3: Extend the catalog + add the nutrition prefix rule**

In `records.js`, extend the arrays:

```javascript
const SUM = ["steps", "distance", "activeCalories", "totalCalories", "floorsClimbed",
  "elevationGained", "wheelchairPushes", "hydration", "nutrition",
  "mindfulness", "intermenstrualBleeding"];
const LAST = ["weight", "bodyFat", "boneMass", "height", "leanBodyMass", "restingHeartRate",
  "basalMetabolicRate", "bodyWaterMass", "basalBodyTemperature", "menstruationPeriod"];
const TEXT = ["menstruation", "cervicalMucus", "ovulationTest", "sexualActivity", "sleepStage",
  "activityIntensity"];
```

And update `aggregationFor` so any `nutrition.<field>` sums:

```javascript
export function aggregationFor(type) {
  if (typeof type === "string" && type.startsWith("nutrition.")) return "sum";
  return RULES.get(type) ?? "minmaxavg";
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add web/src/records.js web/test/records.test.js
git commit -m "feat(web): aggregation catalog for gap metrics + nutrition.* sum"
```

---

## Task 11: mapPayload accepts new metrics + exercise detail

**Files:**
- Modify: `web/src/mapPayload.js:14-21` (`KNOWN_SAMPLE_METRICS`, add `nutrition.*` passthrough), `:90-98` (`mapExercises`)
- Test: `web/test/mapPayload.test.js`

**Interfaces:**
- Consumes: payload samples with new metric keys + exercises with `laps`/`segments`/`route`.
- Produces: `mapSamples` keeps any known key **or** any `nutrition.*` key; `mapExercises` output rows gain `detail: {laps, segments, route}` (null when all three absent).

- [ ] **Step 1: Write the failing tests**

Add to `mapPayload.test.js`:

```javascript
test("keeps new gap metrics and nutrition.* samples", () => {
  const { days, skipped } = mapPayload({ days: [{ date: "2026-07-24", samples: [
    { metric: "skinTemperature", start: "2026-07-24T06:00:00Z", value: 0.3, hcId: "s1" },
    { metric: "mindfulness", start: "2026-07-24T06:00:00Z", end: "2026-07-24T06:10:00Z", value: 10, hcId: "m1" },
    { metric: "nutrition.protein", start: "2026-07-24T06:00:00Z", value: 20, hcId: "n1" },
  ] }] });
  assert.equal(skipped, 0);
  assert.equal(days[0].samples.length, 3);
});

test("maps exercise detail into a detail object", () => {
  const { days } = mapPayload({ days: [{ date: "2026-07-24", exercises: [
    { name: "Run", start: "2026-07-24T06:00:00Z", durationMinutes: 30, hcId: "e1",
      laps: [{ start: "a", end: "b", lengthMeters: 2000 }],
      segments: [{ start: "a", end: "b", type: "running" }],
      route: [{ time: "a", lat: 1.2, lng: 103.8 }] },
  ] }] });
  const ex = days[0].exercises[0];
  assert.equal(ex.detail.laps.length, 1);
  assert.equal(ex.detail.route[0].lat, 1.2);
});

test("exercise without detail has null detail", () => {
  const { days } = mapPayload({ days: [{ date: "2026-07-24", exercises: [
    { name: "Walk", start: "2026-07-24T06:00:00Z", durationMinutes: 10, hcId: "e2" },
  ] }] });
  assert.equal(days[0].exercises[0].detail, null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npm test`
Expected: FAIL.

- [ ] **Step 3: Update mapPayload**

Add the new keys to `KNOWN_SAMPLE_METRICS`:

```javascript
  "activityIntensity", "cyclingCadence", "stepsCadence", "basalMetabolicRate", "bodyWaterMass",
  "skinTemperature", "basalBodyTemperature", "intermenstrualBleeding", "menstruationPeriod", "mindfulness",
```

Change the `mapSamples` guard to also accept nutrient keys:

```javascript
    if (!KNOWN_SAMPLE_METRICS.has(r.metric) && !String(r.metric).startsWith("nutrition.")) { skipped++; continue; }
```

Replace `mapExercises`:

```javascript
function mapExercises(day) {
  return (Array.isArray(day.exercises) ? day.exercises : []).map((e) => {
    const detail = (e.laps || e.segments || e.route)
      ? { laps: e.laps ?? [], segments: e.segments ?? [], route: e.route ?? [] }
      : null;
    return {
      name: e.name ?? null,
      start_at: e.start ?? null,
      duration_minutes: e.durationMinutes ?? null,
      source: e.source ?? null,
      hc_id: e.hcId ?? null,
      detail,
    };
  });
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/mapPayload.js web/test/mapPayload.test.js
git commit -m "feat(web): map gap metrics + exercise detail"
```

---

## Task 12: Persist exercise detail (migration + write)

**Files:**
- Create: `web/migrations/1722100000000_exercise_detail.cjs`
- Modify: `web/src/persist.js:54-77` (`replaceExercises`)

**Interfaces:**
- Consumes: `mapExercises` rows with `detail`.
- Produces: `exercises.detail jsonb` column, written on both insert paths of `replaceExercises`.

- [ ] **Step 1: Write the migration**

```javascript
// Structured exercise detail (laps, segments, GPS route) that doesn't fit the
// flat columns. Nullable; only present when the writing app recorded it and the
// user granted the route permission.
exports.up = (pgm) => {
  pgm.addColumns("exercises", { detail: { type: "jsonb" } });
};
exports.down = (pgm) => {
  pgm.dropColumns("exercises", ["detail"]);
};
```

- [ ] **Step 2: Run the migration**

Run: `cd web && npm run migrate`
Expected: applies `1722100000000_exercise_detail` with no error.

- [ ] **Step 3: Write detail in replaceExercises**

Update both INSERTs in `replaceExercises` to include `detail` (serialize with `JSON.stringify`, null-safe):

```javascript
      // withoutId path:
      await client.query(
        "INSERT INTO exercises (day_id, name, start_at, duration_minutes, source, detail) VALUES ($1,$2,$3,$4,$5,$6)",
        [dayId, e.name, e.start_at, e.duration_minutes, e.source, e.detail ? JSON.stringify(e.detail) : null]
      );
```

```javascript
      // withId path:
      await client.query(
        `INSERT INTO exercises (day_id, name, start_at, duration_minutes, source, hc_id, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (day_id, hc_id) DO UPDATE SET
           name = EXCLUDED.name, start_at = EXCLUDED.start_at,
           duration_minutes = EXCLUDED.duration_minutes, source = EXCLUDED.source, detail = EXCLUDED.detail`,
        [dayId, e.name, e.start_at, e.duration_minutes, e.source, e.hc_id, e.detail ? JSON.stringify(e.detail) : null]
      );
```

- [ ] **Step 4: Verify existing tests still pass**

Run: `cd web && npm test`
Expected: PASS (persist has no unit test; this guards the mapPayload/records suites still green). The write path is exercised on-device in Task 14.

- [ ] **Step 5: Commit**

```bash
git add web/migrations/1722100000000_exercise_detail.cjs web/src/persist.js
git commit -m "feat(web): persist exercise detail jsonb"
```

---

## Task 13: Show exercise detail on the day page

**Files:**
- Modify: `web/views/day.ejs:72-80`, `web/src/routes/pages.js:186`

**Interfaces:**
- Consumes: `exercises.detail`.
- Produces: the day-page exercises table shows lap count, segment count, and a "route" indicator.

- [ ] **Step 1: Select the detail column**

In `pages.js`, change the exercises query (line ~186) to include `detail`:

```javascript
      query("SELECT name,start_at,duration_minutes,source,detail FROM exercises WHERE day_id=$1", [d.id]),
```

- [ ] **Step 2: Render detail in day.ejs**

Replace the exercises table header/row (`day.ejs:73-77`):

```html
    <thead><tr><th>Name</th><th>Start</th><th>Duration (min)</th><th>Source</th><th>Laps</th><th>Segments</th><th>Route</th></tr></thead>
    <tbody>
    <% exercises.forEach(function(ex) { %>
      <tr>
        <td><%= ex.name %></td><td><%= ex.start_at %></td><td><%= ex.duration_minutes %></td>
        <td><%= ex.source === null ? "—" : ex.source %></td>
        <td><%= ex.detail && ex.detail.laps ? ex.detail.laps.length : 0 %></td>
        <td><%= ex.detail && ex.detail.segments ? ex.detail.segments.length : 0 %></td>
        <td><%= ex.detail && ex.detail.route && ex.detail.route.length ? "yes (" + ex.detail.route.length + " pts)" : "—" %></td>
      </tr>
    <% }); %>
```

- [ ] **Step 3: Verify the server renders**

Run: `cd web && node -e "require('ejs').renderFile('views/day.ejs', {day:{id:1},date:'2026-07-24',aggregates:[],samples:[],exercises:[{name:'Run',start_at:'x',duration_minutes:30,source:'com.x',detail:{laps:[{}],segments:[],route:[{},{}]}}]}, {}, (e,html)=>{ if(e) throw e; if(!html.includes('yes (2 pts)')) throw new Error('route indicator missing'); console.log('ok'); })"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add web/views/day.ejs web/src/routes/pages.js
git commit -m "feat(web): show exercise laps/segments/route on day page"
```

---

## Task 14: UI wiring — checkboxes, permissions, manifest

**Files:**
- Modify: `android/app/src/main/res/layout/activity_main.xml` (confirm exact filename via the `setContentView` call in `MainActivity.onCreate`)
- Modify: `android/app/src/main/java/com/android/vitalix/MainActivity.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`

This task is device/build-verified (no unit test — it's view boilerplate). Each new metric gets a checkbox in its category; route gets a distinct consent affordance.

**Interfaces:**
- Consumes: the 12 `ExportConfig` flags (Task 4), the new `HealthConnectManager.permissions` entries (Tasks 6–9).

- [ ] **Step 1: Add checkboxes to the layout**

In `activity_main.xml`, add a `CheckBox` under each category's `layout*Subtypes` container, mirroring an existing one (copy a sibling `CheckBox`, change `android:id` and `android:text`). Add these ids:
`checkActivityIntensity`, `checkCyclingCadence`, `checkStepsCadence`, `checkExerciseRoute` (Activity group);
`checkBasalMetabolicRate`, `checkBodyWaterMass` (Body group);
`checkSkinTemperature` (Vitals group);
`checkBasalBodyTemperature`, `checkIntermenstrualBleeding`, `checkMenstruationPeriod` (Cycle group);
`checkNutritionDetail` (Nutrition group);
`checkMindfulness` — add a new **Wellness** category block (header/checkAll/count/chevron/body ids following the existing category XML pattern, e.g. `headerWellness`, `checkCategoryWellness`, `countWellness`, `chevronWellness`, `layoutWellnessSubtypes`).

- [ ] **Step 2: Declare + bind the fields in MainActivity**

Add a `private lateinit var` for each new checkbox (mirroring the block at `MainActivity.kt:51-91`). Add the matching `findViewById` lines in the binder (mirroring `:240-276`). Add each to the correct `Category(...)` metrics list in `buildCategories()` (`:335+`), and add a new Wellness `Category` for `checkMindfulness`. Add restore lines in the config→form binder (mirroring `:405-441`):

```kotlin
        checkActivityIntensity.isChecked = cfg.includeActivityIntensity
        checkCyclingCadence.isChecked = cfg.includeCyclingCadence
        checkStepsCadence.isChecked = cfg.includeStepsCadence
        checkExerciseRoute.isChecked = cfg.includeExerciseRoute
        checkBasalMetabolicRate.isChecked = cfg.includeBasalMetabolicRate
        checkBodyWaterMass.isChecked = cfg.includeBodyWaterMass
        checkSkinTemperature.isChecked = cfg.includeSkinTemperature
        checkBasalBodyTemperature.isChecked = cfg.includeBasalBodyTemperature
        checkIntermenstrualBleeding.isChecked = cfg.includeIntermenstrualBleeding
        checkMenstruationPeriod.isChecked = cfg.includeMenstruationPeriod
        checkNutritionDetail.isChecked = cfg.includeNutritionDetail
        checkMindfulness.isChecked = cfg.includeMindfulness
```

- [ ] **Step 3: Collect them in buildConfigFromForm**

Add each to the `ExportConfig(...)` constructor call (`:448+`):

```kotlin
        includeActivityIntensity = checkActivityIntensity.isChecked,
        includeCyclingCadence = checkCyclingCadence.isChecked,
        includeStepsCadence = checkStepsCadence.isChecked,
        includeExerciseRoute = checkExerciseRoute.isChecked,
        includeBasalMetabolicRate = checkBasalMetabolicRate.isChecked,
        includeBodyWaterMass = checkBodyWaterMass.isChecked,
        includeSkinTemperature = checkSkinTemperature.isChecked,
        includeBasalBodyTemperature = checkBasalBodyTemperature.isChecked,
        includeIntermenstrualBleeding = checkIntermenstrualBleeding.isChecked,
        includeMenstruationPeriod = checkMenstruationPeriod.isChecked,
        includeNutritionDetail = checkNutritionDetail.isChecked,
        includeMindfulness = checkMindfulness.isChecked,
```

- [ ] **Step 4: Add the exercise-route permission**

In `AndroidManifest.xml`, add alongside the other health permissions:

```xml
    <uses-permission android:name="android.permission.health.READ_EXERCISE_ROUTE" />
```

The route read permission is already added to `HealthConnectManager.permissions` in Task 9 (as the string `HealthPermission.PERMISSION_READ_EXERCISE_ROUTE`, or the literal `"android.permission.health.READ_EXERCISE_ROUTE"` if no constant exists — match Task 1's spelled-out-constant style). Health Connect's permission dialog handles route consent; no extra Android runtime-location permission is needed.

- [ ] **Step 5: Build + install + on-device sanity**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL.

Then `./gradlew installDebug`, open the app, verify the new checkboxes appear under the right categories (incl. the new Wellness group), enable a few (e.g. Skin temperature, Mindfulness, Nutrition detail, Exercise route), grant HC permissions, and run "Sync now". Confirm no crash and the sync reports success.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/res/layout/activity_main.xml android/app/src/main/java/com/android/vitalix/MainActivity.kt android/app/src/main/AndroidManifest.xml
git commit -m "feat(android): UI + permissions for gap metrics"
```

---

## Task 15: On-device end-to-end verification + docs update

**Files:**
- Modify: `docs/health-connect-data-coverage.md`

**Interfaces:**
- Consumes: a running receiver (`web/` with Postgres) reachable from the device.

- [ ] **Step 1: Live sync into records**

With the receiver running and the app pointed at it, enable the new metrics and sync. Then query Postgres to confirm the new metrics landed at native granularity:

Run: `cd web && node -e "import('./src/db.js').then(async ({query})=>{const {rows}=await query(\"SELECT type, count(*) FROM records WHERE type LIKE 'nutrition.%' OR type IN ('skinTemperature','mindfulness','basalMetabolicRate','activityIntensity','stepsCadence','cyclingCadence','bodyWaterMass','basalBodyTemperature','intermenstrualBleeding','menstruationPeriod') GROUP BY type ORDER BY type\"); console.table(rows); process.exit(0);})"`
Expected: rows for whichever new types the device actually has data for. (Absence for a type just means the device has no such data — not a failure. At minimum, verify one series type and one nutrient appear.)

- [ ] **Step 2: Confirm exercise detail persisted**

Run: `cd web && node -e "import('./src/db.js').then(async ({query})=>{const {rows}=await query(\"SELECT name, jsonb_array_length(COALESCE(detail->'route','[]')) AS route_pts, jsonb_array_length(COALESCE(detail->'laps','[]')) AS laps FROM exercises WHERE detail IS NOT NULL ORDER BY start_at DESC LIMIT 5\"); console.table(rows); process.exit(0);})"`
Expected: recent workouts show lap/route counts where the source recorded them.

- [ ] **Step 3: Re-sync idempotency check**

Trigger a second "Sync now" for the same window, then re-run Step 1's count query.
Expected: counts are unchanged (the `records_identity` unique key upserts, no duplicates).

- [ ] **Step 4: Update the coverage audit**

In `docs/health-connect-data-coverage.md`: flip the 10 newly-captured rows' Captured column to ✅ with their field notes; remove the ⚠️ field-gap notes on Exercise (now full incl. route), Nutrition (now all nutrients), and CervicalMucus (sensation added); update the "Not captured" section to list only `PlannedExerciseSessionRecord`; update the summary counts to **41 captured / 1 not captured**; bump the "Last verified" date.

- [ ] **Step 5: Commit**

```bash
git add docs/health-connect-data-coverage.md
git commit -m "docs: mark HC gap metrics captured after e2e verification"
```

---

## Self-Review Notes

- **Spec coverage:** 10 new types → Tasks 6/7/9 + wiring 14; nutrient fan-out → Task 8/10/11; exercise route → Tasks 2/9/12/13; CervicalMucus sensation → Tasks 3/8; granular-only (no rollup columns) → honored (only migration is `exercises.detail`); coverage-doc update → Task 15.
- **Version risk** is front-loaded in Task 1; every capture task ends with a build/test gate so alpha accessor drift surfaces immediately.
- **Metric-key contract** is fixed in Global Constraints and reused verbatim by both Android (`HealthSample` metric strings) and web (`KNOWN_SAMPLE_METRICS`, `aggregationFor`).

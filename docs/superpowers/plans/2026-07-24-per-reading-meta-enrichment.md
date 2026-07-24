# Per-Reading Enum Enrichment (`meta`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the per-reading context enums Health Connect attaches to blood-pressure, glucose, VO₂-max, and body-temperature readings and carry them end to end (Android → payload → `samples`/`records` → day-detail page) in a new nullable `meta` bag, without altering any existing value.

**Architecture:** A `meta: Map<String,String>?` is added to `HealthSample`; four existing readers populate it via small pure enum→string mappers; `ServerForwarder` serializes it as a nested JSON object only when non-empty. On the web side a nullable `meta jsonb` column is added to `samples` and `records`, threaded through `mapPayload` and `persist`, and rendered as a "Context" column on the day-detail page. Day rollups and dashboard charts are untouched.

**Tech Stack:** Android (Kotlin, `androidx.health.connect:connect-client:1.1.0-alpha07`, `org.json`, `kotlin.test` JVM unit tests). Web: Node ≥20 ESM, Express, EJS, `pg`, `node-pg-migrate` (`.cjs`), `node --test`.

## Global Constraints

- `meta` is **always optional**: absent/empty ⇒ omitted from payload ⇒ SQL `NULL` ⇒ every existing reading and the entire current UI is byte-identical.
- Enum values are lower_snake strings from Health Connect's int→string maps. An unmapped / `*_UNKNOWN` (`0`) enum is **omitted** from the map, never written as `"unknown"`. If every enum for a reading is unknown, `meta` is `null`.
- Produced `meta` **key names are the contract** (below); the HC map/constant used to derive the value is an implementation detail.
- Context enums live only at the per-reading grain: `meta` is added to `samples` and `records` **only**. `health_days`, `day_aggregates`, `day_source_metrics` are unchanged.
- No new `ExportConfig` flags and no Android UI changes — enrichment rides on the already-enabled BP / glucose / VO₂ / body-temperature metrics.
- Android commands run from `android/`; web commands from `web/`. Commit after each task with the message shown in its final step.

Contract `meta` keys per record:

| Record | Keys |
|--------|------|
| Blood pressure (`bloodPressure`) | `bodyPosition`, `measurementLocation` |
| Blood glucose (`bloodGlucose`) | `mealType`, `relationToMeal`, `specimenSource` |
| VO₂ max (`vo2Max`) | `measurementMethod` |
| Body temperature (`bodyTemperature`) | `measurementLocation` |

---

## File Structure

- **Modify** `android/app/src/main/java/com/android/vitalix/models/HealthData.kt` — `HealthSample` gains `meta`.
- **Modify** `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt` — serialize `meta`.
- **Create** `android/app/src/main/java/com/android/vitalix/health/MetaMappers.kt` — pure enum→`meta` mappers.
- **Modify** `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt` — 4 readers call the mappers.
- **Create** `android/app/src/test/java/com/android/vitalix/MetaMappersTest.kt`.
- **Modify** `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`.
- **Create** `web/migrations/1722000000000_reading_meta.cjs`.
- **Modify** `web/src/mapPayload.js`, `web/src/persist.js`, `web/src/routes/pages.js`, `web/views/day.ejs`.
- **Modify** `web/test/mapPayload.test.js` (create if absent).
- **Modify** `docs/database-erd.md`.

---

## Task 1: `HealthSample.meta` + payload serialization (Android)

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`
- Test: `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`

**Interfaces:**
- Produces: `HealthSample(..., meta: Map<String,String>? = null)`; `ServerForwarder.buildPayload` emits a nested `meta` object on a sample iff `meta` is non-null and non-empty.

- [ ] **Step 1: Write the failing tests**

Add to `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt` (inside the class):

```kotlin
    @Test fun serializesMetaObjectOnSampleWhenPresent() {
        val day = DailyHealthData(
            date = "2026-07-20",
            samples = listOf(HealthSample("bloodPressure", "2026-07-20T10:04:12Z",
                value = 120.0, value2 = 80.0, source = "com.x", hcId = "bp-1",
                meta = mapOf("bodyPosition" to "standing", "measurementLocation" to "left_wrist")))
        )
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val sample = json.getJSONArray("days").getJSONObject(0).getJSONArray("samples").getJSONObject(0)
        val meta = sample.getJSONObject("meta")
        assertEquals("standing", meta.getString("bodyPosition"))
        assertEquals("left_wrist", meta.getString("measurementLocation"))
    }

    @Test fun omitsMetaKeyWhenNullOrEmpty() {
        val day = DailyHealthData(
            date = "2026-07-20",
            samples = listOf(
                HealthSample("heartRate", "2026-07-20T10:04:12Z", value = 68.0),                 // null meta
                HealthSample("heartRate", "2026-07-20T10:05:12Z", value = 70.0, meta = emptyMap()) // empty meta
            )
        )
        val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
        val samples = json.getJSONArray("days").getJSONObject(0).getJSONArray("samples")
        assertFalse(samples.getJSONObject(0).has("meta"))
        assertFalse(samples.getJSONObject(1).has("meta"))
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: FAIL — `meta` is not a parameter of `HealthSample` (compile error), or `meta` key missing.

- [ ] **Step 3: Add `meta` to `HealthSample`**

In `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`, add a final field to the `HealthSample` data class (after `hcId`):

```kotlin
    /** Health Connect record UID (metadata.id), for idempotent server storage. */
    val hcId: String? = null,
    /**
     * Per-reading context enums Health Connect attaches (e.g. a blood-pressure
     * reading's body position). Null/empty when the record has no context.
     */
    val meta: Map<String, String>? = null
```

(Note: add a trailing comma after `hcId = null` when inserting the new field.)

- [ ] **Step 4: Serialize `meta` in `ServerForwarder`**

In `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`, add one line to `sampleJson` (after the `hcId` line):

```kotlin
    private fun sampleJson(s: HealthSample) = JSONObject().apply {
        put("metric", s.metric); put("start", s.start)
        s.end?.let { put("end", it) }; s.value?.let { put("value", it) }
        s.value2?.let { put("value2", it) }; s.text?.let { put("text", it) }
        s.source?.let { put("source", it) }
        s.hcId?.let { put("hcId", it) }
        s.meta?.takeIf { it.isNotEmpty() }?.let { put("meta", JSONObject(it as Map<*, *>)) }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: PASS (all ServerForwarder tests, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/models/HealthData.kt \
        android/app/src/main/java/com/android/vitalix/ServerForwarder.kt \
        android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt
git commit -m "feat(android): carry per-reading meta on HealthSample + payload"
```

---

## Task 2: Pure enum→`meta` mappers + wire into readers (Android)

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/health/MetaMappers.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Test: `android/app/src/test/java/com/android/vitalix/MetaMappersTest.kt`

**Interfaces:**
- Consumes: `HealthSample(..., meta)` from Task 1.
- Produces: object `MetaMappers` with pure functions `bloodPressureMeta(bodyPosition: Int, measurementLocation: Int): Map<String,String>?`, `bloodGlucoseMeta(mealType: Int, relationToMeal: Int, specimenSource: Int): Map<String,String>?`, `vo2MaxMeta(measurementMethod: Int): Map<String,String>?`, `bodyTemperatureMeta(measurementLocation: Int): Map<String,String>?`. Each returns `null` when the resulting map would be empty.

- [ ] **Step 1: Write the failing tests**

Create `android/app/src/test/java/com/android/vitalix/MetaMappersTest.kt`:

```kotlin
package com.android.vitalix

import com.android.vitalix.health.MetaMappers
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class MetaMappersTest {
    @Test fun bloodPressureMapsKnownEnumsAndOmitsUnknown() {
        // Any non-zero known enum ints; 0 is the *_UNKNOWN sentinel across HC.
        val m = MetaMappers.bloodPressureMeta(bodyPosition = 1, measurementLocation = 1)
        assertTrue(m != null && m.containsKey("bodyPosition"))
        assertTrue(m.containsKey("measurementLocation"))
        // Unknown (0) for both -> null map.
        assertNull(MetaMappers.bloodPressureMeta(bodyPosition = 0, measurementLocation = 0))
        // One known, one unknown -> only the known key present.
        val one = MetaMappers.bloodPressureMeta(bodyPosition = 1, measurementLocation = 0)
        assertTrue(one != null && one.containsKey("bodyPosition"))
        assertFalse(one.containsKey("measurementLocation"))
    }

    @Test fun bloodGlucoseKeysAreContractual() {
        val m = MetaMappers.bloodGlucoseMeta(mealType = 1, relationToMeal = 1, specimenSource = 1)
        assertTrue(m != null)
        assertTrue(m.keys.all { it in setOf("mealType", "relationToMeal", "specimenSource") })
        assertNull(MetaMappers.bloodGlucoseMeta(0, 0, 0))
    }

    @Test fun vo2AndBodyTempSingleKey() {
        assertEquals(setOf("measurementMethod"), MetaMappers.vo2MaxMeta(1)?.keys)
        assertNull(MetaMappers.vo2MaxMeta(0))
        assertEquals(setOf("measurementLocation"), MetaMappers.bodyTemperatureMeta(1)?.keys)
        assertNull(MetaMappers.bodyTemperatureMeta(0))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.MetaMappersTest"`
Expected: FAIL — `MetaMappers` unresolved (compile error).

- [ ] **Step 3: Implement `MetaMappers`**

Create `android/app/src/main/java/com/android/vitalix/health/MetaMappers.kt`.

Resolution rule for the implementer: for each enum, prefer Health Connect's public `*_INT_TO_STRING_MAP` companion map — mirror how `HealthConnectManager` already uses `MenstruationFlowRecord.FLOW_TYPE_INT_TO_STRING_MAP`, `CervicalMucusRecord.APPEARANCE_INT_TO_STRING_MAP`, etc. If a specific map is **not accessible** in `connect-client 1.1.0-alpha07`, define a private local `Int→String` map in this file with the documented lower_snake enum values (e.g. body position `standing`/`sitting_down`/`lying_down`/`reclining`). In both cases the `0` (`*_UNKNOWN`) key must be absent so it maps to null. Use these lookups:

```kotlin
package com.android.vitalix.health

import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyTemperatureMeasurementLocation
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.Vo2MaxRecord

/**
 * Pure Health-Connect-enum → context-map mappers. Kept free of HC record
 * construction so they unit-test with plain Int inputs. An unmapped or
 * *_UNKNOWN (0) enum is omitted; an all-unknown reading yields null.
 *
 * Each lookup uses HC's public `*_INT_TO_STRING_MAP` where accessible in
 * connect-client 1.1.0-alpha07 (as HealthConnectManager already does for
 * flow/appearance/etc.); where a map is not public, a local map with the
 * documented enum strings is substituted. The produced KEY names are the
 * cross-component contract and must not change.
 */
object MetaMappers {
    private fun putIfKnown(out: MutableMap<String, String>, key: String, map: Map<Int, String>, value: Int) {
        map[value]?.let { out[key] = it }
    }

    private fun nullIfEmpty(m: MutableMap<String, String>): Map<String, String>? =
        if (m.isEmpty()) null else m

    fun bloodPressureMeta(bodyPosition: Int, measurementLocation: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "bodyPosition", BloodPressureRecord.BODY_POSITION_INT_TO_STRING_MAP, bodyPosition)
        putIfKnown(out, "measurementLocation", BloodPressureRecord.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, measurementLocation)
        return nullIfEmpty(out)
    }

    fun bloodGlucoseMeta(mealType: Int, relationToMeal: Int, specimenSource: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "mealType", MealType.MEAL_TYPE_INT_TO_STRING_MAP, mealType)
        putIfKnown(out, "relationToMeal", BloodGlucoseRecord.RELATION_TO_MEAL_INT_TO_STRING_MAP, relationToMeal)
        putIfKnown(out, "specimenSource", BloodGlucoseRecord.SPECIMEN_SOURCE_INT_TO_STRING_MAP, specimenSource)
        return nullIfEmpty(out)
    }

    fun vo2MaxMeta(measurementMethod: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "measurementMethod", Vo2MaxRecord.MEASUREMENT_METHOD_INT_TO_STRING_MAP, measurementMethod)
        return nullIfEmpty(out)
    }

    fun bodyTemperatureMeta(measurementLocation: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "measurementLocation", BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, measurementLocation)
        return nullIfEmpty(out)
    }
}
```

If any referenced `*_INT_TO_STRING_MAP` or its owning class does not resolve, replace that single lookup's map argument with a private local `mapOf(...)` in this file (documented enum strings, `0` omitted) — do **not** change the key names or function signatures. Report any such substitution.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.MetaMappersTest"`
Expected: PASS.

- [ ] **Step 5: Wire the mappers into the four readers**

In `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`, add the import:

```kotlin
import com.android.vitalix.health.MetaMappers
```

Then attach `meta` in the four `perMetric` blocks. Blood pressure (replace the existing sample line):

```kotlin
        perMetric(cfg.includeBloodPressure, BloodPressureRecord::class) { recs ->
            recs.forEach { r ->
                val sys = r.systolic.inMillimetersOfMercury
                val dia = r.diastolic.inMillimetersOfMercury
                val b = builder(day(r.time))
                b.bpSystolic += sys; b.bpDiastolic += dia
                b.samples += HealthSample("bloodPressure", r.time.toString(), value = sys, value2 = dia, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.bloodPressureMeta(r.bodyPosition, r.measurementLocation))
            }
        }
```

Blood glucose:

```kotlin
        perMetric(cfg.includeBloodGlucose, BloodGlucoseRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.level.inMilligramsPerDeciliter
                val b = builder(day(r.time)); b.glucose += v
                b.samples += HealthSample("bloodGlucose", r.time.toString(), value = v, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.bloodGlucoseMeta(r.mealType, r.relationToMeal, r.specimenSource))
            }
        }
```

VO₂ max:

```kotlin
        perMetric(cfg.includeVO2Max, Vo2MaxRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.vo2MillilitersPerMinuteKilogram
                val b = builder(day(r.time))
                b.vo2.offer(r.time, v)
                b.samples += HealthSample("vo2Max", r.time.toString(), value = v, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.vo2MaxMeta(r.measurementMethod))
            }
        }
```

Body temperature:

```kotlin
        perMetric(cfg.includeBodyTemperature, BodyTemperatureRecord::class) { recs ->
            recs.forEach { r ->
                val v = r.temperature.inCelsius
                val b = builder(day(r.time)); b.bodyTemperature.offer(r.time, v)
                b.samples += HealthSample("bodyTemperature", r.time.toString(), value = v, source = r.origin, hcId = r.uid,
                    meta = MetaMappers.bodyTemperatureMeta(r.measurementLocation))
            }
        }
```

If any record property name (`r.bodyPosition`, `r.measurementLocation`, `r.mealType`, `r.relationToMeal`, `r.specimenSource`, `r.measurementMethod`) does not resolve against the SDK, correct it to the actual property (these are `Int` fields on the HC records) and report the correction — the `MetaMappers` call shape is unchanged.

- [ ] **Step 6: Verify the whole Android unit suite still builds + passes**

Run: `cd android && ./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL; all unit tests pass (existing + MetaMappers).

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/health/MetaMappers.kt \
        android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt \
        android/app/src/test/java/com/android/vitalix/MetaMappersTest.kt
git commit -m "feat(android): populate reading meta from HC context enums"
```

---

## Task 3: Migration — `meta jsonb` on `samples` and `records` (web)

**Files:**
- Create: `web/migrations/1722000000000_reading_meta.cjs`

**Interfaces:**
- Produces: nullable `samples.meta jsonb`, `records.meta jsonb`.

- [ ] **Step 1: Write the migration**

Create `web/migrations/1722000000000_reading_meta.cjs`:

```javascript
// Per-reading context enums (e.g. a blood-pressure reading's body position),
// captured on the granular stores only. Nullable, no backfill — historical
// readings never carried context. See src/persist.js (write) and the
// per-reading-meta design doc.
exports.up = (pgm) => {
  pgm.addColumns("samples", { meta: { type: "jsonb" } });
  pgm.addColumns("records", { meta: { type: "jsonb" } });
};

exports.down = (pgm) => {
  pgm.dropColumns("samples", ["meta"]);
  pgm.dropColumns("records", ["meta"]);
};
```

- [ ] **Step 2: Verify the migration parses**

Run: `cd web && node --check migrations/1722000000000_reading_meta.cjs`
Expected: exit 0, no output. (A live `npm run migrate` needs Postgres; run it where `DATABASE_URL` is set.)

- [ ] **Step 3: Commit**

```bash
git add web/migrations/1722000000000_reading_meta.cjs
git commit -m "feat(web): meta jsonb column on samples + records"
```

---

## Task 4: `mapPayload` carries `meta` (web)

**Files:**
- Modify: `web/src/mapPayload.js`
- Test: `web/test/mapPayload.test.js` (create if it does not exist)

**Interfaces:**
- Consumes: payload sample objects that may carry a `meta` object.
- Produces: each mapped sample gains `meta` (the object as-is, or `null`).

- [ ] **Step 1: Write the failing test**

If `web/test/mapPayload.test.js` does not exist, create it with this header; otherwise add the test and merge the import:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPayload } from "../src/mapPayload.js";

test("mapSamples passes a meta object through and defaults missing meta to null", () => {
  const mapped = mapPayload({
    days: [{
      date: "2026-07-01",
      samples: [
        { metric: "bloodPressure", start: "2026-07-01T08:00:00Z", value: 120, value2: 80,
          hcId: "bp-1", meta: { bodyPosition: "standing", measurementLocation: "left_wrist" } },
        { metric: "heartRate", start: "2026-07-01T08:01:00Z", value: 70, hcId: "hr-1" },
      ],
    }],
  });
  const samples = mapped.days[0].samples;
  const bp = samples.find((s) => s.metric === "bloodPressure");
  const hr = samples.find((s) => s.metric === "heartRate");
  assert.deepEqual(bp.meta, { bodyPosition: "standing", measurementLocation: "left_wrist" });
  assert.equal(hr.meta, null);
});
```

Note for the implementer: confirm `mapPayload`'s exact exported name and the shape it returns (`mapped.days[i].samples`) against `web/src/mapPayload.js` before finalizing the test; adapt the accessor to the real shape if it differs (the assertion — `meta` object preserved, missing `meta` → `null` — is the contract).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `bp.meta` is `undefined`, not the object.

- [ ] **Step 3: Add `meta` to `mapSamples`**

In `web/src/mapPayload.js`, in the `mapSamples` push block, add one field after `hc_id`:

```javascript
      source: r.source ?? null,
      hc_id: r.hcId ?? null,
      meta: r.meta ?? null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npm test`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add web/src/mapPayload.js web/test/mapPayload.test.js
git commit -m "feat(web): map sample meta through mapPayload"
```

---

## Task 5: `persist` writes `meta` (web)

**Files:**
- Modify: `web/src/persist.js`

**Interfaces:**
- Consumes: mapped samples with `meta` (Task 4); `meta` columns (Task 3).
- Produces: `replaceSamples` and `upsertRecords` persist `meta`.

- [ ] **Step 1: Add `meta` to the `samples` INSERT**

In `web/src/persist.js`, `replaceSamples`, extend the column list, placeholders, and values (pg serializes a plain object to jsonb; `null` binds SQL NULL):

```javascript
      "INSERT INTO samples (day_id, metric, start_at, end_at, value_num, value_secondary, value_text, source, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [dayId, s.metric, s.start_at, s.end_at, s.value_num, s.value_secondary, s.value_text, s.source, s.meta ?? null]
```

- [ ] **Step 2: Add `meta` to the `records` upsert**

In `upsertRecords`, extend the column list, placeholders, values, and the `DO UPDATE SET` clause:

```javascript
      `INSERT INTO records (user_id, type, hc_id, start_at, end_at, value_num, value_secondary, value_text, source, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, hc_id, start_at) DO UPDATE SET
         type = EXCLUDED.type, end_at = EXCLUDED.end_at, value_num = EXCLUDED.value_num,
         value_secondary = EXCLUDED.value_secondary, value_text = EXCLUDED.value_text,
         source = EXCLUDED.source, meta = EXCLUDED.meta`,
      [userId, s.metric, s.hc_id, s.start_at, s.end_at, s.value_num, s.value_secondary, s.value_text, s.source, s.meta ?? null]
```

Note: match the exact existing `DO UPDATE SET` assignments in the file (Step 2 above reproduces the current set columns plus `meta`); if the current clause differs, preserve every existing assignment and append `, meta = EXCLUDED.meta`. The placeholder for `meta` must be the next number after `source`'s.

- [ ] **Step 3: Verify the file parses and the suite passes**

Run: `cd web && node --check src/persist.js && npm test`
Expected: exit 0; all tests pass (no persist-specific unit tests; this confirms imports resolve and nothing broke).

- [ ] **Step 4: Commit**

```bash
git add web/src/persist.js
git commit -m "feat(web): persist reading meta into samples + records"
```

---

## Task 6: Render `meta` on the day-detail page (web)

**Files:**
- Modify: `web/src/routes/pages.js`
- Modify: `web/views/day.ejs`

**Interfaces:**
- Consumes: `samples.meta` (Tasks 3 & 5).
- Produces: the day-detail sample table shows a "Context" column with `meta` tags.

- [ ] **Step 1: Select `meta` in the day-detail query**

In `web/src/routes/pages.js`, the `/dashboard/:date` handler's samples query — add `meta` to the selected columns:

```javascript
      query("SELECT metric,start_at,end_at,value_num,value_secondary,value_text,source,meta FROM samples WHERE day_id=$1 ORDER BY start_at LIMIT 500", [d.id]),
```

- [ ] **Step 2: Add a "Context" column to the samples table**

In `web/views/day.ejs`, the samples table. Add the header cell (after `Source`):

```html
    <thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Value</th><th>Value 2</th><th>Text</th><th>Source</th><th>Context</th></tr></thead>
```

And render the cell inside the `samples.forEach` row (after the `source` `<td>`):

```html
        <td><%= s.source === null ? "—" : s.source %></td>
        <td><%= s.meta ? Object.values(s.meta).join(" · ") : "—" %></td>
```

(`pg` returns a `jsonb` column already parsed to a JS object, so `s.meta` is either an object or `null`.)

- [ ] **Step 3: Verify the template compiles and the suite passes**

Run:
```bash
cd web && node -e "const ejs=require('ejs');const fs=require('fs');ejs.compile(fs.readFileSync('views/day.ejs','utf8'),{});console.log('ejs compile OK')" && npm test
```
Expected: `ejs compile OK`; all tests pass.

- [ ] **Step 4: Manual verification (needs DB + a synced reading with context)**

With `DATABASE_URL` set and migrations applied, sync a blood-pressure or glucose reading that carries context, open `/dashboard/<date>`, and confirm the "Context" column shows the tags (e.g. `standing · left_wrist`); rows without context show `—`, and every other column is unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/pages.js web/views/day.ejs
git commit -m "feat(web): show per-reading context on the day-detail page"
```

---

## Task 7: Document `meta` in the ERD

**Files:**
- Modify: `docs/database-erd.md`

- [ ] **Step 1: Add `meta` to the `samples` and `records` entities**

In `docs/database-erd.md`, inside the `erDiagram` block, add a `jsonb meta` line to both the `samples` entity and the `records` entity, matching the file's existing field formatting (use `jsonb` if the file uses full type names, else follow its convention):

```
        jsonb meta "nullable; per-reading context enums"
```

- [ ] **Step 2: Note it in the table reference**

Under the `records` (and `samples`, if it has an entry) section in "## Table reference", add one line:

```markdown
`meta` (jsonb, nullable) — per-reading Health Connect context enums
(`bodyPosition`, `mealType`, `measurementMethod`, …). Populated at ingest from
the sample's `meta` object; `NULL` when the reading carries no context.
```

- [ ] **Step 3: Commit**

```bash
git add docs/database-erd.md
git commit -m "docs(web): document meta column on samples + records"
```

---

## Self-Review Notes

- **Spec coverage:** `meta` model + payload → Task 1; Android enrichment (4 records, unknown-omission rule) → Task 2; migration → Task 3; mapPayload pass-through → Task 4; persist (samples + records, re-sync refresh via DO UPDATE) → Task 5; day-detail render → Task 6; ERD → Task 7. Unit tests: ServerForwarder (Task 1), MetaMappers (Task 2), mapPayload (Task 4).
- **Contract consistency:** the `meta` key names (`bodyPosition`, `measurementLocation`, `mealType`, `relationToMeal`, `specimenSource`, `measurementMethod`) are identical in the Global Constraints table, `MetaMappers` (Task 2), and the tests. The field is `meta` everywhere: Kotlin `HealthSample.meta`, JSON `meta`, mapped sample `meta`, columns `samples.meta`/`records.meta`.
- **Backward compatibility:** `meta` defaulted/nullable at every layer; empty/absent ⇒ omitted ⇒ NULL ⇒ unchanged UI. No rollup, chart, or config changes.
- **Accepted unknowns (flagged for the implementer, not blockers):** exact HC `*_INT_TO_STRING_MAP` accessibility and HC record property names in `1.1.0-alpha07` are verified at implementation time, with a documented local-map fallback that preserves the key-name contract.

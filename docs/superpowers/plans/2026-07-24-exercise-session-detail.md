# Exercise Session Detail (5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture each exercise session's direct Health Connect detail (`end`, `exerciseType`, `notes`, `segments`, `laps`) and show it — plus a web-derived per-session distance/energy/steps total — on the day-detail page, without altering any existing exercise data.

**Architecture:** `ExerciseData` gains detail fields (segments/laps as small data classes); the reader populates them via pure `ExerciseMappers`; `ServerForwarder` serializes them (omitted when absent). Five nullable columns (`end_at`, `exercise_type`, `notes`, `segments jsonb`, `laps jsonb`) are added to `exercises` and threaded through `mapPayload`/`persist`. A new pure-shaped `stats.sessionTotals` sums the `records` store over each session window at render time. `day.ejs` grows an expanded exercises table.

**Tech Stack:** Android (Kotlin, `androidx.health.connect:connect-client:1.1.0-alpha07`, `org.json`, `kotlin.test`). Web: Node ≥20 ESM, Express, EJS, `pg`, `node-pg-migrate` (`.cjs`), `node --test`.

## Global Constraints

- Every new field is optional: absent/empty ⇒ omitted from payload ⇒ SQL `NULL`/`[]` ⇒ every existing exercise and the current day-detail view is byte-identical.
- Segments/laps are stored as `jsonb` (bounded, display-only), NOT normalized into child tables. Derived distance/energy/steps are NOT stored — computed web-side from `records`.
- Enum resolution follows the phase-1 rule: an unmapped / resolved-`"unknown"` value is omitted (here: `exercise_type`/segment `type` become `null`, never `"unknown"`).
- Derived energy uses `activeCalories` (not `totalCalories`). Totals sum across all sources in `[session.start, session.end)` — accepted double-report caveat.
- No new `ExportConfig` flag (rides the enabled Exercise metric); no new main-dashboard charts; `exerciseBreakdown` untouched. `name` stays `title ?? typeString`.
- Android commands run from `android/`; web from `web/`. Commit after each task with the message shown in its final step.

---

## File Structure

- **Modify** `android/app/src/main/java/com/android/vitalix/models/HealthData.kt` — `ExerciseData` + `ExerciseSegmentData` + `ExerciseLapData`.
- **Create** `android/app/src/main/java/com/android/vitalix/health/ExerciseMappers.kt` — pure enum/shape mappers.
- **Modify** `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt` — populate detail.
- **Modify** `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt` — serialize detail.
- **Create** `android/app/src/test/java/com/android/vitalix/ExerciseMappersTest.kt`.
- **Modify** `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`.
- **Create** `web/migrations/1722100000000_exercise_detail.cjs`.
- **Modify** `web/src/mapPayload.js`, `web/src/persist.js`, `web/src/stats.js`, `web/src/routes/pages.js`, `web/views/day.ejs`.
- **Modify/Create** `web/test/mapPayload.test.js`, `web/test/stats.test.js` (create if absent).
- **Modify** `docs/database-erd.md`.

---

## Task 1: `ExerciseData` detail fields + serialization (Android)

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`
- Test: `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`

**Interfaces:**
- Produces: `ExerciseData(..., endDateTime, exerciseType, notes, segments, laps)`; `ExerciseSegmentData(start, end, type, reps)`; `ExerciseLapData(start, end, lengthMeters)`. `ServerForwarder` emits `end`/`exerciseType`/`notes`/`segments`/`laps` on an exercise, each only when present/non-empty.

- [ ] **Step 1: Write the failing tests**

Add to `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`:

```kotlin
    @Test fun serializesExerciseDetailWhenPresent() {
        val day = DailyHealthData(
            date = "2026-07-20",
            exercises = listOf(ExerciseData(
                "2026-07-20", "2026-07-20T06:12:00Z", "Running", 32,
                source = "com.x", hcId = "ex-1",
                endDateTime = "2026-07-20T06:44:00Z", exerciseType = "running", notes = "loop",
                segments = listOf(ExerciseSegmentData("2026-07-20T06:12:00Z", "2026-07-20T06:20:00Z", "running", 0)),
                laps = listOf(ExerciseLapData("2026-07-20T06:12:00Z", "2026-07-20T06:16:00Z", 400.0))
            ))
        )
        val ex = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
            .getJSONArray("days").getJSONObject(0).getJSONArray("exercises").getJSONObject(0)
        assertEquals("2026-07-20T06:44:00Z", ex.getString("end"))
        assertEquals("running", ex.getString("exerciseType"))
        assertEquals("loop", ex.getString("notes"))
        assertEquals("running", ex.getJSONArray("segments").getJSONObject(0).getString("type"))
        assertEquals(400.0, ex.getJSONArray("laps").getJSONObject(0).getDouble("lengthMeters"), 0.001)
    }

    @Test fun omitsExerciseDetailKeysWhenAbsent() {
        val day = DailyHealthData(
            date = "2026-07-20",
            exercises = listOf(ExerciseData("2026-07-20", "2026-07-20T06:12:00Z", "Running", 32))
        )
        val ex = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
            .getJSONArray("days").getJSONObject(0).getJSONArray("exercises").getJSONObject(0)
        assertFalse(ex.has("end")); assertFalse(ex.has("exerciseType")); assertFalse(ex.has("notes"))
        assertFalse(ex.has("segments")); assertFalse(ex.has("laps"))
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: FAIL — `ExerciseSegmentData` / new `ExerciseData` params unresolved (compile error).

- [ ] **Step 3: Add the data classes**

In `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`, extend `ExerciseData` (add a trailing comma after the current last field `hcId = null`, then append) and add two small classes near it:

```kotlin
data class ExerciseData(
    val date: String,
    val startDateTime: String,
    val exerciseName: String,
    val durationMinutes: Long,
    val source: String? = null,
    val hcId: String? = null,
    val endDateTime: String? = null,
    val exerciseType: String? = null,
    val notes: String? = null,
    val segments: List<ExerciseSegmentData> = emptyList(),
    val laps: List<ExerciseLapData> = emptyList()
)

/** One Health Connect exercise segment (a typed sub-interval, e.g. a rep set). */
data class ExerciseSegmentData(val start: String, val end: String, val type: String?, val reps: Long)

/** One Health Connect exercise lap; length is meters when the source provided it. */
data class ExerciseLapData(val start: String, val end: String, val lengthMeters: Double?)
```

(Match the actual current field order/names in `ExerciseData` when adding the trailing comma; the first six fields above mirror the existing class.)

- [ ] **Step 4: Serialize detail in `ServerForwarder`**

In `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`, replace the exercises-mapping block inside `buildPayload`:

```kotlin
            if (d.exercises.isNotEmpty()) o.put("exercises", JSONArray(d.exercises.map {
                JSONObject().put("name", it.exerciseName).put("start", it.startDateTime).put("durationMinutes", it.durationMinutes)
                    .apply { it.source?.let { s -> put("source", s) }; it.hcId?.let { h -> put("hcId", h) } }
            }))
```

with:

```kotlin
            if (d.exercises.isNotEmpty()) o.put("exercises", JSONArray(d.exercises.map { ex ->
                JSONObject().put("name", ex.exerciseName).put("start", ex.startDateTime).put("durationMinutes", ex.durationMinutes)
                    .apply {
                        ex.source?.let { put("source", it) }
                        ex.hcId?.let { put("hcId", it) }
                        ex.endDateTime?.let { put("end", it) }
                        ex.exerciseType?.let { put("exerciseType", it) }
                        ex.notes?.let { put("notes", it) }
                        if (ex.segments.isNotEmpty()) put("segments", JSONArray(ex.segments.map { s ->
                            JSONObject().put("start", s.start).put("end", s.end).put("reps", s.reps)
                                .apply { s.type?.let { put("type", it) } }
                        }))
                        if (ex.laps.isNotEmpty()) put("laps", JSONArray(ex.laps.map { l ->
                            JSONObject().put("start", l.start).put("end", l.end)
                                .apply { l.lengthMeters?.let { put("lengthMeters", it) } }
                        }))
                    }
            }))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest"`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/models/HealthData.kt \
        android/app/src/main/java/com/android/vitalix/ServerForwarder.kt \
        android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt
git commit -m "feat(android): carry exercise session detail on ExerciseData + payload"
```

---

## Task 2: Pure `ExerciseMappers` + wire into the reader (Android)

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/health/ExerciseMappers.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Test: `android/app/src/test/java/com/android/vitalix/ExerciseMappersTest.kt`

**Interfaces:**
- Consumes: `ExerciseSegmentData`, `ExerciseLapData` (Task 1).
- Produces: object `ExerciseMappers` with `exerciseType(typeInt: Int): String?`, `segmentType(typeInt: Int): String?`, `segment(start: String, end: String, typeInt: Int, reps: Long): ExerciseSegmentData`, `lap(start: String, end: String, lengthMeters: Double?): ExerciseLapData`. Enum ints resolve to lower_snake strings; unknown/absent ⇒ `null` type.

- [ ] **Step 1: Write the failing tests**

Create `android/app/src/test/java/com/android/vitalix/ExerciseMappersTest.kt`:

```kotlin
package com.android.vitalix

import com.android.vitalix.health.ExerciseMappers
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ExerciseMappersTest {
    @Test fun exerciseTypeResolvesKnownAndNullsUnknown() {
        // 0 is EXERCISE_TYPE_UNKNOWN across HC -> null; a known non-zero type -> a string.
        assertNull(ExerciseMappers.exerciseType(0))
        val t = ExerciseMappers.exerciseType(56) // some known running-ish type id; any known non-zero
        // Either a non-null resolved string, or null only if this id is genuinely unmapped.
        // The contract asserted here: 0 -> null.
        assertEquals(t, ExerciseMappers.exerciseType(56))
    }

    @Test fun segmentCarriesResolvedTypeAndFields() {
        val s = ExerciseMappers.segment("2026-07-20T06:12:00Z", "2026-07-20T06:20:00Z", typeInt = 0, reps = 5)
        assertEquals("2026-07-20T06:12:00Z", s.start)
        assertEquals("2026-07-20T06:20:00Z", s.end)
        assertEquals(5L, s.reps)
        assertNull(s.type) // 0 -> unknown -> null, but the segment is still emitted
    }

    @Test fun lapCarriesFieldsAndNullableLength() {
        val a = ExerciseMappers.lap("2026-07-20T06:12:00Z", "2026-07-20T06:16:00Z", 400.0)
        assertEquals(400.0, a.lengthMeters)
        val b = ExerciseMappers.lap("2026-07-20T06:12:00Z", "2026-07-20T06:16:00Z", null)
        assertNull(b.lengthMeters)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ExerciseMappersTest"`
Expected: FAIL — `ExerciseMappers` unresolved.

- [ ] **Step 3: Implement `ExerciseMappers`**

Create `android/app/src/main/java/com/android/vitalix/health/ExerciseMappers.kt`:

```kotlin
package com.android.vitalix.health

import androidx.health.connect.client.records.ExerciseSegment
import androidx.health.connect.client.records.ExerciseSessionRecord
import com.android.vitalix.models.ExerciseSegmentData
import com.android.vitalix.models.ExerciseLapData

/**
 * Pure Health-Connect-enum → exercise-detail mappers. Kept free of HC record
 * construction so they unit-test with plain inputs. Enum resolution follows the
 * phase-1 rule: absent or "unknown"-resolved values become null (the segment/lap
 * is still emitted; only its type is dropped).
 */
object ExerciseMappers {
    private fun resolve(map: Map<Int, String>, value: Int): String? =
        map[value]?.takeIf { it != "unknown" }

    fun exerciseType(typeInt: Int): String? =
        resolve(ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP, typeInt)

    fun segmentType(typeInt: Int): String? =
        resolve(ExerciseSegment.EXERCISE_SEGMENT_TYPE_INT_TO_STRING_MAP, typeInt)

    fun segment(start: String, end: String, typeInt: Int, reps: Long): ExerciseSegmentData =
        ExerciseSegmentData(start, end, segmentType(typeInt), reps)

    fun lap(start: String, end: String, lengthMeters: Double?): ExerciseLapData =
        ExerciseLapData(start, end, lengthMeters)
}
```

Resolution rule for the implementer (same as phase-1 MetaMappers): prefer HC's public `*_INT_TO_STRING_MAP`. `ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP` is ALREADY used in `HealthConnectManager.kt`, so it resolves. If `ExerciseSegment.EXERCISE_SEGMENT_TYPE_INT_TO_STRING_MAP` (or its class) is NOT accessible in `connect-client 1.1.0-alpha07`, replace that one lookup with a private local `mapOf(...)` of the documented segment-type strings (`0` omitted) — do NOT change function signatures or the null-on-unknown behavior. Report any substitution.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ExerciseMappersTest"`
Expected: PASS.

- [ ] **Step 5: Wire into the reader**

In `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`, add the import:

```kotlin
import com.android.vitalix.health.ExerciseMappers
```

Replace the exercise `perMetric` block's `ExerciseData(...)` construction so it also passes the detail. The current block builds `name`, `durationMin`, then `ExerciseData(date, startDateTime, exerciseName, durationMinutes, source, hcId)`. Extend the constructor call:

```kotlin
        perMetric(cfg.includeExercise, ExerciseSessionRecord::class) { recs ->
            recs.forEach { r ->
                val name = r.title
                    ?: ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP[r.exerciseType]
                    ?: "unknown"
                val durationMin = ChronoUnit.MINUTES.between(r.startTime, r.endTime)
                val b = builder(day(r.startTime))
                b.exercises += ExerciseData(
                    date = day(r.startTime).toString(),
                    startDateTime = r.startTime.toString(),
                    exerciseName = name,
                    durationMinutes = durationMin,
                    source = r.origin,
                    hcId = r.uid,
                    endDateTime = r.endTime.toString(),
                    exerciseType = ExerciseMappers.exerciseType(r.exerciseType),
                    notes = r.notes?.toString(),
                    segments = r.segments.map { s ->
                        ExerciseMappers.segment(s.startTime.toString(), s.endTime.toString(), s.segmentType, s.repetitions.toLong())
                    },
                    laps = r.laps.map { l ->
                        ExerciseMappers.lap(l.startTime.toString(), l.endTime.toString(), l.length?.inMeters)
                    }
                )
            }
        }
```

(Preserve the existing `date`/`startDateTime`/`exerciseName`/`durationMinutes`/`source`/`hcId` argument values exactly as they are today; only append the five new named arguments.) If any HC property name (`r.notes`, `r.segments`, `s.segmentType`, `s.repetitions`, `r.laps`, `l.length`) does not resolve against the SDK, correct it to the actual property and report the correction — the mapper call shapes stay the same.

- [ ] **Step 6: Verify the whole Android unit suite builds + passes**

Run: `cd android && ./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL; all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/health/ExerciseMappers.kt \
        android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt \
        android/app/src/test/java/com/android/vitalix/ExerciseMappersTest.kt
git commit -m "feat(android): populate exercise session detail from HC record"
```

---

## Task 3: Migration — exercise detail columns (web)

**Files:**
- Create: `web/migrations/1722100000000_exercise_detail.cjs`

**Interfaces:**
- Produces: nullable `exercises.end_at timestamptz`, `exercise_type text`, `notes text`, `segments jsonb`, `laps jsonb`.

- [ ] **Step 1: Write the migration**

Create `web/migrations/1722100000000_exercise_detail.cjs`:

```javascript
// Direct Health Connect exercise-session detail. Nullable, no backfill —
// historical sessions were stored with name/start/duration/source only.
// Derived distance/energy/steps are computed at read time (see src/stats.js),
// not stored here. See the exercise-session-detail design doc.
exports.up = (pgm) => {
  pgm.addColumns("exercises", {
    end_at: { type: "timestamptz" },
    exercise_type: { type: "text" },
    notes: { type: "text" },
    segments: { type: "jsonb" },
    laps: { type: "jsonb" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("exercises", ["end_at", "exercise_type", "notes", "segments", "laps"]);
};
```

- [ ] **Step 2: Verify the migration parses**

Run: `cd web && node --check migrations/1722100000000_exercise_detail.cjs`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add web/migrations/1722100000000_exercise_detail.cjs
git commit -m "feat(web): exercise detail columns (end_at, type, notes, segments, laps)"
```

---

## Task 4: `mapPayload` carries exercise detail (web)

**Files:**
- Modify: `web/src/mapPayload.js`
- Test: `web/test/mapPayload.test.js`

**Interfaces:**
- Consumes: payload exercise objects that may carry `end`/`exerciseType`/`notes`/`segments`/`laps`.
- Produces: each mapped exercise gains `end_at`, `exercise_type`, `notes`, `segments`, `laps` (arrays/objects as-is, or null).

- [ ] **Step 1: Write the failing test**

Add to `web/test/mapPayload.test.js` (merge the import if `mapPayload` is already imported):

```javascript
test("mapExercises carries session detail and defaults missing fields", () => {
  const mapped = mapPayload({
    days: [{
      date: "2026-07-20",
      exercises: [
        { name: "Running", start: "2026-07-20T06:12:00Z", durationMinutes: 32, hcId: "ex-1",
          end: "2026-07-20T06:44:00Z", exerciseType: "running", notes: "loop",
          segments: [{ start: "a", end: "b", type: "running", reps: 0 }],
          laps: [{ start: "a", end: "b", lengthMeters: 400 }] },
        { name: "Walk", start: "2026-07-20T18:00:00Z", durationMinutes: 10, hcId: "ex-2" },
      ],
    }],
  });
  const ex = mapped.days[0].exercises;
  const run = ex.find((e) => e.name === "Running");
  const walk = ex.find((e) => e.name === "Walk");
  assert.equal(run.end_at, "2026-07-20T06:44:00Z");
  assert.equal(run.exercise_type, "running");
  assert.equal(run.notes, "loop");
  assert.deepEqual(run.segments, [{ start: "a", end: "b", type: "running", reps: 0 }]);
  assert.deepEqual(run.laps, [{ start: "a", end: "b", lengthMeters: 400 }]);
  assert.equal(walk.end_at, null);
  assert.equal(walk.exercise_type, null);
  assert.equal(walk.segments, null);
});
```

Confirm `mapPayload`'s exported name and `mapped.days[i].exercises` shape against the file; adapt the accessor if it differs (the contract — detail preserved, missing → null — holds).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `run.end_at` is `undefined`.

- [ ] **Step 3: Extend `mapExercises`**

In `web/src/mapPayload.js`, `mapExercises`, add the five fields to the mapped object:

```javascript
function mapExercises(day) {
  return (Array.isArray(day.exercises) ? day.exercises : []).map((e) => ({
    name: e.name ?? null,
    start_at: e.start ?? null,
    duration_minutes: e.durationMinutes ?? null,
    source: e.source ?? null,
    hc_id: e.hcId ?? null,
    end_at: e.end ?? null,
    exercise_type: e.exerciseType ?? null,
    notes: e.notes ?? null,
    segments: e.segments ?? null,
    laps: e.laps ?? null,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/mapPayload.js web/test/mapPayload.test.js
git commit -m "feat(web): map exercise session detail through mapPayload"
```

---

## Task 5: `persist` writes exercise detail (web)

**Files:**
- Modify: `web/src/persist.js`

**Interfaces:**
- Consumes: mapped exercises with detail (Task 4); columns (Task 3).
- Produces: `replaceExercises` writes the five new columns in both the no-`hc_id` insert and the `hc_id` upsert (incl. `DO UPDATE SET`).

- [ ] **Step 1: Extend the no-`hc_id` insert**

In `web/src/persist.js`, `replaceExercises`, the `withoutId` insert:

```javascript
      await client.query(
        "INSERT INTO exercises (day_id, name, start_at, duration_minutes, source, end_at, exercise_type, notes, segments, laps) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [dayId, e.name, e.start_at, e.duration_minutes, e.source, e.end_at ?? null, e.exercise_type ?? null, e.notes ?? null, e.segments ?? null, e.laps ?? null]
      );
```

- [ ] **Step 2: Extend the `hc_id` upsert**

The `withId` upsert — add the columns, placeholders, values, and `DO UPDATE SET` assignments:

```javascript
    await client.query(
      `INSERT INTO exercises (day_id, name, start_at, duration_minutes, source, hc_id, end_at, exercise_type, notes, segments, laps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (day_id, hc_id) DO UPDATE SET
         name = EXCLUDED.name, start_at = EXCLUDED.start_at,
         duration_minutes = EXCLUDED.duration_minutes, source = EXCLUDED.source,
         end_at = EXCLUDED.end_at, exercise_type = EXCLUDED.exercise_type,
         notes = EXCLUDED.notes, segments = EXCLUDED.segments, laps = EXCLUDED.laps`,
      [dayId, e.name, e.start_at, e.duration_minutes, e.source, e.hc_id, e.end_at ?? null, e.exercise_type ?? null, e.notes ?? null, e.segments ?? null, e.laps ?? null]
    );
```

Preserve the existing four `DO UPDATE SET` assignments exactly; only append the five new ones. Confirm placeholder numbering against the real file before finalizing.

- [ ] **Step 3: Verify parse + suite**

Run: `cd web && node --check src/persist.js && npm test`
Expected: exit 0; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/persist.js
git commit -m "feat(web): persist exercise session detail"
```

---

## Task 6: Derived session totals (`stats.js`) + route wiring (web)

**Files:**
- Modify: `web/src/stats.js`
- Modify: `web/src/routes/pages.js`
- Test: `web/test/stats.test.js` (create if absent)

**Interfaces:**
- Produces (stats.js): `shapeSessionTotals(rows: Array<{type, total}>) → { distance, activeEnergy, steps }` (pure); `sessionTotals(userId, startAt, endAt) → Promise<{distance, activeEnergy, steps}>`.
- Consumes (pages.js): `sessionTotals` attached per exercise on `/dashboard/:date`.

- [ ] **Step 1: Write the failing pure-shaper test**

Create/extend `web/test/stats.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeSessionTotals } from "../src/stats.js";

test("shapeSessionTotals maps summed record rows to named totals", () => {
  const t = shapeSessionTotals([
    { type: "distance", total: 5200 },
    { type: "activeCalories", total: 310 },
    { type: "steps", total: 6400 },
  ]);
  assert.equal(t.distance, 5200);
  assert.equal(t.activeEnergy, 310);
  assert.equal(t.steps, 6400);
});

test("shapeSessionTotals leaves absent metrics null", () => {
  const t = shapeSessionTotals([{ type: "steps", total: 100 }]);
  assert.equal(t.steps, 100);
  assert.equal(t.distance, null);
  assert.equal(t.activeEnergy, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `shapeSessionTotals is not a function`.

- [ ] **Step 3: Implement the shaper + query**

Append to `web/src/stats.js`:

```javascript
/** Maps `[{type, total}]` rows from sessionTotals' query into named totals. */
export function shapeSessionTotals(rows) {
  const by = new Map(rows.map((r) => [r.type, r.total == null ? null : Number(r.total)]));
  return {
    distance: by.get("distance") ?? null,
    activeEnergy: by.get("activeCalories") ?? null,
    steps: by.get("steps") ?? null,
  };
}

/**
 * Per-session distance/activeEnergy/steps, summed from the granular records
 * store over the session window [startAt, endAt). Not stored — the records
 * carry source and timestamp, so this stays a read-time derivation. Sums across
 * all sources (double-report caveat); energy uses activeCalories.
 */
export async function sessionTotals(userId, startAt, endAt) {
  const { rows } = await query(
    `SELECT type, sum(value_num) AS total
       FROM records
      WHERE user_id = $1
        AND type = ANY(ARRAY['distance','activeCalories','steps']::text[])
        AND start_at >= $2 AND start_at < $3
      GROUP BY type`,
    [userId, startAt, endAt]
  );
  return shapeSessionTotals(rows);
}
```

- [ ] **Step 4: Wire into the day-detail route**

In `web/src/routes/pages.js`, the `/dashboard/:date` handler. First, add `end_at,exercise_type,notes,segments,laps` to the exercises SELECT:

```javascript
      query("SELECT name,start_at,duration_minutes,source,end_at,exercise_type,notes,segments,laps FROM exercises WHERE day_id=$1", [d.id]),
```

Then, after the `Promise.all` that yields `[aggs, samples, ex]`, attach totals to each exercise (guard on `end_at` — a session with no end can't derive a window):

```javascript
    const exercises = await Promise.all(ex.rows.map(async (e) => ({
      ...e,
      totals: e.end_at ? await stats.sessionTotals(req.user.id, e.start_at, e.end_at) : null,
    })));
```

and pass `exercises` (this new array) into `res.render("day", { … exercises, … })` in place of `ex.rows`. Confirm the exact current `res.render("day", {...})` argument list and swap only the `exercises` value.

- [ ] **Step 5: Verify parse + suite**

Run: `cd web && node --check src/stats.js && node --check src/routes/pages.js && npm test`
Expected: exit 0; all tests pass (including the two new shaper tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/stats.js web/src/routes/pages.js web/test/stats.test.js
git commit -m "feat(web): derive per-session distance/energy/steps for day detail"
```

---

## Task 7: Expanded exercises table (`day.ejs`)

**Files:**
- Modify: `web/views/day.ejs`

**Interfaces:**
- Consumes: exercise rows with `end_at`, `exercise_type`, `notes`, `segments`, `laps`, `totals` (Task 6).

- [ ] **Step 1: Replace the exercises table**

In `web/views/day.ejs`, replace the exercises table block:

```html
  <table>
    <thead><tr><th>Name</th><th>Start</th><th>Duration (min)</th><th>Source</th></tr></thead>
    <tbody>
    <% exercises.forEach(function(ex) { %>
      <tr><td><%= ex.name %></td><td><%= ex.start_at %></td><td><%= ex.duration_minutes %></td><td><%= ex.source === null ? "—" : ex.source %></td></tr>
    <% }); %>
    </tbody>
  </table>
```

with:

```html
  <table>
    <thead><tr>
      <th>Name</th><th>Type</th><th>Start</th><th>End</th><th>Duration (min)</th>
      <th>Distance (km)</th><th>Energy (kcal)</th><th>Steps</th><th>Notes</th><th>Detail</th><th>Source</th>
    </tr></thead>
    <tbody>
    <% exercises.forEach(function(ex) {
         var t = ex.totals || {};
         var km = (t.distance == null) ? null : (t.distance / 1000);
         var segs = ex.segments || []; var laps = ex.laps || [];
    %>
      <tr>
        <td><%= ex.name %></td>
        <td><%= ex.exercise_type === null || ex.exercise_type === undefined ? "—" : ex.exercise_type %></td>
        <td><%= ex.start_at %></td>
        <td><%= ex.end_at === null || ex.end_at === undefined ? "—" : ex.end_at %></td>
        <td><%= ex.duration_minutes %></td>
        <td><%= km === null ? "—" : km.toFixed(2) %></td>
        <td><%= t.activeEnergy == null ? "—" : Math.round(t.activeEnergy) %></td>
        <td><%= t.steps == null ? "—" : Math.round(t.steps) %></td>
        <td><%= ex.notes === null || ex.notes === undefined ? "—" : ex.notes %></td>
        <td>
          <% if (segs.length || laps.length) { %>
            <details>
              <summary><%= segs.length %> seg · <%= laps.length %> laps</summary>
              <% segs.forEach(function(s) { %>
                <div class="detail-row">seg <%= s.type || "—" %>: <%= s.start %> → <%= s.end %><%= s.reps ? " ×" + s.reps : "" %></div>
              <% }); %>
              <% laps.forEach(function(l) { %>
                <div class="detail-row">lap: <%= l.start %> → <%= l.end %><%= l.lengthMeters != null ? " (" + l.lengthMeters + " m)" : "" %></div>
              <% }); %>
            </details>
          <% } else { %>—<% } %>
        </td>
        <td><%= ex.source === null ? "—" : ex.source %></td>
      </tr>
    <% }); %>
    </tbody>
  </table>
```

- [ ] **Step 2: Add a small style for the detail rows**

In `day.ejs`'s `<style>` block, add:

```css
.detail-row{font-size:12px;color:#64748b;margin:2px 0}
details summary{cursor:pointer}
```

- [ ] **Step 3: Verify the template compiles and the suite passes**

Run:
```bash
cd web && node -e "const ejs=require('ejs');const fs=require('fs');ejs.compile(fs.readFileSync('views/day.ejs','utf8'),{});console.log('ejs compile OK')" && npm test
```
Expected: `ejs compile OK`; all tests pass.

- [ ] **Step 4: Manual verification (needs DB + a synced exercise with detail)**

With Postgres up and migrations applied, sync an exercise session (with type/segments/laps and overlapping distance/steps/calories records), open `/dashboard/<date>`, and confirm the exercises table shows Type/End/Distance/Energy/Steps/Notes and an expandable Detail cell; a bare session (no detail) shows `—` in the new columns and the table is otherwise unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/views/day.ejs
git commit -m "feat(web): expanded exercise detail on the day-detail page"
```

---

## Task 8: Document the new columns in the ERD

**Files:**
- Modify: `docs/database-erd.md`

- [ ] **Step 1: Add the columns to the `exercises` entity**

In `docs/database-erd.md`, inside the `erDiagram` block's `exercises` entity, add lines (match the file's existing field formatting/type tokens):

```
        timestamptz end_at "nullable"
        text exercise_type "nullable"
        text notes "nullable"
        jsonb segments "nullable; [{start,end,type,reps}]"
        jsonb laps "nullable; [{start,end,lengthMeters}]"
```

- [ ] **Step 2: Note it in the table reference**

Under the `exercises` section of "## Table reference" (or add one if absent), add:

```markdown
`end_at`, `exercise_type`, `notes`, `segments` (jsonb), `laps` (jsonb) —
direct Health Connect session detail. Per-session distance/energy/steps are
**not** stored; they are derived at read time by `stats.sessionTotals` from the
`records` store over the session window.
```

- [ ] **Step 3: Commit**

```bash
git add docs/database-erd.md
git commit -m "docs(web): document exercise detail columns"
```

---

## Self-Review Notes

- **Spec coverage:** model + serialization → Task 1; reader population (type/notes/segments/laps, unknown-omission) → Task 2; migration → Task 3; mapPayload → Task 4; persist (both paths + DO UPDATE SET) → Task 5; derived totals + route → Task 6; day-detail render → Task 7; ERD → Task 8. Unit tests: ServerForwarder (1), ExerciseMappers (2), mapPayload (4), shapeSessionTotals (6).
- **Naming consistency:** `ExerciseSegmentData{start,end,type,reps}` / `ExerciseLapData{start,end,lengthMeters}` are identical in the model, mappers, ServerForwarder, payload, mapPayload, and day.ejs. Web columns `end_at`/`exercise_type`/`notes`/`segments`/`laps` match across migration, mapPayload, persist, route SELECT, and ERD. Derived keys `distance`/`activeEnergy`/`steps` match between `shapeSessionTotals`, `sessionTotals`, route, and day.ejs.
- **Backward compatibility:** all fields optional/nullable; a detail-less exercise is byte-identical end to end. Derived totals additive display only.
- **Accepted caveats (flagged, not blockers):** derived totals sum across all sources; window matched by `start_at`; exact HC segment-type map / property names resolved at implementation time with a documented local-map fallback that preserves signatures and key names.
```

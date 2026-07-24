# Granular Record Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every Health Connect reading at native time-granularity as the server's idempotent source of truth, so the web can re-aggregate to any bucket later.

**Architecture:** Android stamps each reading with its Health Connect record UID (`metadata.id`). The server keeps its current day-rollup pipeline untouched and, in parallel, upserts every reading into a new `records` table keyed on `(user_id, hc_id, start_at)`. A new `/api/records` endpoint derives buckets (raw/minute/hour/day/week) in SQL via a metric→aggregation catalog.

**Tech Stack:** Kotlin / Android (`android/`), Node ESM + Express + Postgres, `node-pg-migrate`, `node:test`.

## Global Constraints

- Android project root: `android/` — Gradle wrapper, `compileSdk 36`, Java 11. Build with `./gradlew assembleDebug`; unit tests `./gradlew testDebugUnitTest`.
- Web project root: `web/` — Node ESM (`"type": "module"`), `node --test`. Migrations are `.cjs` under `web/migrations/` (node-pg-migrate).
- Payload field for the record UID is `hcId` (camelCase) in JSON; DB column is `hc_id`.
- **Non-breaking:** do not alter `health_days`, `day_aggregates`, the existing `samples` table, or the current dashboard. `records` is additive.
- Existing rollups are computed on the phone and shipped; only `records` is the new re-aggregatable source.
- Component boundaries: `HealthConnectManager` knows only Health Connect; the records query layer knows only SQL + the aggregation catalog.

---

### Task 1: Android — capture the Health Connect record UID

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- Modify: `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`
- Test: `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`

**Interfaces:**
- Produces: `HealthSample(..., source: String?, hcId: String?)` and `ExerciseData(..., source: String?, hcId: String?)`; payload sample/exercise JSON gains an `hcId` field when non-null.

- [ ] **Step 1: Write the failing test**

Add to `ServerForwarderTest.kt`:

```kotlin
@Test fun serializesHcIdOnSampleAndExercise() {
    val day = DailyHealthData(
        date = "2026-07-20",
        exercises = listOf(ExerciseData("2026-07-20", "2026-07-20T06:12:00Z", "Running", 32, source = "com.x", hcId = "ex-uid-1")),
        samples = listOf(HealthSample("heartRate", "2026-07-20T10:04:12Z", value = 68.0, source = "com.x", hcId = "hr-uid-1"))
    )
    val json = JSONObject(ServerForwarder.buildPayload(listOf(day), PayloadMeta("1.0.0", "d", 1)))
    val d0 = json.getJSONArray("days").getJSONObject(0)
    assertEquals("hr-uid-1", d0.getJSONArray("samples").getJSONObject(0).getString("hcId"))
    assertEquals("ex-uid-1", d0.getJSONArray("exercises").getJSONObject(0).getString("hcId"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest.serializesHcIdOnSampleAndExercise"`
Expected: FAIL — compile error (`hcId` is not a parameter of `HealthSample`/`ExerciseData`).

- [ ] **Step 3: Add the `hcId` field to both models**

In `models/HealthData.kt`, add `hcId` as the last constructor parameter of both data classes:

```kotlin
data class ExerciseData(
    val date: String,
    val startDateTime: String,
    val exerciseName: String,
    val durationMinutes: Long,
    /** Health Connect package that wrote the record (the originating app). */
    val source: String? = null,
    /** Health Connect record UID (metadata.id), for idempotent server storage. */
    val hcId: String? = null
)
```

```kotlin
data class HealthSample(
    val metric: String,
    val start: String,
    val end: String? = null,
    val value: Double? = null,
    val value2: Double? = null,
    val text: String? = null,
    /** Health Connect package that wrote the record (the originating app). */
    val source: String? = null,
    /** Health Connect record UID (metadata.id), for idempotent server storage. */
    val hcId: String? = null
)
```

- [ ] **Step 4: Serialize `hcId` in `ServerForwarder`**

In `ServerForwarder.kt`, add to `sampleJson`:

```kotlin
        s.source?.let { put("source", it) }
        s.hcId?.let { put("hcId", it) }
```

And in the exercises `.map { … }` block, after the source line:

```kotlin
                JSONObject().put("name", it.exerciseName).put("start", it.startDateTime).put("durationMinutes", it.durationMinutes)
                    .apply { it.source?.let { s -> put("source", s) }; it.hcId?.let { h -> put("hcId", h) } }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd android && ./gradlew testDebugUnitTest --tests "com.android.vitalix.ServerForwarderTest.serializesHcIdOnSampleAndExercise"`
Expected: PASS.

- [ ] **Step 6: Populate `hcId` from every record in `HealthConnectManager`**

Add a second extension property beside the existing `Record.origin`:

```kotlin
    /** Health Connect record UID — stable per record; blank collapses to null. */
    private val Record.uid: String? get() = metadata.id.ifBlank { null }
```

Then append `, hcId = r.uid` to **every** `HealthSample(...)` construction and to the `ExerciseData(...)` construction (right after the `source = r.origin` argument). For the nested-sample loops (heartRate, power, speed) and sleep stages, use the parent record's `r.uid` — the same `r` already used for `source`. Example for steps:

```kotlin
                b.samples += HealthSample("steps", r.startTime.toString(), r.endTime.toString(), value = r.count.toDouble(), source = r.origin, hcId = r.uid)
```

- [ ] **Step 7: Build and run the full Android unit suite**

Run: `cd android && ./gradlew testDebugUnitTest`
Expected: PASS. Then `./gradlew assembleDebug` — Expected: BUILD SUCCESSFUL.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/models/HealthData.kt \
        android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt \
        android/app/src/main/java/com/android/vitalix/ServerForwarder.kt \
        android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt
git commit -m "feat(android): stamp each reading with its Health Connect record UID"
```

---

### Task 2: Web — migration for `records` table and exercise identity

**Files:**
- Create: `web/migrations/1721800000000_records.cjs`

**Interfaces:**
- Produces: table `records(id, user_id, type, hc_id, start_at, end_at, value_num, value_secondary, value_text, source, received_at)` with `UNIQUE(user_id, hc_id, start_at)` and index `(user_id, type, start_at)`; column `exercises.hc_id` with `UNIQUE(day_id, hc_id)`.

- [ ] **Step 1: Write the migration**

Create `web/migrations/1721800000000_records.cjs`:

```js
// Raw per-reading storage: every Health Connect record at native granularity,
// keyed on its record UID so re-syncs and overlapping backfill windows upsert
// instead of duplicating. Parallel source of truth to the day rollups.
exports.up = (pgm) => {
  pgm.createTable("records", {
    id: "bigserial",
    user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" },
    type: { type: "text", notNull: true },
    hc_id: { type: "text", notNull: true },
    start_at: { type: "timestamptz", notNull: true },
    end_at: { type: "timestamptz" },
    value_num: { type: "double precision" },
    value_secondary: { type: "double precision" },
    value_text: { type: "text" },
    source: { type: "text" },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("records", "records_pkey", { primaryKey: "id" });
  pgm.addConstraint("records", "records_identity", { unique: ["user_id", "hc_id", "start_at"] });
  pgm.createIndex("records", ["user_id", "type", "start_at"]);

  pgm.addColumn("exercises", { hc_id: { type: "text" } });
  pgm.addConstraint("exercises", "exercises_identity", { unique: ["day_id", "hc_id"] });
};

exports.down = (pgm) => {
  pgm.dropConstraint("exercises", "exercises_identity");
  pgm.dropColumn("exercises", "hc_id");
  pgm.dropTable("records");
};
```

- [ ] **Step 2: Syntax-check the migration**

Run: `cd web && node --check migrations/1721800000000_records.cjs`
Expected: no output (valid).

- [ ] **Step 3: Apply it against a local Postgres**

Run:
```bash
cd web && docker compose up -d db && sleep 4 && npm run migrate up
```
Expected: migration `1721800000000_records` reported as applied. Verify schema:
```bash
docker compose exec -T db psql -U vitalix -d vitalix -c "\d records" -c "\d exercises"
```
Expected: `records` shows the columns above with `records_identity` UNIQUE; `exercises` now has `hc_id` + `exercises_identity` UNIQUE.

- [ ] **Step 4: Commit**

```bash
git add web/migrations/1721800000000_records.cjs
git commit -m "feat(web): add records table and exercise record identity"
```

---

### Task 3: Web — carry `hc_id` through `mapPayload`

**Files:**
- Modify: `web/src/mapPayload.js`
- Test: `web/test/mapPayload.test.js`

**Interfaces:**
- Consumes: payload samples/exercises with optional `hcId`.
- Produces: mapped sample objects gain `hc_id`; mapped exercise objects gain `hc_id`.

- [ ] **Step 1: Write the failing test**

Add to `web/test/mapPayload.test.js`. First give the existing heartRate sample and the exercise an `hcId` in the shared `payload` fixture:

```js
        { metric: "heartRate", start: "2026-07-20T10:04:12Z", value: 68, source: "com.samsung.health", hcId: "hr-1" },
```
```js
      exercises: [{ name: "Running", start: "2026-07-20T06:12:00Z", durationMinutes: 32, source: "com.google.android.apps.fitness", hcId: "ex-1" }],
```

Then add a test:

```js
test("carries hc_id through samples and exercises", () => {
  const { days } = mapPayload(payload);
  const hr = days[0].samples.find((s) => s.metric === "heartRate");
  assert.equal(hr.hc_id, "hr-1");
  const steps = days[0].samples.find((s) => s.metric === "steps");
  assert.equal(steps.hc_id, null); // absent hcId maps to null
  assert.equal(days[0].exercises[0].hc_id, "ex-1");
});
```

Also update the two existing `deepEqual` assertions to include the new key:
- heartRate sample deepEqual: add `, hc_id: "hr-1"` at the end of the expected object.
- exercise deepEqual: add `, hc_id: "ex-1"` at the end.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --test test/mapPayload.test.js`
Expected: FAIL — `hr.hc_id` is `undefined`, deepEqual mismatch.

- [ ] **Step 3: Add `hc_id` to the mappers**

In `mapPayload.js`, `mapSamples` push block, after `source`:

```js
      source: r.source ?? null,
      hc_id: r.hcId ?? null,
```

In `mapExercises` return object, after `source`:

```js
    source: e.source ?? null,
    hc_id: e.hcId ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && node --test test/mapPayload.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/mapPayload.js web/test/mapPayload.test.js
git commit -m "feat(web): carry Health Connect record UID through payload mapping"
```

---

### Task 4: Web — upsert readings into `records` (idempotent persist)

**Files:**
- Modify: `web/src/persist.js`

**Interfaces:**
- Consumes: `mapped.days[].samples[]` with `hc_id`, `mapped.days[].exercises[]` with `hc_id`, `userId`.
- Produces: `records` rows (upserted); `exercises` upserted on `(day_id, hc_id)`. `persist` return value gains `records` count.

- [ ] **Step 1: Upsert samples into `records`**

In `persist.js`, add a helper:

```js
async function upsertRecords(client, userId, samples) {
  let n = 0;
  for (const s of samples) {
    if (!s.hc_id) continue; // older app builds without a UID: keep out of records
    await client.query(
      `INSERT INTO records (user_id, type, hc_id, start_at, end_at, value_num, value_secondary, value_text, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, hc_id, start_at) DO UPDATE SET
         type = EXCLUDED.type, end_at = EXCLUDED.end_at, value_num = EXCLUDED.value_num,
         value_secondary = EXCLUDED.value_secondary, value_text = EXCLUDED.value_text, source = EXCLUDED.source`,
      [userId, s.metric, s.hc_id, s.start_at, s.end_at, s.value_num, s.value_secondary, s.value_text, s.source]
    );
    n++;
  }
  return n;
}
```

- [ ] **Step 2: Make `replaceExercises` idempotent on `hc_id`**

Replace the body of `replaceExercises` so exercises with a `hc_id` upsert rather than delete-replace (rows without a `hc_id` fall back to the old delete-then-insert to preserve current behavior):

```js
async function replaceExercises(client, dayId, exercises) {
  const withId = exercises.filter((e) => e.hc_id);
  const withoutId = exercises.filter((e) => !e.hc_id);
  // Legacy path for UID-less rows: clear only those we would re-insert blind.
  if (withoutId.length) {
    await client.query("DELETE FROM exercises WHERE day_id = $1 AND hc_id IS NULL", [dayId]);
    for (const e of withoutId) {
      await client.query(
        "INSERT INTO exercises (day_id, name, start_at, duration_minutes, source) VALUES ($1,$2,$3,$4,$5)",
        [dayId, e.name, e.start_at, e.duration_minutes, e.source]
      );
    }
  }
  for (const e of withId) {
    await client.query(
      `INSERT INTO exercises (day_id, name, start_at, duration_minutes, source, hc_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (day_id, hc_id) DO UPDATE SET
         name = EXCLUDED.name, start_at = EXCLUDED.start_at,
         duration_minutes = EXCLUDED.duration_minutes, source = EXCLUDED.source`,
      [dayId, e.name, e.start_at, e.duration_minutes, e.source, e.hc_id]
    );
  }
}
```

- [ ] **Step 3: Call `upsertRecords` in the transaction and count it**

In `persist`, inside the `for (const day of mapped.days)` loop, after `replaceExercises(...)`:

```js
      records += await upsertRecords(client, userId, day.samples);
```
Declare `let records = 0;` next to `let samples = 0, exercises = 0;` and add `records` to the returned object: `return { days: mapped.days.length, samples, exercises, records };`.

- [ ] **Step 4: Syntax-check**

Run: `cd web && node --check src/persist.js`
Expected: no output.

- [ ] **Step 5: Integration check against local Postgres (idempotency)**

With the db from Task 2 running and migrated, run this one-off script (create `web/scripts/_check_records.mjs`, run it, then delete it):

```js
import { persist } from "../src/persist.js";
import { mapPayload } from "../src/mapPayload.js";
import { query, pool } from "../src/db.js";

const { rows: u } = await query(
  "INSERT INTO users (email, password_hash) VALUES ('rec-check@x.dev','x') ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id"
);
const userId = u[0].id;
const body = { source: "vitalix", days: [{ date: "2026-07-20",
  samples: [{ metric: "heartRate", start: "2026-07-20T10:00:00Z", value: 60, hcId: "hr-x" }] }] };
await persist(userId, mapPayload(body));
await persist(userId, mapPayload(body)); // same payload twice
const { rows } = await query("SELECT count(*)::int AS n FROM records WHERE user_id=$1 AND hc_id='hr-x'", [userId]);
console.log("record rows for hr-x:", rows[0].n, rows[0].n === 1 ? "OK (idempotent)" : "FAIL (duplicated)");
await pool.end();
```

Run: `cd web && DATABASE_URL=postgres://vitalix:vitalix@localhost:5432/vitalix node scripts/_check_records.mjs`
Expected: `record rows for hr-x: 1 OK (idempotent)`. Then `rm scripts/_check_records.mjs`.

- [ ] **Step 6: Run the web unit suite (must still pass)**

Run: `cd web && npm test`
Expected: all tests pass (no DB dependency in the unit suite).

- [ ] **Step 7: Commit**

```bash
git add web/src/persist.js
git commit -m "feat(web): upsert readings into records for idempotent granular storage"
```

---

### Task 5: Web — records aggregation module and `/api/records` endpoint

**Files:**
- Create: `web/src/records.js`
- Test: `web/test/records.test.js`
- Modify: `web/src/routes/health.js`

**Interfaces:**
- Consumes: `records` table.
- Produces: `aggregationFor(type)`, `BUCKETS`, `buildRecordsQuery({ userId, from, to, types, bucket })` from `records.js`; route `GET /api/records`.

- [ ] **Step 1: Write the failing test**

Create `web/test/records.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregationFor, BUCKETS, buildRecordsQuery } from "../src/records.js";

test("catalog maps types to aggregation rules", () => {
  assert.equal(aggregationFor("steps"), "sum");
  assert.equal(aggregationFor("heartRate"), "minmaxavg");
  assert.equal(aggregationFor("weight"), "last");
  assert.equal(aggregationFor("menstruation"), "text");
  assert.equal(aggregationFor("somethingNew"), "minmaxavg"); // safe default
});

test("bucket allowlist", () => {
  assert.ok(BUCKETS.has("hour"));
  assert.ok(!BUCKETS.has("year"));
});

test("rejects an unknown bucket (no SQL injection surface)", () => {
  assert.throws(() => buildRecordsQuery({ userId: 1, from: "a", to: "b", bucket: "day; DROP TABLE records" }),
    /invalid bucket/);
});

test("raw bucket selects rows without grouping", () => {
  const q = buildRecordsQuery({ userId: 1, from: "2026-07-01", to: "2026-07-31", bucket: "raw" });
  assert.match(q.text, /FROM records/);
  assert.doesNotMatch(q.text, /date_trunc/);
  assert.deepEqual(q.values.slice(0, 3), [1, "2026-07-01", "2026-07-31"]);
});

test("hour bucket groups with date_trunc and aggregates", () => {
  const q = buildRecordsQuery({ userId: 1, from: "2026-07-01", to: "2026-07-31", bucket: "hour" });
  assert.match(q.text, /date_trunc\('hour'/);
  assert.match(q.text, /GROUP BY/);
});

test("types filter is parameterized when provided", () => {
  const q = buildRecordsQuery({ userId: 1, from: "a", to: "b", bucket: "day", types: ["steps", "heartRate"] });
  assert.match(q.text, /type = ANY/);
  assert.deepEqual(q.values.at(-1), ["steps", "heartRate"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --test test/records.test.js`
Expected: FAIL — cannot find module `../src/records.js`.

- [ ] **Step 3: Implement `records.js`**

Create `web/src/records.js`:

```js
// Derives bucketed series from the raw `records` table. Pure query building +
// the metric->aggregation catalog, kept free of the DB client so it is
// unit-testable without Postgres.

const SUM = ["steps", "distance", "activeCalories", "totalCalories", "floorsClimbed",
  "elevationGained", "wheelchairPushes", "hydration", "nutrition"];
const LAST = ["weight", "bodyFat", "boneMass", "height", "leanBodyMass", "restingHeartRate"];
const TEXT = ["menstruation", "cervicalMucus", "ovulationTest", "sexualActivity", "sleepStage"];
// Everything else (heartRate, hrv, spo2, bloodGlucose, respiratoryRate,
// bloodPressure, power, speed, bodyTemperature, vo2Max) is a distribution.

const RULES = new Map();
for (const t of SUM) RULES.set(t, "sum");
for (const t of LAST) RULES.set(t, "last");
for (const t of TEXT) RULES.set(t, "text");

/** Aggregation rule for a metric type; unknown types default to a distribution. */
export function aggregationFor(type) {
  return RULES.get(type) ?? "minmaxavg";
}

/** date_trunc units we allow; also the API's `bucket` allowlist. `raw` is ungrouped. */
export const BUCKETS = new Set(["raw", "minute", "hour", "day", "week"]);

const RAW_LIMIT = 5000;

/**
 * Builds a parameterized query for GET /api/records.
 * @returns {{ text: string, values: any[] }}
 */
export function buildRecordsQuery({ userId, from, to, types, bucket }) {
  if (!BUCKETS.has(bucket)) throw new Error(`invalid bucket: ${bucket}`);
  const values = [userId, from, to];
  let typeClause = "";
  if (Array.isArray(types) && types.length) {
    values.push(types);
    typeClause = ` AND type = ANY($${values.length})`;
  }
  const where = `WHERE user_id = $1 AND start_at >= $2 AND start_at < $3${typeClause}`;

  if (bucket === "raw") {
    return {
      text: `SELECT type, hc_id, start_at, end_at, value_num, value_secondary, value_text, source
             FROM records ${where} ORDER BY start_at LIMIT ${RAW_LIMIT}`,
      values,
    };
  }
  // date_trunc unit is from the validated allowlist above, never user text.
  return {
    text: `SELECT type,
                  date_trunc('${bucket}', start_at) AS bucket_start,
                  count(*)::int AS count,
                  sum(value_num) AS sum,
                  min(value_num) AS min,
                  max(value_num) AS max,
                  avg(value_num) AS avg,
                  (array_agg(value_num ORDER BY start_at DESC))[1] AS last,
                  (array_agg(value_text ORDER BY start_at DESC))[1] AS last_text
           FROM records ${where}
           GROUP BY type, bucket_start
           ORDER BY bucket_start, type`,
    values,
  };
}

/** Picks the fields that matter for a type's rule, so the API response is lean. */
export function shapeBucketRow(row) {
  const rule = aggregationFor(row.type);
  const base = { type: row.type, bucket_start: row.bucket_start, count: row.count };
  if (rule === "sum") return { ...base, sum: row.sum };
  if (rule === "last") return { ...base, last: row.last };
  if (rule === "text") return { ...base, last_text: row.last_text };
  return { ...base, min: row.min, max: row.max, avg: row.avg };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && node --test test/records.test.js`
Expected: PASS.

- [ ] **Step 5: Add the route**

In `web/src/routes/health.js`, add the import at the top:

```js
import { buildRecordsQuery, shapeBucketRow, BUCKETS } from "../records.js";
```

And add the route after `/api/days/:date`:

```js
router.get("/api/records", requireAuth, async (req, res) => {
  const bucket = req.query.bucket || "day";
  if (!BUCKETS.has(bucket)) return res.status(400).json({ error: `bucket must be one of ${[...BUCKETS].join(", ")}` });
  const to = req.query.to || new Date().toISOString();
  const from = req.query.from || new Date(Date.now() - 6 * 864e5).toISOString();
  const types = typeof req.query.types === "string" && req.query.types.length
    ? req.query.types.split(",") : null;
  try {
    const q = buildRecordsQuery({ userId: req.user.id, from, to, types, bucket });
    const { rows } = await query(q.text, q.values);
    res.json(bucket === "raw" ? { bucket, rows, truncated: rows.length === 5000 }
                              : { bucket, rows: rows.map(shapeBucketRow) });
  } catch (err) {
    console.error("records query failed", err);
    res.status(500).json({ error: "records query failed" });
  }
});
```

- [ ] **Step 6: Syntax-check and run the full web suite**

Run: `cd web && node --check src/routes/health.js && npm test`
Expected: no syntax errors; all tests pass.

- [ ] **Step 7: End-to-end check against local Postgres**

With the migrated db running, insert two readings and query an hourly bucket (create `web/scripts/_check_api.mjs`, run, delete):

```js
import { query, pool } from "../src/db.js";
import { buildRecordsQuery, shapeBucketRow } from "../src/records.js";
const { rows: u } = await query("INSERT INTO users (email,password_hash) VALUES ('api-check@x.dev','x') ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id");
const uid = u[0].id;
await query("DELETE FROM records WHERE user_id=$1", [uid]);
for (const [t, v] of [["2026-07-20T10:05:00Z", 60], ["2026-07-20T10:40:00Z", 80]])
  await query("INSERT INTO records (user_id,type,hc_id,start_at,value_num) VALUES ($1,'heartRate',$2,$3,$4)", [uid, "hr-"+v, t, v]);
const q = buildRecordsQuery({ userId: uid, from: "2026-07-20", to: "2026-07-21", bucket: "hour" });
const { rows } = await query(q.text, q.values);
console.log(rows.map(shapeBucketRow)); // expect one hour bucket, avg 70, min 60, max 80, count 2
await pool.end();
```

Run: `cd web && DATABASE_URL=postgres://vitalix:vitalix@localhost:5432/vitalix node scripts/_check_api.mjs`
Expected: one row, `avg: 70, min: 60, max: 80, count: 2`. Then `rm scripts/_check_api.mjs`.

- [ ] **Step 8: Commit**

```bash
git add web/src/records.js web/test/records.test.js web/src/routes/health.js
git commit -m "feat(web): derive bucketed granular series via /api/records"
```

---

### Task 6: Reset the test database and verify end-to-end

**Files:** none (operational).

- [ ] **Step 1: Truncate the health data (user-approved)**

The old `samples`/`exercises` rows predate `hc_id` and can't be backfilled into `records`. With the db running:

```bash
cd web && docker compose exec -T db psql -U vitalix -d vitalix -c \
  "TRUNCATE records, samples, day_aggregates, exercises, health_days, syncs RESTART IDENTITY CASCADE;"
```
Expected: `TRUNCATE TABLE`. (User accounts in `users` are left intact.)

- [ ] **Step 2: Re-sync from the phone and confirm `records` fills**

Install the Task 1 app build (`cd android && ./gradlew installDebug`), run a sync (with backfill for history), then:

```bash
cd web && docker compose exec -T db psql -U vitalix -d vitalix -c \
  "SELECT type, count(*) FROM records GROUP BY type ORDER BY count DESC LIMIT 10;"
```
Expected: per-type row counts far exceeding one-per-day (e.g. many `heartRate` rows), confirming native granularity is stored.

- [ ] **Step 3: Spot-check the API**

```bash
# Log in via the app/web to get a session, then, using that cookie/token:
curl -s "http://localhost:3000/api/records?bucket=hour&types=heartRate&from=2026-07-01&to=2026-07-31" -H "Authorization: Bearer <token>" | head
```
Expected: JSON with hourly `heartRate` buckets carrying `min`/`max`/`avg`/`count`.

---

## Self-Review

- **Spec coverage:** records table + identity (Task 2) ✓; hc_id capture (Task 1) ✓; mapPayload carry (Task 3) ✓; idempotent upsert persist + exercises (Task 4) ✓; `/api/records` with bucket + catalog (Task 5) ✓; truncate/reset + e2e (Task 6) ✓; non-breaking (rollup pipeline untouched across all tasks) ✓. Volume guard = `RAW_LIMIT` + `truncated` flag ✓. UTC `date_trunc` caveat = accepted, no task ✓.
- **Placeholder scan:** no TBD/TODO; every code step shows full code; the two throwaway scripts are created-run-deleted explicitly.
- **Type consistency:** `hcId` (JSON) ↔ `hc_id` (DB/mapped) used consistently; `buildRecordsQuery`/`aggregationFor`/`BUCKETS`/`shapeBucketRow` names match between `records.js`, its test, and the route; `records` unique key `(user_id, hc_id, start_at)` matches the persist `ON CONFLICT`; `exercises_identity (day_id, hc_id)` matches its `ON CONFLICT`.

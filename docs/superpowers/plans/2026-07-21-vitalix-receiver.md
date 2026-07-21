# Vitalix Receiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Node.js + Postgres webhook receiver in `web/` that ingests the Vitalix health payload (per-day summary + raw samples) into a normalized schema and exposes read endpoints.

**Architecture:** Express HTTP layer → pure `mapPayload()` (JSON → row objects) → `persist()` (one idempotent transaction). Postgres via `node-pg-migrate` migrations, run under docker-compose in dev. All SQL isolated in `persist.js`; all mapping isolated and unit-tested in `mapPayload.js`.

**Tech Stack:** Node.js LTS (ES modules), Express, `pg`, `node-pg-migrate`, `node:test`, Docker Compose, Postgres 16.

## Global Constraints

- Location: everything under `web/`.
- ES modules (`"type": "module"` in package.json); Node LTS ≥ 20.
- No ORM — raw SQL only, all in `src/persist.js`.
- Env vars: `DATABASE_URL` (required), `AUTH_TOKEN` (optional → open + warn), `PORT` (default `3000`).
- Metric string keys are the exact ones from the Android spec: `heartRate, hrv, spo2, bloodGlucose, respiratoryRate, bpSystolic, bpDiastolic` (aggregates); sample `metric` keys include `steps, distance, activeCalories, totalCalories, floorsClimbed, elevationGained, power, speed, wheelchairPushes, hydration, nutrition, weight, bodyFat, boneMass, height, leanBodyMass, vo2Max, restingHeartRate, bodyTemperature, bloodPressure, sleepStage, menstruation, cervicalMucus, ovulationTest, sexualActivity`.
- `day` is globally UNIQUE; ingest is latest-sync-wins (child rows fully replaced per day).
- Auth compare uses `crypto.timingSafeEqual`.
- This is not a git repo yet — Task 0 runs `git init` so per-task commits work.

---

### Task 0: Project scaffold, git, package.json

**Files:**
- Create: `web/package.json`, `web/.gitignore`, `web/.env.example`, `web/.dockerignore`

**Interfaces:**
- Produces: npm scripts `test`, `migrate`, `start`, `dev`; dependency set for all later tasks.

- [ ] **Step 1: Init git at repo root (once)**

Run: `cd /Users/marvellooni/Project/Vitalix && git init && printf 'node_modules/\n.env\n' > web/.gitignore`
Expected: `Initialized empty Git repository`.

- [ ] **Step 2: Create `web/package.json`**

```json
{
  "name": "vitalix-receiver",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "migrate": "node-pg-migrate",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.19.2",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "node-pg-migrate": "^7.6.1"
  }
}
```

- [ ] **Step 3: Create `web/.env.example`**

```bash
DATABASE_URL=postgres://vitalix:vitalix@localhost:5432/vitalix
AUTH_TOKEN=change-me-optional
PORT=3000
```

- [ ] **Step 4: Create `web/.dockerignore`**

```
node_modules
.env
npm-debug.log
```

- [ ] **Step 5: Install deps**

Run: `cd /Users/marvellooni/Project/Vitalix/web && npm install`
Expected: `node_modules/` created, no error.

- [ ] **Step 6: Commit**

```bash
cd /Users/marvellooni/Project/Vitalix
git add web/package.json web/package-lock.json web/.gitignore web/.env.example web/.dockerignore
git commit -m "chore: scaffold vitalix receiver (web)"
```

---

### Task 1: Database migration (schema)

**Files:**
- Create: `web/migrations/1721520000000_init.cjs`

**Interfaces:**
- Produces: tables `syncs`, `health_days`, `day_aggregates`, `samples`, `exercises` with the columns `persist.js` (Task 4) writes to.

- [ ] **Step 1: Write the migration**

`node-pg-migrate` runs `.cjs` migrations with `pgm`. Create `web/migrations/1721520000000_init.cjs`:

```js
exports.up = (pgm) => {
  pgm.createTable("syncs", {
    id: "bigserial",
    source: { type: "text" },
    app_version: { type: "text" },
    device: { type: "text" },
    exported_at: { type: "timestamptz" },
    range_days: { type: "integer" },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("syncs", "syncs_pkey", { primaryKey: "id" });

  pgm.createTable("health_days", {
    id: "bigserial",
    sync_id: { type: "bigint", references: "syncs", onDelete: "SET NULL" },
    day: { type: "date", notNull: true, unique: true },
    steps: { type: "integer" },
    active_calories: { type: "double precision" },
    total_calories: { type: "double precision" },
    distance: { type: "double precision" },
    floors_climbed: { type: "double precision" },
    elevation_gained: { type: "double precision" },
    power: { type: "double precision" },
    speed: { type: "double precision" },
    wheelchair_pushes: { type: "double precision" },
    vo2_max: { type: "double precision" },
    weight: { type: "double precision" },
    body_fat: { type: "double precision" },
    bone_mass: { type: "double precision" },
    height: { type: "double precision" },
    lean_body_mass: { type: "double precision" },
    resting_heart_rate: { type: "double precision" },
    body_temperature: { type: "double precision" },
    sleep_duration_minutes: { type: "integer" },
    sleep_deep: { type: "integer" },
    sleep_light: { type: "integer" },
    sleep_rem: { type: "integer" },
    sleep_awake: { type: "integer" },
    menstruation: { type: "text" },
    cervical_mucus: { type: "text" },
    ovulation_test: { type: "text" },
    sexual_activity: { type: "text" },
    hydration_ml: { type: "double precision" },
    energy_kcal: { type: "double precision" },
  });
  pgm.addConstraint("health_days", "health_days_pkey", { primaryKey: "id" });

  pgm.createTable("day_aggregates", {
    id: "bigserial",
    day_id: { type: "bigint", notNull: true, references: "health_days", onDelete: "CASCADE" },
    metric: { type: "text", notNull: true },
    min: { type: "double precision" },
    max: { type: "double precision" },
    avg: { type: "double precision" },
  });
  pgm.addConstraint("day_aggregates", "day_aggregates_pkey", { primaryKey: "id" });
  pgm.addConstraint("day_aggregates", "day_aggregates_unique", { unique: ["day_id", "metric"] });

  pgm.createTable("samples", {
    id: "bigserial",
    day_id: { type: "bigint", notNull: true, references: "health_days", onDelete: "CASCADE" },
    metric: { type: "text", notNull: true },
    start_at: { type: "timestamptz", notNull: true },
    end_at: { type: "timestamptz" },
    value_num: { type: "double precision" },
    value_secondary: { type: "double precision" },
    value_text: { type: "text" },
  });
  pgm.addConstraint("samples", "samples_pkey", { primaryKey: "id" });
  pgm.createIndex("samples", ["metric", "start_at"]);
  pgm.createIndex("samples", "day_id");

  pgm.createTable("exercises", {
    id: "bigserial",
    day_id: { type: "bigint", notNull: true, references: "health_days", onDelete: "CASCADE" },
    name: { type: "text" },
    start_at: { type: "timestamptz" },
    duration_minutes: { type: "integer" },
  });
  pgm.addConstraint("exercises", "exercises_pkey", { primaryKey: "id" });
};

exports.down = (pgm) => {
  pgm.dropTable("exercises");
  pgm.dropTable("samples");
  pgm.dropTable("day_aggregates");
  pgm.dropTable("health_days");
  pgm.dropTable("syncs");
};
```

- [ ] **Step 2: Commit** (migration verified end-to-end in Task 6 once Postgres is up)

```bash
git add web/migrations/1721520000000_init.cjs
git commit -m "feat(db): initial schema migration"
```

---

### Task 2: config + db pool

**Files:**
- Create: `web/src/config.js`, `web/src/db.js`

**Interfaces:**
- Produces:
  - `config` — `{ databaseUrl: string, authToken: string|null, port: number }`
  - `db.query(text, params) -> Promise<QueryResult>`
  - `db.withTransaction(fn) -> Promise<T>` where `fn(client)` runs inside BEGIN/COMMIT, ROLLBACK on throw
  - `db.pool` (pg Pool), `db.ping() -> Promise<boolean>`

- [ ] **Step 1: Create `web/src/config.js`**

```js
export const config = {
  databaseUrl: process.env.DATABASE_URL,
  authToken: process.env.AUTH_TOKEN || null,
  port: Number(process.env.PORT || 3000),
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
```

- [ ] **Step 2: Create `web/src/db.js`**

```js
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function ping() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/config.js web/src/db.js
git commit -m "feat: config and pg pool with transaction helper"
```

---

### Task 3: mapPayload (pure) — TDD

**Files:**
- Create: `web/src/mapPayload.js`, `web/test/mapPayload.test.js`

**Interfaces:**
- Produces: `mapPayload(body) -> { sync, days, skipped }` where
  - `sync = { source, app_version, device, exported_at, range_days }`
  - `days = [{ day, scalars: {<column>: value}, aggregates: [{metric,min,max,avg}], samples: [{metric,start_at,end_at,value_num,value_secondary,value_text}], exercises: [{name,start_at,duration_minutes}] }]`
  - `skipped = number` (samples with unknown metric keys)
- Consumed by: `persist.js` (Task 4), `routes/health.js` (Task 5).

- [ ] **Step 1: Write the failing test — `web/test/mapPayload.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPayload } from "../src/mapPayload.js";

const payload = {
  source: "vitalix",
  appVersion: "1.0.0",
  device: "Pixel 8",
  exportedAt: "2026-07-21T09:00:00Z",
  rangeDays: 7,
  days: [
    {
      date: "2026-07-20",
      activity: { steps: 8123, activeCalories: 412.0, distance: 6100.0 },
      body: { weight: 71.2 },
      vitals: {
        heartRate: { min: 52, max: 146, avg: 68 },
        restingHeartRate: 54,
        bloodPressure: { systolic: { avg: 118 }, diastolic: { avg: 76 } },
      },
      sleep: { durationMinutes: 431, stages: { deep: 78, light: 240, rem: 96, awake: 17 } },
      nutrition: { hydrationMl: 1800, energyKcal: 2100 },
      exercises: [{ name: "Running", start: "2026-07-20T06:12:00Z", durationMinutes: 32 }],
      samples: [
        { metric: "heartRate", start: "2026-07-20T10:04:12Z", value: 68 },
        { metric: "steps", start: "2026-07-20T10:00:00Z", end: "2026-07-20T11:00:00Z", value: 412 },
        { metric: "bloodPressure", start: "2026-07-20T07:30:00Z", value: 118, value2: 76 },
        { metric: "sleepStage", start: "2026-07-20T00:12:00Z", end: "2026-07-20T01:30:00Z", text: "deep" },
        { metric: "bogusMetric", start: "2026-07-20T00:00:00Z", value: 1 },
      ],
    },
  ],
};

test("maps sync metadata", () => {
  const { sync } = mapPayload(payload);
  assert.deepEqual(sync, {
    source: "vitalix",
    app_version: "1.0.0",
    device: "Pixel 8",
    exported_at: "2026-07-21T09:00:00Z",
    range_days: 7,
  });
});

test("maps scalar columns and omits absent metrics", () => {
  const { days } = mapPayload(payload);
  const s = days[0].scalars;
  assert.equal(s.steps, 8123);
  assert.equal(s.weight, 71.2);
  assert.equal(s.resting_heart_rate, 54);
  assert.equal(s.sleep_deep, 78);
  assert.equal(s.hydration_ml, 1800);
  assert.equal(s.energy_kcal, 2100);
  assert.ok(!("body_fat" in s)); // absent metric not present
});

test("maps aggregates including split blood pressure", () => {
  const aggs = mapPayload(payload).days[0].aggregates;
  const hr = aggs.find((a) => a.metric === "heartRate");
  assert.deepEqual(hr, { metric: "heartRate", min: 52, max: 146, avg: 68 });
  assert.ok(aggs.find((a) => a.metric === "bpSystolic" && a.avg === 118));
  assert.ok(aggs.find((a) => a.metric === "bpDiastolic" && a.avg === 76));
});

test("maps samples by record shape and skips unknown metrics", () => {
  const { days, skipped } = mapPayload(payload);
  const samples = days[0].samples;
  const hr = samples.find((s) => s.metric === "heartRate");
  assert.deepEqual(hr, { metric: "heartRate", start_at: "2026-07-20T10:04:12Z", end_at: null, value_num: 68, value_secondary: null, value_text: null });
  const steps = samples.find((s) => s.metric === "steps");
  assert.equal(steps.end_at, "2026-07-20T11:00:00Z");
  assert.equal(steps.value_num, 412);
  const bp = samples.find((s) => s.metric === "bloodPressure");
  assert.equal(bp.value_num, 118);
  assert.equal(bp.value_secondary, 76);
  const stage = samples.find((s) => s.metric === "sleepStage");
  assert.equal(stage.value_text, "deep");
  assert.equal(skipped, 1); // bogusMetric
  assert.ok(!samples.find((s) => s.metric === "bogusMetric"));
});

test("maps exercises", () => {
  const ex = mapPayload(payload).days[0].exercises[0];
  assert.deepEqual(ex, { name: "Running", start_at: "2026-07-20T06:12:00Z", duration_minutes: 32 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --test test/mapPayload.test.js`
Expected: FAIL — `Cannot find module '../src/mapPayload.js'`.

- [ ] **Step 3: Write `web/src/mapPayload.js`**

```js
// Maps the payload day.activity/body/vitals/sleep/cycle/nutrition objects
// onto flat health_days columns.
const SCALAR_MAP = {
  activity: { steps: "steps", activeCalories: "active_calories", totalCalories: "total_calories", distance: "distance", floorsClimbed: "floors_climbed", elevationGained: "elevation_gained", power: "power", speed: "speed", wheelchairPushes: "wheelchair_pushes", vo2Max: "vo2_max" },
  body: { weight: "weight", bodyFat: "body_fat", boneMass: "bone_mass", height: "height", leanBodyMass: "lean_body_mass" },
  vitals: { restingHeartRate: "resting_heart_rate", bodyTemperature: "body_temperature" },
  nutrition: { hydrationMl: "hydration_ml", energyKcal: "energy_kcal" },
};

// vitals sub-objects that are MinMaxAvg aggregates
const AGG_METRICS = ["heartRate", "hrv", "spo2", "bloodGlucose", "respiratoryRate"];

// sample metric keys the receiver understands
const KNOWN_SAMPLE_METRICS = new Set([
  "steps", "distance", "activeCalories", "totalCalories", "floorsClimbed", "elevationGained",
  "power", "speed", "wheelchairPushes", "hydration", "nutrition",
  "weight", "bodyFat", "boneMass", "height", "leanBodyMass", "vo2Max",
  "heartRate", "hrv", "spo2", "bloodGlucose", "respiratoryRate", "restingHeartRate", "bodyTemperature",
  "bloodPressure", "sleepStage",
  "menstruation", "cervicalMucus", "ovulationTest", "sexualActivity",
]);

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

function mapScalars(day) {
  const out = {};
  for (const [section, cols] of Object.entries(SCALAR_MAP)) {
    const obj = day[section];
    if (!obj) continue;
    for (const [key, col] of Object.entries(cols)) {
      if (obj[key] !== undefined && obj[key] !== null) out[col] = obj[key];
    }
  }
  const sleep = day.sleep;
  if (sleep) {
    if (sleep.durationMinutes != null) out.sleep_duration_minutes = sleep.durationMinutes;
    const st = sleep.stages || {};
    if (st.deep != null) out.sleep_deep = st.deep;
    if (st.light != null) out.sleep_light = st.light;
    if (st.rem != null) out.sleep_rem = st.rem;
    if (st.awake != null) out.sleep_awake = st.awake;
  }
  const cycle = day.cycle;
  if (cycle) {
    for (const [key, col] of Object.entries({ menstruation: "menstruation", cervicalMucus: "cervical_mucus", ovulationTest: "ovulation_test", sexualActivity: "sexual_activity" })) {
      if (cycle[key] != null) out[col] = cycle[key];
    }
  }
  return out;
}

function mapAggregates(day) {
  const vitals = day.vitals || {};
  const out = [];
  for (const metric of AGG_METRICS) {
    const a = vitals[metric];
    if (a && typeof a === "object") out.push({ metric, min: num(a.min), max: num(a.max), avg: num(a.avg) });
  }
  const bp = vitals.bloodPressure;
  if (bp && typeof bp === "object") {
    if (bp.systolic) out.push({ metric: "bpSystolic", min: num(bp.systolic.min), max: num(bp.systolic.max), avg: num(bp.systolic.avg) });
    if (bp.diastolic) out.push({ metric: "bpDiastolic", min: num(bp.diastolic.min), max: num(bp.diastolic.max), avg: num(bp.diastolic.avg) });
  }
  return out;
}

function mapSamples(day) {
  const raw = Array.isArray(day.samples) ? day.samples : [];
  const samples = [];
  let skipped = 0;
  for (const r of raw) {
    if (!KNOWN_SAMPLE_METRICS.has(r.metric)) { skipped++; continue; }
    samples.push({
      metric: r.metric,
      start_at: r.start,
      end_at: r.end ?? null,
      value_num: r.value ?? null,
      value_secondary: r.value2 ?? null,
      value_text: r.text ?? null,
    });
  }
  return { samples, skipped };
}

function mapExercises(day) {
  return (Array.isArray(day.exercises) ? day.exercises : []).map((e) => ({
    name: e.name ?? null,
    start_at: e.start ?? null,
    duration_minutes: e.durationMinutes ?? null,
  }));
}

export function mapPayload(body) {
  const sync = {
    source: body.source ?? null,
    app_version: body.appVersion ?? null,
    device: body.device ?? null,
    exported_at: body.exportedAt ?? null,
    range_days: body.rangeDays ?? null,
  };
  let skipped = 0;
  const days = (Array.isArray(body.days) ? body.days : []).map((day) => {
    const s = mapSamples(day);
    skipped += s.skipped;
    return {
      day: day.date,
      scalars: mapScalars(day),
      aggregates: mapAggregates(day),
      samples: s.samples,
      exercises: mapExercises(day),
    };
  });
  return { sync, days, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --test test/mapPayload.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/mapPayload.js web/test/mapPayload.test.js
git commit -m "feat: pure payload->rows mapper with tests"
```

---

### Task 4: persist (SQL transaction)

**Files:**
- Create: `web/src/persist.js`

**Interfaces:**
- Consumes: `mapPayload` output (`{sync, days}`), `db.withTransaction`.
- Produces: `persist(mapped) -> Promise<{ days, samples, exercises }>` (counts inserted/updated). Runs the full idempotent ingest in one transaction.

- [ ] **Step 1: Create `web/src/persist.js`**

```js
import { withTransaction } from "./db.js";

const DAY_COLUMNS = [
  "steps", "active_calories", "total_calories", "distance", "floors_climbed",
  "elevation_gained", "power", "speed", "wheelchair_pushes", "vo2_max",
  "weight", "body_fat", "bone_mass", "height", "lean_body_mass",
  "resting_heart_rate", "body_temperature",
  "sleep_duration_minutes", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake",
  "menstruation", "cervical_mucus", "ovulation_test", "sexual_activity",
  "hydration_ml", "energy_kcal",
];

async function upsertDay(client, syncId, day) {
  const cols = ["sync_id", "day", ...DAY_COLUMNS];
  const values = [syncId, day.day, ...DAY_COLUMNS.map((c) => day.scalars[c] ?? null)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const updates = ["sync_id = EXCLUDED.sync_id", ...DAY_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`)].join(", ");
  const sql = `
    INSERT INTO health_days (${cols.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT (day) DO UPDATE SET ${updates}
    RETURNING id`;
  const { rows } = await client.query(sql, values);
  return rows[0].id;
}

async function replaceAggregates(client, dayId, aggregates) {
  await client.query("DELETE FROM day_aggregates WHERE day_id = $1", [dayId]);
  for (const a of aggregates) {
    await client.query(
      "INSERT INTO day_aggregates (day_id, metric, min, max, avg) VALUES ($1,$2,$3,$4,$5)",
      [dayId, a.metric, a.min, a.max, a.avg]
    );
  }
}

async function replaceSamples(client, dayId, samples) {
  await client.query("DELETE FROM samples WHERE day_id = $1", [dayId]);
  for (const s of samples) {
    await client.query(
      "INSERT INTO samples (day_id, metric, start_at, end_at, value_num, value_secondary, value_text) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [dayId, s.metric, s.start_at, s.end_at, s.value_num, s.value_secondary, s.value_text]
    );
  }
}

async function replaceExercises(client, dayId, exercises) {
  await client.query("DELETE FROM exercises WHERE day_id = $1", [dayId]);
  for (const e of exercises) {
    await client.query(
      "INSERT INTO exercises (day_id, name, start_at, duration_minutes) VALUES ($1,$2,$3,$4)",
      [dayId, e.name, e.start_at, e.duration_minutes]
    );
  }
}

export function persist(mapped) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO syncs (source, app_version, device, exported_at, range_days) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [mapped.sync.source, mapped.sync.app_version, mapped.sync.device, mapped.sync.exported_at, mapped.sync.range_days]
    );
    const syncId = rows[0].id;
    let samples = 0, exercises = 0;
    for (const day of mapped.days) {
      const dayId = await upsertDay(client, syncId, day);
      await replaceAggregates(client, dayId, day.aggregates);
      await replaceSamples(client, dayId, day.samples);
      await replaceExercises(client, dayId, day.exercises);
      samples += day.samples.length;
      exercises += day.exercises.length;
    }
    return { days: mapped.days.length, samples, exercises };
  });
}
```

- [ ] **Step 2: Commit** (exercised end-to-end in Task 6)

```bash
git add web/src/persist.js
git commit -m "feat: idempotent ingest transaction"
```

---

### Task 5: auth + routes + express app

**Files:**
- Create: `web/src/auth.js`, `web/src/routes/health.js`, `web/src/index.js`

**Interfaces:**
- Consumes: `config`, `db`, `mapPayload`, `persist`.
- Produces: an Express app listening on `config.port` with `POST /api/health`, `GET /api/days`, `GET /api/days/:date`, `GET /healthz`.

- [ ] **Step 1: Create `web/src/auth.js`**

```js
import crypto from "node:crypto";
import { config } from "./config.js";

export function bearerAuth(req, res, next) {
  if (!config.authToken) return next(); // open mode (warned at startup)
  const header = req.get("authorization") || "";
  const prefix = "Bearer ";
  const provided = header.startsWith(prefix) ? header.slice(prefix.length) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(config.authToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
```

- [ ] **Step 2: Create `web/src/routes/health.js`**

```js
import { Router } from "express";
import { bearerAuth } from "../auth.js";
import { mapPayload } from "../mapPayload.js";
import { persist } from "../persist.js";
import { query, ping } from "../db.js";

export const router = Router();

router.get("/healthz", async (_req, res) => {
  res.status((await ping()) ? 200 : 503).json({ ok: await ping() });
});

router.post("/api/health", bearerAuth, async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.days)) {
    return res.status(400).json({ error: "body must include a days array" });
  }
  try {
    const mapped = mapPayload(body);
    const inserted = await persist(mapped);
    res.status(200).json({ inserted, skipped: mapped.skipped });
  } catch (err) {
    console.error("ingest failed", err);
    res.status(500).json({ error: "ingest failed" });
  }
});

router.get("/api/days", bearerAuth, async (req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const { rows } = await query(
    "SELECT * FROM health_days WHERE day BETWEEN $1 AND $2 ORDER BY day DESC",
    [from, to]
  );
  res.json(rows);
});

router.get("/api/days/:date", bearerAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM health_days WHERE day = $1", [req.params.date]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  const day = rows[0];
  const [aggregates, samples, exercises] = await Promise.all([
    query("SELECT metric, min, max, avg FROM day_aggregates WHERE day_id = $1", [day.id]),
    query("SELECT metric, start_at, end_at, value_num, value_secondary, value_text FROM samples WHERE day_id = $1 ORDER BY start_at", [day.id]),
    query("SELECT name, start_at, duration_minutes FROM exercises WHERE day_id = $1", [day.id]),
  ]);
  res.json({ ...day, aggregates: aggregates.rows, samples: samples.rows, exercises: exercises.rows });
});
```

- [ ] **Step 3: Create `web/src/index.js`**

```js
import express from "express";
import { config } from "./config.js";
import { router } from "./routes/health.js";

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(router);

if (!config.authToken) {
  console.warn("AUTH_TOKEN not set — receiver is open to unauthenticated requests");
}

app.listen(config.port, () => {
  console.log(`vitalix receiver listening on :${config.port}`);
});

export { app };
```

- [ ] **Step 4: Commit**

```bash
git add web/src/auth.js web/src/routes/health.js web/src/index.js
git commit -m "feat: express app, bearer auth, ingest + read routes"
```

---

### Task 6: docker-compose + Dockerfile + end-to-end verification

**Files:**
- Create: `web/Dockerfile`, `web/docker-compose.yml`

**Interfaces:**
- Produces: `docker compose up` bringing Postgres + app online with migrations applied.

- [ ] **Step 1: Create `web/Dockerfile`**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
# Run migrations then start
CMD ["sh", "-c", "npx node-pg-migrate up && node src/index.js"]
```

- [ ] **Step 2: Create `web/docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: vitalix
      POSTGRES_PASSWORD: vitalix
      POSTGRES_DB: vitalix
    ports: ["5432:5432"]
    volumes: ["vitalix_pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vitalix"]
      interval: 3s
      timeout: 3s
      retries: 10
  app:
    build: .
    environment:
      DATABASE_URL: postgres://vitalix:vitalix@db:5432/vitalix
      AUTH_TOKEN: change-me-optional
      PORT: 3000
    ports: ["3000:3000"]
    depends_on:
      db:
        condition: service_healthy

volumes:
  vitalix_pgdata:
```

- [ ] **Step 3: Bring the stack up**

Run: `cd web && docker compose up --build -d && sleep 8`
Expected: both containers running; app log shows `vitalix receiver listening on :3000`.

- [ ] **Step 4: Verify liveness**

Run: `curl -s localhost:3000/healthz`
Expected: `{"ok":true}`

- [ ] **Step 5: POST the sample payload and verify ingest**

Run:
```bash
curl -s -X POST localhost:3000/api/health \
  -H 'Authorization: Bearer change-me-optional' \
  -H 'Content-Type: application/json' \
  -d '{"source":"vitalix","appVersion":"1.0.0","device":"Pixel 8","exportedAt":"2026-07-21T09:00:00Z","rangeDays":7,"days":[{"date":"2026-07-20","activity":{"steps":8123},"vitals":{"heartRate":{"min":52,"max":146,"avg":68}},"samples":[{"metric":"heartRate","start":"2026-07-20T10:04:12Z","value":68}],"exercises":[{"name":"Running","start":"2026-07-20T06:12:00Z","durationMinutes":32}]}]}'
```
Expected: `{"inserted":{"days":1,"samples":1,"exercises":1},"skipped":0}`

- [ ] **Step 6: Verify auth rejects a bad token**

Run: `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:3000/api/health -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{"days":[]}'`
Expected: `401`

- [ ] **Step 7: Verify idempotency — re-POST same day, expect one row**

Run the Step 5 curl again, then:
`curl -s localhost:3000/api/days/2026-07-20 -H 'Authorization: Bearer change-me-optional' | grep -o '"day"'`
Expected: exactly one `"day"` occurrence (day not duplicated); samples/exercises replaced, not doubled.

- [ ] **Step 8: Tear down and commit**

```bash
cd web && docker compose down
git add web/Dockerfile web/docker-compose.yml
git commit -m "feat: docker-compose stack + migrations on boot"
```

---

## Self-Review notes

- **Spec coverage:** stack (T0), schema incl. `samples`/`day_aggregates` (T1), config/pool/txn (T2), pure `mapPayload` (T3), idempotent `persist` (T4), auth + all four endpoints (T5), docker-compose + e2e incl. idempotency/auth checks (T6). ✅
- **Type consistency:** `mapPayload` output shape (`scalars/aggregates/samples/exercises`, `value_num/value_secondary/value_text`, `bpSystolic/bpDiastolic`) is consumed verbatim by `persist` `DAY_COLUMNS` and insert statements. ✅
- **Deferred verification:** T1/T4 have no standalone test (need a live DB); both are exercised by T6's e2e curls — acceptable since Postgres only exists once compose is up.

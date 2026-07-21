# Vitalix Receiver — Node.js + Postgres (Design)

**Date:** 2026-07-21
**Status:** Draft for review
**Location:** `web/`
**Pairs with:** `2026-07-21-vitalix-health-forwarder-design.md` (the Android app that POSTs the payload)

---

## Summary

A self-hosted webhook receiver for the Vitalix Android app. It accepts the health-data
`POST` payload (per-day summary **+** raw timestamped samples), authenticates it with an
optional bearer token, and stores it in Postgres using a **normalized relational** schema.
It also exposes read endpoints so the user can verify an export end-to-end without a phone.

Single-user, self-hosted. No multi-tenant, no user accounts — one deployment stores one
person's data.

---

## Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js (LTS), ES modules |
| HTTP | Express |
| DB driver | `pg` (node-postgres), connection `Pool` |
| Migrations | `node-pg-migrate` |
| DB | Postgres (via `docker-compose` in dev) |
| Tests | `node:test` (built-in) |

No ORM. Raw SQL keeps the mapping explicit and the schema legible.

---

## Layout

```
web/
  docker-compose.yml      # postgres + app service
  Dockerfile              # app image
  package.json
  .env.example            # DATABASE_URL, AUTH_TOKEN, PORT
  migrations/             # node-pg-migrate migration files
  src/
    index.js              # express bootstrap, mounts routes, starts server
    config.js             # reads + validates env (DATABASE_URL, AUTH_TOKEN, PORT)
    db.js                 # pg Pool, query helper, withTransaction()
    auth.js               # bearer-token middleware (constant-time compare)
    mapPayload.js         # PURE: payload JSON -> { sync, days[], aggregates[], samples[], exercises[] }
    persist.js            # transaction: writes a mapped result into the tables (all SQL lives here)
    routes/
      health.js          # POST /api/health, GET /api/days, GET /api/days/:date, GET /healthz
  test/
    mapPayload.test.js    # pure unit tests, no DB required
```

### Design boundaries

- **`mapPayload.js`** — pure function. Input: the raw JSON body. Output: plain row objects
  (`sync`, `days`, `aggregates`, `samples`, `exercises`). No DB, no I/O. Fully unit-testable.
  Mirrors the Android spec's `ServerForwarder`/`HealthConnectManager` purity split.
- **`persist.js`** — owns every SQL statement and the ingest transaction. Knows nothing about
  HTTP or payload shape beyond the mapped row objects.
- **`routes/health.js`** — HTTP glue: validate, call `mapPayload` → `persist`, translate
  errors to status codes.

This keeps the payload→rows mapping (the part most likely to change with the schema)
isolated and testable without a database.

---

## Schema (normalized relational)

Migration `migrations/*_init`:

### `syncs` — one row per POST
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `source` | TEXT | `"vitalix"` |
| `app_version` | TEXT | |
| `device` | TEXT | |
| `exported_at` | TIMESTAMPTZ | from payload |
| `range_days` | INT | |
| `received_at` | TIMESTAMPTZ DEFAULT now() | server clock |

### `health_days` — one row per calendar day (the fast summary)
- `id` BIGSERIAL PK
- `sync_id` BIGINT REFERENCES `syncs(id)` — the sync that last wrote this day
- `day` DATE **UNIQUE NOT NULL** — global uniqueness; latest sync wins
- Activity scalars: `steps` INT, `active_calories`, `total_calories`, `distance`,
  `floors_climbed`, `elevation_gained`, `power`, `speed`, `wheelchair_pushes`, `vo2_max`
  (DOUBLE PRECISION unless noted)
- Body: `weight`, `body_fat`, `bone_mass`, `height`, `lean_body_mass` (DOUBLE)
- Vitals scalars: `resting_heart_rate`, `body_temperature` (DOUBLE)
- Sleep: `sleep_duration_minutes` INT, `sleep_deep`, `sleep_light`, `sleep_rem`,
  `sleep_awake` (INT minutes)
- Cycle: `menstruation`, `cervical_mucus`, `ovulation_test`, `sexual_activity` (TEXT)
- Nutrition: `hydration_ml` DOUBLE, `energy_kcal` DOUBLE

All metric columns are nullable — a metric the user didn't enable stays NULL.

### `day_aggregates` — min/max/avg vitals (avoids a 60-column explosion)
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `day_id` | BIGINT REFERENCES `health_days(id)` ON DELETE CASCADE | |
| `metric` | TEXT | `heartRate`, `hrv`, `spo2`, `bloodGlucose`, `respiratoryRate`, `bpSystolic`, `bpDiastolic` |
| `min` / `max` / `avg` | DOUBLE PRECISION | nullable |

Unique `(day_id, metric)`.

### `samples` — raw timestamped records (the drill-down)
One flexible typed table for every record shape (see Android spec's Raw samples table):

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `day_id` | BIGINT REFERENCES `health_days(id)` ON DELETE CASCADE | |
| `metric` | TEXT | stable metric key, e.g. `heartRate`, `steps`, `bloodPressure`, `sleepStage` |
| `start_at` | TIMESTAMPTZ NOT NULL | |
| `end_at` | TIMESTAMPTZ NULL | interval/staged records |
| `value_num` | DOUBLE PRECISION NULL | numeric value (systolic for BP) |
| `value_secondary` | DOUBLE PRECISION NULL | diastolic for BP |
| `value_text` | TEXT NULL | sleep stage, cycle category |

Indexes: `(metric, start_at)`, `(day_id)`.

Mapping by record shape:
- Instantaneous → `start_at`, `value_num`
- Interval → `start_at`, `end_at`, `value_num`
- Blood pressure → `value_num` = systolic, `value_secondary` = diastolic
- Sleep stage / cycle → `value_text` (+ `end_at` for staged)

### `exercises` — sessions (one-to-many per day)
| Column | Type |
|--------|------|
| `id` | BIGSERIAL PK |
| `day_id` | BIGINT REFERENCES `health_days(id)` ON DELETE CASCADE |
| `name` | TEXT |
| `start_at` | TIMESTAMPTZ |
| `duration_minutes` | INT |

---

## Ingest (idempotency)

`POST /api/health` runs a single transaction (`persist.persist(mapped)`):

1. Insert one `syncs` row → get `sync_id`.
2. For each day in the payload:
   a. `INSERT INTO health_days (...) VALUES (...) ON CONFLICT (day) DO UPDATE SET ...`
      (sets `sync_id` + all scalar columns) → returns `day_id`.
   b. `DELETE FROM day_aggregates WHERE day_id = $1`, then insert this day's aggregates.
   c. `DELETE FROM samples WHERE day_id = $1`, then bulk-insert this day's samples.
   d. `DELETE FROM exercises WHERE day_id = $1`, then insert this day's exercises.
3. Commit; on any error, rollback → 500.

**Latest-sync-wins per day.** Overlapping syncs (auto sends since-`lastSync`; manual sends
the full range) reconcile cleanly because a day's child rows are fully replaced each time.
Per-sync history is intentionally not retained — this is a personal current-state store. The
`syncs` table still records that each POST happened.

---

## Endpoints

| Method / path | Purpose | Responses |
|---------------|---------|-----------|
| `POST /api/health` | Ingest a payload | `200 {inserted: {days, samples, exercises}}`; `400` malformed; `401` bad/missing token; `500` DB error |
| `GET /api/days?from=&to=` | List daily summaries in a date range (default last 7 days) | `200 [ ... ]` |
| `GET /api/days/:date` | One day's summary + aggregates + samples + exercises | `200 { ... }`; `404` |
| `GET /healthz` | Liveness + DB ping | `200 {ok:true}` / `503` |

---

## Auth

- `auth.js` middleware on `/api/*`.
- Read `AUTH_TOKEN` from env. If set, require `Authorization: Bearer <AUTH_TOKEN>`,
  compared with `crypto.timingSafeEqual` (length-guarded) → `401` on mismatch/missing.
- If `AUTH_TOKEN` is unset: allow all requests and log a startup warning
  (`AUTH_TOKEN not set — receiver is open`). Matches the app's optional-token contract.

---

## Error Handling

| Condition | Response |
|-----------|----------|
| Missing/invalid bearer token (when `AUTH_TOKEN` set) | `401` |
| Body not JSON / missing `days` array | `400` with a short message |
| Unknown `metric` string in a sample | Skip that sample, count it in a `skipped` warning; do not fail the whole POST |
| DB/transaction failure | Rollback, `500` |
| DB unreachable at `/healthz` | `503` |

---

## Config (`.env`)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `DATABASE_URL` | yes | — | `postgres://user:pass@host:5432/vitalix` |
| `AUTH_TOKEN` | no | (open) | bearer token the app must send |
| `PORT` | no | `3000` | HTTP port |

`docker-compose.yml` wires a `postgres` service and the app, passing `DATABASE_URL` and
running migrations (`node-pg-migrate up`) on startup before the server listens.

---

## Testing

| Test | Type | Asserts |
|------|------|---------|
| `mapPayload` — full payload | unit | Correct `sync`/`days`/`aggregates`/`samples`/`exercises` row objects; only present metrics mapped. |
| `mapPayload` — record shapes | unit | Instantaneous/interval/BP/staged samples map to the right `value_*`/`end_at` fields. |
| `mapPayload` — omitted metrics | unit | Absent metrics → NULL scalars, no phantom aggregate/sample rows. |
| Ingest idempotency | integration (dockerized PG, optional) | Re-POSTing overlapping days replaces child rows; no duplicate days. |

Unit tests (`mapPayload`) need no database and run in CI cheaply. The idempotency test needs
Postgres and is gated behind a `DATABASE_URL` being present.

---

## Out of Scope (v1)

- User accounts / multi-tenant / per-device separation.
- Per-sync history / audit log of overwritten values.
- Dashboards / charts / UI (read endpoints return JSON only).
- Rate limiting, TLS termination (assume a reverse proxy handles TLS in real deployments).
- Retry/queue on the receiver side (the app owns retries via WorkManager).

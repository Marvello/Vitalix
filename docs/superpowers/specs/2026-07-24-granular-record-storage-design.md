# Granular record storage — design

**Date:** 2026-07-24
**Status:** Approved, pending implementation
**Related:** [2026-07-21-vitalix-receiver-design.md](2026-07-21-vitalix-receiver-design.md), [2026-07-22-vitalix-auth-per-user-design.md](2026-07-22-vitalix-auth-per-user-design.md)

## Goal

Store health readings at their **native Health Connect time-granularity** as the server's source of truth, so the web can re-aggregate to any bucket the user chooses (raw · minute · hour · day · week) at query time.

Today the day-rollups (`health_days`, `day_aggregates`) are computed **on the phone** and shipped pre-aggregated; the server only stores them. The one re-aggregatable layer, `samples`, is bucketed under `day_id` and **delete-replaced per sync**, so it has no stable record identity and cannot be safely re-synced or backfilled without loss. This design makes raw records the server's source of truth, stored **idempotently**.

### Fidelity scope (decided)

- **In scope:** time-granularity. Every reading kept at its native timestamp with the value fields we already capture (`start`, `end`, `value`, `value2`, `text`, `source`).
- **Out of scope (non-goals):** new descriptive fields — nutrition's ~30 nutrients, blood-pressure body position/location, exercise segments/laps/GPS route, per-record device make/model, `recordingMethod`, `lastModifiedTime`. These stay dropped.

## Key idea: stable record identity

Health Connect assigns every record a stable UID at `record.metadata.id`. Shipping that turns deduplication into a database upsert: re-syncs, overlapping backfill windows, and repeated daily syncs all converge on the same rows instead of duplicating or wiping them.

## Architecture

Raw `records` becomes a **new, parallel source of truth**. The existing rollup pipeline and dashboard are left **untouched and working**; the web is migrated to read `records` later, separately. This keeps the change non-breaking.

```
Android (samples[] + hcId)  ──POST /api/health──►  server
                                                     ├─ existing: health_days / day_aggregates  (unchanged)
                                                     └─ NEW: records (upsert on hc_id)  ── GET /api/records?bucket=…
```

### Component boundaries

- **Android `HealthConnectManager`** — unchanged except it now stamps each `HealthSample` / `ExerciseData` with `hcId = record.metadata.id`. Still emits the same per-day rollup maps. No unit shipping (units are per-type, known server-side).
- **Server `persist`** — in addition to its current writes, upserts every mapped sample into `records`. Idempotent; never deletes.
- **Server `records` query layer** — pure SQL aggregation driven by a metric→aggregation catalog. No knowledge of Health Connect.

## Data model

### New table `records`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigserial PK | |
| `user_id` | bigint NOT NULL → users(CASCADE) | |
| `type` | text NOT NULL | metric key, e.g. `steps`, `heartRate`, `weight` |
| `hc_id` | text NOT NULL | Health Connect `metadata.id` |
| `start_at` | timestamptz NOT NULL | reading start / instant |
| `end_at` | timestamptz | interval end; null for instantaneous |
| `value_num` | double precision | primary value |
| `value_secondary` | double precision | e.g. BP diastolic |
| `value_text` | text | e.g. sleep stage, cycle enums |
| `source` | text | writing app package |
| `received_at` | timestamptz NOT NULL default now() | |

- **`UNIQUE(user_id, hc_id, start_at)`** — the idempotency key. `start_at` is in the key because a *series* record (heart rate) has one `hc_id` but many samples at distinct instants; each becomes its own row.
- Indexes: `(user_id, type, start_at)` for range+type queries; the unique constraint covers upsert.

### `exercises` — add identity

Add `hc_id text` with `UNIQUE(day_id, hc_id)`. `day_id` already resolves to one `(user_id, day)` row, so this is effectively user-scoped without adding a `user_id` column. Switch `replaceExercises` (delete-by-day) to `INSERT … ON CONFLICT (day_id, hc_id) DO UPDATE` so backfill and re-syncs are idempotent instead of wiping the day.

### Untouched

`health_days`, `day_aggregates`, and the current `samples` table remain. `samples` is now redundant with `records` but is left in place so the existing dashboard/day-view keep working until the web migration. (A later cleanup can drop `samples` once nothing reads it.)

## Aggregation semantics

The query layer needs to know how each type rolls up within a bucket. A small server-side catalog maps `type → aggregation`:

| Aggregation | Types |
|-------------|-------|
| **SUM** (interval totals) | steps, distance, activeCalories, totalCalories, floorsClimbed, elevationGained, wheelchairPushes, hydration, nutrition |
| **MIN/MAX/AVG** (distributions) | heartRate, hrv, spo2, bloodGlucose, respiratoryRate, bloodPressure (value=systolic, value2=diastolic), power, speed, bodyTemperature, vo2Max |
| **LAST** (latest wins in bucket) | weight, bodyFat, boneMass, height, leanBodyMass, restingHeartRate |
| **TEXT / passthrough** | menstruation, cervicalMucus, ovulationTest, sexualActivity, sleepStage |

## API

`GET /api/records?from=&to=&types=&bucket=raw|minute|hour|day|week`

- `from`/`to`: ISO dates/timestamps. `types`: comma list (default all the user has).
- `bucket=raw`: returns rows as stored (paged/capped — see below).
- Other buckets: `date_trunc(bucket, start_at)` grouped by `(type, bucket)`, applying the catalog aggregation. Response shape: `[{ type, bucket_start, sum?, min?, max?, avg?, last?, count }]`.
- Auth: `requireAuth`, scoped to `req.user.id`.
- **Volume guard:** `raw` responses are capped (e.g. 5000 rows) with a clear truncation flag; callers are expected to pick a coarser bucket for wide ranges. Raw heart rate can be tens of thousands of rows/day.

## Ingest flow (idempotent)

1. `mapPayload` carries `hc_id` through each sample (already carries `source`).
2. `persist`, inside its existing transaction:
   - writes `syncs`, `health_days`, `day_aggregates`, `samples` **exactly as today** (no behavior change), **and**
   - upserts each sample into `records`:
     `INSERT … ON CONFLICT (user_id, hc_id, start_at) DO UPDATE SET value_num=EXCLUDED.value_num, …` — last write wins on value, identity stable.
3. Samples with no `hc_id` (older app builds) are skipped for `records` but still flow to `samples`, so nothing regresses.

## Migration & data reset

- New migration: create `records` (+ indexes, unique constraint); add `exercises.hc_id` (+ unique) and switch its persist path to upsert.
- **Existing `samples`/`exercises` rows predate `hc_id`** and cannot be faithfully backfilled into `records`. Per user approval, the test DB may be **truncated** (`syncs`, `health_days`, `day_aggregates`, `samples`, `exercises`, `records`); a single re-sync from the phone (with backfill) repopulates `records` at full granularity.
- Migration `down` drops `records` and the `exercises.hc_id` column.

## Testing

- **Android:** existing unit tests still pass; `hcId` threads through construction (compile-level, plus a fake-record test asserting `HealthSample.hcId` is populated from `metadata.id`).
- **`mapPayload`:** asserts `hc_id` carried through samples; absent `hc_id` → null.
- **`records` aggregation (pure, no DB):** a shaping function that takes rows + bucket + catalog and returns bucketed series, unit-tested for SUM vs MIN/MAX/AVG vs LAST, bucket boundaries, and empty ranges — mirroring the existing `chartData.js` test style.
- **Idempotency:** ingesting the same payload twice yields the same `records` row count (integration-level; can be asserted via the pure upsert-key logic if a DB isn't available in CI).

## Risks / trade-offs

- **Volume:** high-frequency series (HR) grow `records` fast. Mitigated by indexes, upsert (no unbounded dupes), and the `bucket` param keeping raw out of wide queries.
- **Dual storage during transition:** `samples` and `records` coexist. Accepted deliberately to keep the change non-breaking; `samples` retired in a later cleanup.
- **Timezone:** `date_trunc` runs in a fixed zone (UTC by default). Day boundaries in the derived rollups may differ from the phone's local-zone day buckets until the web passes an explicit zone. Noted for the later web migration; not solved here.

# Per-Reading Enum Enrichment (`meta`) — Design

Date: 2026-07-24
Component: `android/` (Vitalix forwarder) + `web/` (receiver + dashboard)
Phase: **1 of 5** in the "full Health Connect data coverage" initiative.

## Where this sits

Vitalix already reads 31 Health Connect record types but, for several, extracts
only the primary value and discards the per-reading **context enums** Health
Connect attaches (a blood-pressure reading's body position, a glucose reading's
meal relation, etc.). This phase captures that context and carries it end to end
without touching any existing value.

The five-phase decomposition (each its own spec → plan → ship):

1. **This spec** — per-reading enum enrichment on already-collected records.
2. Nine new record types that fit existing patterns.
3. Skin temperature + Planned exercise (structurally novel).
4. Nutrition full nutrient panel (~26 nutrients).
5. Exercise detail + GPS route.

Phase 1 deliberately introduces the reusable primitive — a `meta` bag on each
reading — that phases 2–5 populate with their own context fields, so no later
phase needs another samples/records migration for context.

## Goal

For readings we already collect, capture the Health Connect context enums and
store them per reading, then surface them on the day-detail page. Specifically:

| Record | New context captured (HC enum) |
|--------|-------------------------------|
| Blood pressure | `bodyPosition`, `measurementLocation` |
| Blood glucose | `mealType`, `relationToMeal`, `specimenSource` |
| VO₂ max | `measurementMethod` |
| Body temperature | `measurementLocation` |

These live only at the per-reading grain. The day rollups (`health_days`,
`day_aggregates`, `day_source_metrics`) average readings together, so context
enums are meaningless there and are **not** added to them.

## Data model — the `meta` bag

A single nullable `jsonb` column named `meta` is added to both granular stores:

- `samples` (day-scoped; feeds the day-detail page)
- `records` (user-scoped UID-keyed; the modern idempotent store)

```
samples.meta   jsonb   -- nullable; {"bodyPosition":"standing","measurementLocation":"left_wrist"}
records.meta   jsonb   -- nullable; same shape
```

- Holds any number of named string tags: `{ "<enumName>": "<value>", ... }`.
- `NULL` when a reading has no context (every metric we don't enrich, and any
  enriched reading whose HC enum was unknown/unset — see below).
- Extensible: phases 2–5 add their own keys with zero further migration.
- No index in this phase — `meta` is read back per day (bounded, ≤500 rows) and
  displayed, never filtered on. An index is a later concern if a query needs it.

`health_days`, `day_aggregates`, and `day_source_metrics` are **unchanged**.

## Payload schema

The forwarder's sample object gains an optional `meta` object:

```json
{
  "metric": "bloodPressure",
  "start": "2026-07-01T08:00:00Z",
  "value": 120, "value2": 80,
  "source": "com.example.bpapp",
  "hcId": "…",
  "meta": { "bodyPosition": "standing", "measurementLocation": "left_wrist" }
}
```

`meta` is emitted **only when non-empty**. Existing samples without context
serialize exactly as they do today (key absent) — the payload for every
currently-collected reading is byte-identical.

## Android

1. **`models/HealthData.kt`** — `HealthSample` gains
   `val meta: Map<String, String>? = null` (last field, defaulted so all
   existing constructor calls are unaffected).

2. **`HealthConnectManager.kt`** — the four existing readers
   (`BloodPressureRecord`, `BloodGlucoseRecord`, `Vo2MaxRecord`,
   `BodyTemperatureRecord`) build a `meta` map from HC's `*_INT_TO_STRING_MAP`
   companion maps and pass it to the `HealthSample`. Rules:
   - Each enum resolved via its HC int→string map; an unmapped/`0`
     (`*_UNKNOWN`) value is **omitted** from the map rather than written as
     `"unknown"`, so absent context stays absent.
   - If every enum for a reading is unknown, `meta` is left `null` (empty map
     collapses to null before constructing the sample).
   - No new `ExportConfig` flags and no UI changes: enrichment rides on the
     already-enabled BP / glucose / VO₂ / body-temperature metrics.
   - Exact HC constant names (e.g. `BloodPressureRecord.BODY_POSITION_INT_TO_STRING_MAP`,
     `MealType.MEAL_TYPE_INT_TO_STRING_MAP`, `Vo2MaxRecord.MEASUREMENT_METHOD_INT_TO_STRING_MAP`,
     `BodyTemperatureMeasurementLocation.*` / `BodyTemperatureRecord.*`) are
     resolved against the `connect-client 1.1.0-alpha07` API in the plan; the
     map-name is an implementation detail, the produced key names in the table
     above are the contract.

3. **`ServerForwarder.kt`** — `sampleJson` serializes `meta` as a nested
   `JSONObject` iff the map is non-null and non-empty:
   `s.meta?.takeIf { it.isNotEmpty() }?.let { put("meta", JSONObject(it)) }`.

## Web

4. **Migration** `web/migrations/<ts>_reading_meta.cjs` — add nullable
   `meta jsonb` to `samples` and `records`. No backfill (historical readings
   never carried context). `down` drops both columns.

5. **`mapPayload.js`** — `mapSamples` carries `meta: r.meta ?? null` onto each
   mapped sample. Value passed through as-is (an object or null); no per-key
   validation in this phase.

6. **`persist.js`** — `replaceSamples` adds `meta` to the `samples` INSERT
   column list and values (`JSON.stringify` / `pg` jsonb binding of the object,
   or `null`); `upsertRecords` adds `meta` to the `records` INSERT column list,
   values, and the `ON CONFLICT … DO UPDATE SET` clause (so a re-sync refreshes
   context). `null` meta writes SQL `NULL`.

7. **`/dashboard/:date`** (`routes/pages.js`) — the samples query
   (`SELECT metric,start_at,end_at,value_num,value_secondary,value_text,source
   FROM samples …`) adds `meta`.

8. **`views/day.ejs`** — each sample row renders its `meta` tags when present,
   as a compact ` · `-joined, human-readable string
   (e.g. `standing · left wrist`). Rows without `meta` render exactly as today.

## Backward compatibility

- Older app builds that never send `meta` → `mapSamples` yields `null` → columns
  stay `NULL` → the day-detail view renders identically.
- The new `meta jsonb` columns are nullable with no default; existing rows are
  untouched by the migration.
- No day-rollup, dashboard-chart, or source-filter behavior changes.

## Testing

- **`mapPayload`** (pure, `node:test`): a sample with a `meta` object maps it
  through unchanged; a sample without `meta` maps to `meta: null`.
- **`ServerForwarder`** (JVM unit): a `HealthSample` with a non-empty `meta`
  serializes a nested `meta` JSON object; a sample with `null`/empty `meta`
  emits **no** `meta` key.
- **`HealthConnectManager`** (JVM unit, fake `RecordReader`): a blood-pressure
  reading with known position/location enums produces the expected `meta` keys;
  an all-unknown reading produces `null` `meta`.
- Migration up/down: `node --check`; live `meta` round-trip
  (insert object → read back equal) verified in an environment with Postgres.

## Files touched

- `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`
- `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`
- `android/app/src/test/…` — ServerForwarder + HealthConnectManager tests
- `web/migrations/<ts>_reading_meta.cjs`
- `web/src/mapPayload.js`
- `web/src/persist.js`
- `web/src/routes/pages.js`
- `web/views/day.ejs`
- `web/test/…` — mapPayload meta pass-through
- `docs/database-erd.md` — note `meta` on `samples` and `records`

# Close Health Connect data-coverage gaps — design

Status: approved design, ready for implementation plan.
Date: 2026-07-25.
Companion audit: [`docs/health-connect-data-coverage.md`](../../health-connect-data-coverage.md) — update it when this ships.

## Goal

Capture every Health Connect record type and field Vitalix currently omits, so
the server holds the user's full on-device health history at native granularity.
After this, the coverage audit should show **41 of 42** record types captured
(only `PlannedExerciseSessionRecord` intentionally skipped) and no field-level
gaps on the types we already read.

## Scope

**In:**
- 10 missing record types (all except `PlannedExerciseSessionRecord`).
- Exercise enrichment: laps, segments, **GPS route** (new location permission).
- Nutrition: all ~40 nutrient fields + `mealType`.
- CervicalMucus `sensation` field.

**Out:**
- `PlannedExerciseSessionRecord` — a future workout template, not recorded data.
- Per-day summary rollups for the new types. They flow into the generic
  `records`/`samples` tables only; the web re-aggregates from `records`. No new
  `health_days`/`day_aggregates` columns.

## Guiding principle — ride the generic path

The `samples` (on-device `HealthSample`) and server `records` tables are already
generic: `metric` + `start`/`end` + `value`/`value2`/`text` + `meta` + `hcId`.
Any new metric flows end-to-end with **no schema migration** — it needs only a
permission, an `ExportConfig` flag, a `perMetric{}` block, a UI checkbox, and one
entry in the web `records.js` aggregation catalog. Only the nested exercise
structures (route/laps/segments) fall outside this model and need one migration.

## A. The 10 new record types

Each follows the established `perMetric{}` pattern in `HealthConnectManager`.
Series types emit one `HealthSample` per inner reading (like `heartRate`);
value-less types emit a `text`/`meta`-only presence sample.

| Metric key | Record class | Shape | Sample encoding | records.js aggregation |
|------------|--------------|-------|-----------------|------------------------|
| `activityIntensity` | `ActivityIntensityRecord` | Interval | `text` = intensity type | LAST/TEXT |
| `cyclingCadence` | `CyclingPedalingCadenceRecord` | Series | `value` = RPM per sample | minmaxavg |
| `stepsCadence` | `StepsCadenceRecord` | Series | `value` = steps/min per sample | minmaxavg |
| `basalMetabolicRate` | `BasalMetabolicRateRecord` | Instant | `value` = kcal/day | LAST |
| `bodyWaterMass` | `BodyWaterMassRecord` | Instant | `value` = kg | LAST |
| `skinTemperature` | `SkinTemperatureRecord` | Series | `value` = delta °C per sample; `meta.measurementLocation`, `meta.baseline` | minmaxavg |
| `basalBodyTemperature` | `BasalBodyTemperatureRecord` | Instant | `value` = °C; `meta.measurementLocation` | LAST |
| `intermenstrualBleeding` | `IntermenstrualBleedingRecord` | Instant | presence marker (`value` = 1) | SUM (count) |
| `menstruationPeriod` | `MenstruationPeriodRecord` | Interval | span only (`start`/`end`, `value` = 1) | LAST |
| `mindfulness` | `MindfulnessSessionRecord` | Interval | `value` = duration min; `text` = session type | SUM |

Notes:
- `activityIntensityType`, mindfulness `mindfulnessSessionType`, and skin-temp
  location resolve via HC's `*_INT_TO_STRING_MAP` where public, else a local map
  in `MetaMappers` (same convention already used for flow/appearance).
- `SkinTemperatureRecord` stores per-instant **deltas** plus an optional record
  baseline; the baseline goes into `meta` so a consumer can reconstruct absolute
  temperature.

### CervicalMucus `sensation`
Add `sensation` to the existing `CervicalMucus` sample's `meta` via a
`MetaMappers.cervicalMucusMeta(appearance, sensation)` helper (keep `appearance`
as the primary `text`, add `sensation` to meta).

## B. Nutrition — nutrient-per-metric

Instead of one `nutrition` sample carrying energy, emit **one sample per
populated nutrient field**, keyed `nutrition.<field>` (e.g. `nutrition.protein`,
`nutrition.sugar`, `nutrition.calcium`). Each is a normal interval sample:
`value` = the amount in HC's canonical unit, `meta.mealType` on every sample.

- Only non-null fields are emitted (HC leaves most nutrients null).
- Existing `energyKcal` day-rollup and the current `nutrition` (energy) sample
  stay as-is for backward compatibility; the nutrient samples are additive.
- `records.js`: nutrient metrics aggregate as SUM. Add a prefix rule so any
  `nutrition.*` metric defaults to SUM without listing all 40.
- No schema change — nutrients are just more rows in `records`/`samples`.

Nutrient fields to iterate (HC `NutritionRecord`): biotin, caffeine, calcium,
energy, energyFromFat, chloride, cholesterol, chromium, copper, dietaryFiber,
folate, folicAcid, iodine, iron, magnesium, manganese, molybdenum,
monounsaturatedFat, niacin, pantothenicAcid, phosphorus, polyunsaturatedFat,
potassium, protein, riboflavin, saturatedFat, selenium, sodium, sugar,
thiamin, totalCarbohydrate, totalFat, transFat, unsaturatedFat, vitaminA,
vitaminB12, vitaminB6, vitaminC, vitaminD, vitaminE, vitaminK, zinc. Iterated
via a single table of `(key, extractor)` pairs so the `perMetric` block stays
compact.

## C. Exercise route, laps, segments

These are nested and cannot ride the flat sample model, so they attach to the
`ExerciseData` object as structured data and persist to a new JSON column.

**On-device (`ExerciseData`):**
- `laps: List<{start, end, length?}>`
- `segments: List<{start, end, type}>`
- `route: List<{time, lat, lng, altitude?, horizontalAccuracy?, verticalAccuracy?}>`

**Permission:** add the exercise-route read permission. Route data is only
present when the user grants it and the writing app recorded GPS.

**Payload:** `ServerForwarder` serializes these under each exercise object:
`{name, start, durationMinutes, source, hcId, laps?, segments?, route?}`.

**Web (the plan's only migration):**
- Add `exercises.detail jsonb` (nullable). `persist.js` writes
  `{laps, segments, route}` into it; `mapPayload` carries the three arrays through.
- `day.ejs` shows lap/segment counts and a "has route" indicator (full route
  rendering is the user's later web work).

## D. UI / permissions

- `ExportConfig` gains an `include*` flag per new metric (nutrients gated by a
  single `includeNutritionDetail` flag; route by `includeExerciseRoute`).
- `MainActivity`/settings: a checkbox per new metric grouped under the existing
  categories; a distinct consent affordance for GPS route (separate permission).
- `HealthConnectManager.permissions` gains the new read permissions incl.
  `ExerciseRouteRecord`/route permission.

## Component boundaries (unchanged)

`HealthConnectManager` still only knows HC (in: `ExportConfig`, out:
`List<DailyHealthData>`). `MetaMappers` stays pure enum→map. `ServerForwarder`
still only knows JSON+HTTP. New nutrient/enum mapping lives in `MetaMappers`
and a nutrient extractor table local to the manager.

## Testing

- **`MetaMappers`** unit tests: new mappers (activityIntensity, mindfulness,
  skinTemperature location, cervicalMucus sensation) — known enum → string,
  unknown → omitted.
- **`HealthConnectManager`** (fake `RecordReader`): each new type produces the
  expected sample(s) at native granularity; series types fan out per inner
  sample; nutrient extraction emits one sample per non-null field with `mealType`
  meta; exercise route/laps/segments populate `ExerciseData`.
- **Web `records.js`**: `nutrition.*` prefix → SUM; new metric keys map to the
  right aggregation; injection guard still holds.
- **Web `mapPayload`/`persist`**: exercise `detail` round-trips; nutrient samples
  land in `records`.
- **Idempotency**: re-syncing the same payload yields no duplicate `records`
  (existing `UNIQUE(user_id, hc_id, start_at)` still applies).

## Rollout

Non-breaking and additive: existing metrics, payloads, and rollups are
untouched. New metrics appear only when the user enables them and grants the
relevant permission. The single `exercises.detail` migration is nullable.

## Definition of done

- 41/42 record types captured; audit doc updated.
- All new metrics visible in the `records` table at native granularity after a
  device sync.
- `docs/health-connect-data-coverage.md` tables flip the newly-captured rows to
  ✅ and remove the closed field-gap notes.

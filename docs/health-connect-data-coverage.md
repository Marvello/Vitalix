# Health Connect data coverage

Audit of what Vitalix reads from Health Connect against the official data-type
list: <https://developer.android.com/health-and-fitness/health-connect/data-types?jetpack=alpha10plus>.

Covers not just the category grouping but the **fields** and **granularity** of
each record type, plus a **sample of how the data is stored** end to end.

> **Keep this current.** When you add a record type, a field, or change how a
> metric is captured/stored, update the tables and the sample below in the same
> change. Source of truth for capture:
> `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`.

Last verified: 2026-07-27 against `connect-client 1.2.0-alpha04`.

## Record shapes (granularity primer)

Health Connect stores each type in one of three shapes. Vitalix keeps data at
the **native granularity** of the record — every individual record and, for
series records, every per-instant sample is emitted as a raw `HealthSample`
carrying `start`/`end`, `value`(+`value2`/`text`), `source` (writing app), and
`hcId` (record UID). Per-day rollups are computed on top; the raw samples let the
web re-aggregate to any granularity later.

| Shape | Fields | How we store it |
|-------|--------|-----------------|
| **Instantaneous** | single `time` | one sample at `time` |
| **Interval** | `startTime`/`endTime` | one sample spanning start→end |
| **Series** | interval holding a `samples[]` array of per-instant readings | one sample **per inner reading** (finest possible) |

## Coverage summary

- **Captured: 41 record types** across all six standard categories.
- **Not captured: 1 record type** (`PlannedExerciseSessionRecord`; see [Gaps](#not-captured)).
- No remaining field-level gaps on captured types: Exercise now carries
  laps/segments/route, Nutrition all ~40 nutrients, Cervical Mucus `sensation`.

## Activity

| Data type | Record class | Shape | Captured | Fields taken / dropped |
|-----------|--------------|-------|:--------:|------------------------|
| Active calories | `ActiveCaloriesBurnedRecord` | Interval | ✅ | `energy`→kcal |
| Distance | `DistanceRecord` | Interval | ✅ | `distance`→m |
| Elevation gained | `ElevationGainedRecord` | Interval | ✅ | `elevation`→m |
| Exercise session | `ExerciseSessionRecord` | Interval | ✅ | `title`/`exerciseType`, duration, `laps`, `segments`, GPS `route` (route needs `READ_EXERCISE_ROUTES` + user consent) |
| Floors climbed | `FloorsClimbedRecord` | Interval | ✅ | `floors` |
| Power | `PowerRecord` | Series | ✅ | per-sample `power`→W |
| Speed | `SpeedRecord` | Series | ✅ | per-sample `speed`→m/s |
| Steps | `StepsRecord` | Interval | ✅ | `count` |
| Total calories | `TotalCaloriesBurnedRecord` | Interval | ✅ | `energy`→kcal |
| VO₂ max | `Vo2MaxRecord` | Instantaneous | ✅ | `vo2…`, meta: `measurementMethod` |
| Wheelchair pushes | `WheelchairPushesRecord` | Interval | ✅ | `count` |
| Activity intensity | `ActivityIntensityRecord` | Interval | ✅ | intensity type string (`text`), meta: `intensityType` |
| Cycling pedaling cadence | `CyclingPedalingCadenceRecord` | Series | ✅ | per-sample `revolutionsPerMinute` |
| Planned exercise | `PlannedExerciseSessionRecord` | Interval | ❌ | — |
| Steps cadence | `StepsCadenceRecord` | Series | ✅ | per-sample `rate` |

## Body measurement

| Data type | Record class | Shape | Captured | Fields taken / dropped |
|-----------|--------------|-------|:--------:|------------------------|
| Body fat | `BodyFatRecord` | Instantaneous | ✅ | `percentage` |
| Bone mass | `BoneMassRecord` | Instantaneous | ✅ | `mass`→kg |
| Height | `HeightRecord` | Instantaneous | ✅ | `height`→m |
| Lean body mass | `LeanBodyMassRecord` | Instantaneous | ✅ | `mass`→kg |
| Weight | `WeightRecord` | Instantaneous | ✅ | `weight`→kg |
| Basal metabolic rate | `BasalMetabolicRateRecord` | Instantaneous | ✅ | `basalMetabolicRate`→kcal/day |
| Body water mass | `BodyWaterMassRecord` | Instantaneous | ✅ | `mass`→kg |

## Vitals

| Data type | Record class | Shape | Captured | Fields taken / dropped |
|-----------|--------------|-------|:--------:|------------------------|
| Blood glucose | `BloodGlucoseRecord` | Instantaneous | ✅ | `level`→mg/dL, meta: `mealType`,`relationToMeal`,`specimenSource` |
| Blood pressure | `BloodPressureRecord` | Instantaneous | ✅ | `systolic`+`diastolic`→mmHg, meta: `bodyPosition`,`measurementLocation` |
| Body temperature | `BodyTemperatureRecord` | Instantaneous | ✅ | `temperature`→°C, meta: `measurementLocation` |
| Heart rate | `HeartRateRecord` | Series | ✅ | per-sample `beatsPerMinute` |
| Heart rate variability | `HeartRateVariabilityRmssdRecord` | Instantaneous | ✅ | `heartRateVariabilityMillis` |
| Oxygen saturation | `OxygenSaturationRecord` | Instantaneous | ✅ | `percentage` |
| Respiratory rate | `RespiratoryRateRecord` | Instantaneous | ✅ | `rate` |
| Resting heart rate | `RestingHeartRateRecord` | Instantaneous | ✅ | `beatsPerMinute` |
| Skin temperature | `SkinTemperatureRecord` | Series | ✅ | per-`delta`→°C, meta: `measurementLocation`,`baseline` |

## Sleep

| Data type | Record class | Shape | Captured | Fields taken / dropped |
|-----------|--------------|-------|:--------:|------------------------|
| Sleep session | `SleepSessionRecord` | Interval | ✅ | duration + per-`stage` (deep/light/rem/awake…) as `sleepStage` samples |

## Nutrition

| Data type | Record class | Shape | Captured | Fields taken / dropped |
|-----------|--------------|-------|:--------:|------------------------|
| Hydration | `HydrationRecord` | Interval | ✅ | `volume`→mL |
| Nutrition | `NutritionRecord` | Interval | ✅ | day rollup `energy`→kcal; with **Nutrition detail** on, one `nutrition.<field>` sample per non-null nutrient (~40 macros/vitamins/minerals), meta: `mealType` |

## Cycle tracking

| Data type | Record class | Shape | Captured | Fields taken / dropped |
|-----------|--------------|-------|:--------:|------------------------|
| Cervical mucus | `CervicalMucusRecord` | Instantaneous | ✅ | `appearance` (`text`), meta: `sensation` |
| Menstruation flow | `MenstruationFlowRecord` | Instantaneous | ✅ | `flow` |
| Ovulation test | `OvulationTestRecord` | Instantaneous | ✅ | `result` |
| Sexual activity | `SexualActivityRecord` | Instantaneous | ✅ | `protectionUsed` |
| Basal body temperature | `BasalBodyTemperatureRecord` | Instantaneous | ✅ | `temperature`→°C, meta: `measurementLocation` |
| Intermenstrual bleeding | `IntermenstrualBleedingRecord` | Instantaneous | ✅ | presence flag (`value`=1) |
| Menstruation period | `MenstruationPeriodRecord` | Interval | ✅ | period span start→end (`value`=1) |

## Wellness

| Data type | Record class | Shape | Captured | Fields taken / dropped |
|-----------|--------------|-------|:--------:|------------------------|
| Mindfulness | `MindfulnessSessionRecord` | Interval | ✅ | duration + `title`, meta: `mindfulnessSessionType` |

## Not captured

Only `PlannedExerciseSessionRecord` is not read. Adding it means: a new
`HealthPermission.getReadPermission(...)` entry, an `include*` flag in
`ExportConfig`, a `perMetric{}` block, and a UI checkbox.

| Category | Missing types |
|----------|---------------|
| Activity | PlannedExercise |

No field-level gaps remain on captured types.

## How the data is stored

Two representations leave the phone in one payload, and land in two places on
the server.

### 1. On-device → JSON payload (`ServerForwarder.buildPayload`)

Each day carries its rollups **and** the raw samples. Only enabled metrics
appear; absent ones are omitted, not null.

```json
{
  "source": "vitalix",
  "appVersion": "1.0.0",
  "device": "SM-S928B",
  "exportedAt": "2026-07-25T09:00:00Z",
  "rangeDays": 7,
  "days": [
    {
      "date": "2026-07-24",
      "activity": { "steps": 8123, "distance": 6100.0, "activeCalories": 412.0 },
      "body": { "weight": 71.2 },
      "vitals": {
        "heartRate": { "min": 52, "max": 146, "avg": 68 },
        "restingHeartRate": 54,
        "bloodPressure": { "systolic": { "avg": 118 }, "diastolic": { "avg": 76 } }
      },
      "sleep": { "durationMinutes": 431, "stages": { "deep": 78, "light": 240, "rem": 96, "awake": 17 } },
      "exercises": [
        { "name": "Running", "start": "2026-07-24T06:12:00Z", "durationMinutes": 32,
          "source": "com.google.android.apps.fitness", "hcId": "ex-abc123" }
      ],
      "samples": [
        { "metric": "heartRate", "start": "2026-07-24T10:04:12Z", "value": 68,
          "source": "com.samsung.health", "hcId": "hr-9f2a" },
        { "metric": "steps", "start": "2026-07-24T10:00:00Z", "end": "2026-07-24T11:00:00Z",
          "value": 412, "source": "com.samsung.health", "hcId": "st-0011" },
        { "metric": "bloodPressure", "start": "2026-07-24T07:30:00Z", "value": 118, "value2": 76,
          "source": "com.omron.connect", "hcId": "bp-77",
          "meta": { "bodyPosition": "standing", "measurementLocation": "left_wrist" } },
        { "metric": "sleepStage", "start": "2026-07-24T00:12:00Z", "end": "2026-07-24T01:30:00Z",
          "text": "deep", "source": "com.samsung.health", "hcId": "sl-5" }
      ]
    }
  ]
}
```

### 2. Server → Postgres

The receiver (`web/`) writes three things (see `web/src/persist.js`):

- **`health_days`** — one row per day, the scalar rollups (steps, weight, sleep_duration_minutes, …).
- **`day_aggregates`** — min/max/avg per aggregated metric for that day.
- **`samples`** — every raw reading, scoped to its day; carries `source`, `meta`, and `hc_id`.
- **`records`** — the **granular, day-independent source of truth**, keyed on the
  Health Connect record UID (`hc_id`) so re-syncs are idempotent (`UNIQUE(user_id, hc_id, start_at)`).
  `GET /api/records` re-aggregates these to any bucket (raw/minute/hour/day/week) via SQL `date_trunc`.

A `records` row for the heart-rate sample above:

| column | value |
|--------|-------|
| `user_id` | 3 |
| `type` | `heartRate` |
| `hc_id` | `hr-9f2a` |
| `start_at` | `2026-07-24T10:04:12Z` |
| `end_at` | `null` |
| `value_num` | `68` |
| `value_secondary` | `null` |
| `value_text` | `null` |
| `source` | `com.samsung.health` |
| `received_at` | `2026-07-25T09:00:03Z` |

Blood-pressure fills both numerics (`value_num`=systolic, `value_secondary`=diastolic);
sleep stages fill `value_text`; per-reading context enums land in the `samples.meta` JSON.

See also: [`database-erd.md`](database-erd.md) for the full schema.

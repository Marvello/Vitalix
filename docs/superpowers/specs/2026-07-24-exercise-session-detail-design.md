# Exercise Session Detail (5a) — Design

Date: 2026-07-24
Component: `android/` (Vitalix forwarder) + `web/` (receiver + day-detail page)
Phase: **5a of the "full Health Connect data coverage" initiative** (Phase 5 split
into 5a session detail + 5b GPS route/map).

## Where this sits

Vitalix stores each exercise session as only `(name, start_at,
duration_minutes, source, hc_id)`, discarding everything else Health Connect's
`ExerciseSessionRecord` carries. This sub-phase captures the session's direct
detail fields and a derived per-session activity total, surfaced on the
day-detail page. The GPS route (`exerciseRoute`) is **5b** and out of scope
here.

Phase decomposition: 1 (per-reading meta — shipped) · 2 new record types · 3
skin temp + planned exercise · 4 nutrition panel · **5a this spec** · 5b
exercise GPS route + SVG map.

## Goal

For each exercise session, capture the direct Health Connect fields and show a
fuller picture on `/dashboard/:date`:

| Field | Source |
|-------|--------|
| `end_at` | `ExerciseSessionRecord.endTime` |
| `exercise_type` | canonical type string via HC's exercise-type int→string map |
| `notes` | `ExerciseSessionRecord.notes` |
| `segments` | `ExerciseSessionRecord.segments` → `[{start, end, type, reps}]` |
| `laps` | `ExerciseSessionRecord.laps` → `[{start, end, lengthMeters?}]` |
| derived `distance` / `activeEnergy` / `steps` | summed from the `records` store over the session window (computed web-side at render) |

`name` (already `title ?? typeString`) is unchanged and stays the display label.

## Data model

`exercises` gains five nullable columns:

```
exercises
  ... id, day_id, name, start_at, duration_minutes, source, hc_id (unchanged)
+ end_at        timestamptz
+ exercise_type text
+ notes         text
+ segments      jsonb   -- [{ "start": iso, "end": iso, "type": "…", "reps": n }]
+ laps          jsonb   -- [{ "start": iso, "end": iso, "lengthMeters": m|null }]
```

- `segments` / `laps` are bounded, display-only arrays — stored as `jsonb`
  (same rationale as phase-1 `meta`), not normalized into child tables.
- Derived `distance` / `activeEnergy` / `steps` are **not stored** — they are
  computed at query time from `records` (which already holds every reading with
  a timestamp and source). No column, no denormalized total to keep in sync.

`health_days`, `day_aggregates`, `day_source_metrics`, `samples`, `records`
are unchanged.

## Payload schema

The forwarder's exercise object gains optional fields, each emitted only when
present/non-empty (so an exercise with none of them serializes byte-identically
to today):

```json
{
  "name": "Running",
  "start": "2026-07-20T06:12:00Z",
  "durationMinutes": 32,
  "source": "com.google.android.apps.fitness",
  "hcId": "ex-uid-1",
  "end": "2026-07-20T06:44:00Z",
  "exerciseType": "running",
  "notes": "morning loop",
  "segments": [{ "start": "…", "end": "…", "type": "running", "reps": 0 }],
  "laps": [{ "start": "…", "end": "…", "lengthMeters": 400.0 }]
}
```

## Android

1. **`models/HealthData.kt`** — `ExerciseData` gains, all defaulted:
   `endDateTime: String? = null`, `exerciseType: String? = null`,
   `notes: String? = null`, `segments: List<ExerciseSegmentData> = emptyList()`,
   `laps: List<ExerciseLapData> = emptyList()`. Two small data classes:
   `ExerciseSegmentData(start, end, type, reps)` and
   `ExerciseLapData(start, end, lengthMeters: Double?)`.

2. **`HealthConnectManager.kt`** — the existing `ExerciseSessionRecord` reader
   populates the new fields from `r.endTime`, the HC exercise-type int→string
   map, `r.notes`, `r.segments` (segment type via HC's exercise-segment-type
   map; `repetitions`), and `r.laps` (`length?.inMeters`). Unknown enum values
   follow the phase-1 rule (resolved-string `"unknown"`/absent ⇒ omitted). No
   new `ExportConfig` flag — rides the already-enabled Exercise metric. Exact HC
   constant names (`ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP`,
   `ExerciseSegment.*_INT_TO_STRING_MAP`, property names) are resolved against
   `connect-client 1.1.0-alpha07` in the plan.

3. **`ServerForwarder.kt`** — the exercise JSON builder adds `end`,
   `exerciseType`, `notes`, `segments`, `laps`, each guarded (`?.let` / skip
   empty list), matching the existing `source`/`hcId` pattern.

## Web

4. **Migration** `web/migrations/<ts>_exercise_detail.cjs` — add the five
   nullable columns to `exercises`. No backfill. `down` drops them.

5. **`mapPayload.js`** — `mapExercises` carries `end_at`, `exercise_type`,
   `notes`, `segments`, `laps` (arrays/objects as-is, or null/`[]`).

6. **`persist.js`** — `replaceExercises` writes the new columns in **both** the
   `hc_id` upsert (including the `ON CONFLICT … DO UPDATE SET` clause, so
   re-syncs refresh detail) and the no-`hc_id` insert.

7. **`stats.js`** — new `sessionTotals(userId, startAt, endAt)` →
   `{ distance, activeEnergy, steps }`. One query summing `records`:
   `SELECT type, sum(value_num) … WHERE user_id=$1 AND type = ANY(ARRAY['distance','activeCalories','steps']) AND start_at >= $2 AND start_at < $3 GROUP BY type`.
   Parameterized; user-scoped.

8. **`routes/pages.js`** — `/dashboard/:date` selects the new exercise columns,
   and for each exercise calls `sessionTotals` (bounded: few sessions/day) to
   attach `{ distance, activeEnergy, steps }`.

9. **`views/day.ejs`** — the exercises table gains columns **End, Type,
   Distance (km), Energy (kcal), Steps, Notes**, plus a compact
   **segments/laps** summary per row (e.g. `3 segments · 4 laps`, with the
   detail rendered as a small nested list). Rows lacking a field show `—`.

## Backward compatibility

- Every new field is nullable/optional at every layer; an exercise with none of
  them forwards, stores, and renders exactly as today.
- Derived totals are additive display only; when a session has no overlapping
  `records`, they render `—` (a zero sum coalesces to null).
- No rollup, main-dashboard-chart, or `ExportConfig` changes. The existing
  `exerciseBreakdown` main-dashboard view is untouched.

## Accepted caveats

- **Derived totals sum across all sources** in the session window. If two apps
  double-report distance/steps/calories, the total can exceed reality — the same
  accepted caveat as the source-comparison feature. Energy uses `activeCalories`
  (not `totalCalories`) as the exercise-relevant measure.
- **Window boundary:** `records` are matched by `start_at` falling in
  `[session.start, session.end)`; a reading straddling the session edge is
  attributed by its start. Acceptable for a display heuristic.

## Testing

- **`ServerForwarder`** (JVM): an `ExerciseData` with end/type/notes/segments/
  laps serializes them (nested arrays for segments/laps); one with none emits no
  new keys.
- **`HealthConnectManager`** (JVM, fake reader): a session with two segments and
  one lap produces the expected `segments`/`laps` shapes and `exercise_type`.
- **`mapPayload`** (pure `node:test`): exercise fields pass through; missing
  ones default to null/`[]`.
- **`stats.sessionTotals`** shaping: unit-test the row→`{distance,activeEnergy,
  steps}` transform with fixture rows (extract a pure shaper if it aids testing).
- Migration up/down: `node --check`; live column round-trip where Postgres is
  available.

## Files touched

- `android/app/src/main/java/com/android/vitalix/models/HealthData.kt`
- `android/app/src/main/java/com/android/vitalix/HealthConnectManager.kt`
- `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`
- `android/app/src/test/…` — ServerForwarder + HealthConnectManager exercise tests
- `web/migrations/<ts>_exercise_detail.cjs`
- `web/src/mapPayload.js`, `web/src/persist.js`, `web/src/stats.js`, `web/src/routes/pages.js`
- `web/views/day.ejs`
- `web/test/…` — mapPayload exercise fields + sessionTotals shaping
- `docs/database-erd.md` — the five new `exercises` columns

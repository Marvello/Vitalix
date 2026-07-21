# Vitalix — Health Connect → Your Server (Design)

**Date:** 2026-07-21
**Status:** Draft for review
**Package:** `com.android.vitalix` (existing Vitalix project)
**Origin:** Clone of `teqxnology/healthexport`, with the export destination swapped from Google Sheets/CSV to a self-hosted server webhook.

---

## Summary

Vitalix reads Health Connect data on-device and forwards it as JSON to a server the
user controls. Privacy-first, self-hosted: no Google Sheets, no CSV, no third-party
data path. The user configures a server URL (and optional bearer token), selects which
health metrics to include, and the app forwards data manually ("Sync now") or on a
background schedule.

### Decisions locked during brainstorming

| Question | Decision |
|----------|----------|
| Server contract | Generic HTTP `POST` JSON to a user-configured URL (webhook), optional `Bearer` token |
| Metric scope | **Full parity** — all 30+ Health Connect metrics healthexport's UI lists |
| Project home | Build into existing `com.android.vitalix` project; `android/healthexport/` stays as reference |
| Destinations | **Server only** — drop Sheets and CSV |
| Triggers | Manual **+** scheduled auto-forward (WorkManager); drop reminder notifications |
| UI framework | Views/XML (matches both the Vitalix template and the healthexport source) |

### Critical context: the source is incomplete

The upstream `healthexport` repo had its code deleted (recoverable from git history at
commit `93ee70b^`). Even the recovered tree is **missing `HealthConnectManager`** — the
class that actually reads Health Connect data. It is referenced 12× but was never
committed. **We must write the entire data-reading engine from scratch.** The recovered
`MainActivity` UI, data models, and worker scaffolding are reusable references.

---

## Architecture / Components

| Component | Status | Role |
|-----------|--------|------|
| `HealthConnectManager.kt` | **NEW (missing core)** | Declares HC permissions for all record types; `readHealthDataByDay(config): List<DailyHealthData>`. Per-day aggregation across all metrics + exercise sessions, **and emits the raw underlying records as a per-day `samples` list** (see Raw samples). `saferExportMode` chunks reads to avoid HC rate limits. |
| `models/HealthData.kt` | reuse + extend | `DailyHealthData`, `ExerciseData`, `BodyMeasurementData`, `ExportConfig`, `MinMaxAvg` kept from recovered source; **add `HealthSample`** (`metric, start, end?, value?, value2?, text?`) and a `samples: List<HealthSample>` field on `DailyHealthData`. |
| `ServerForwarder.kt` | **NEW (replaces `SheetsManager`)** | Builds JSON payload, `POST`s to configured URL, adds `Authorization: Bearer` if a token is set, returns `Result`. OkHttp for timeouts/retry. |
| `SyncSettings.kt` | **NEW** | Wraps `EncryptedSharedPreferences` for `serverUrl` + `authToken`; plain prefs for metric flags, schedule, `lastSync`. |
| `ExportWorker.kt` | adapt | Swap `SheetsManager` → `ServerForwarder`; keep foreground notification + WorkManager retry semantics. |
| `MainActivity.kt` | adapt | Replace Google-account/spreadsheet UI with server-URL + token fields; keep metric checkboxes + date-range selection; add "Sync now" button + auto-sync toggle; keep HC permission request flow. |
| **Dropped** | removed | `SheetsManager`, `CsvExporter`, `CsvGuidanceActivity`, `ManualExportReminderWorker`, all Google Sheets / Google auth dependencies. |

### Design boundaries

- **`HealthConnectManager`** — knows only Health Connect. Input: `ExportConfig`. Output:
  `List<DailyHealthData>`. No knowledge of the network or settings storage.
- **`ServerForwarder`** — knows only how to turn `List<DailyHealthData>` into JSON and
  `POST` it. No knowledge of Health Connect.
- **`SyncSettings`** — the single source of truth for configuration. Both `MainActivity`
  and `ExportWorker` read/write through it; neither touches `SharedPreferences` directly.

This keeps each unit independently testable: the JSON builder and the settings mapping
are pure/near-pure and unit-testable without a device.

---

## Data Flow

```
configure(serverUrl, token, metrics, rangeDays)   [MainActivity → SyncSettings]
  → "Sync now" tap  OR  scheduled WorkManager tick
  → HealthConnectManager.readHealthDataByDay(config) : List<DailyHealthData>
  → ServerForwarder.buildPayload(days, meta) : JSON
  → POST serverUrl   (Authorization: Bearer <token> if set)
  → 2xx  ⇒ SyncSettings.lastSync = now
  → non-2xx / network error ⇒ retry (auto) / show error (manual)
```

- **Manual:** forwards the full user-selected `rangeDays` window.
- **Auto:** forwards data since `lastSync` (default 1 day back), matching the original
  `ExportWorker` behavior.

---

## Payload Schema (webhook contract)

`POST <serverUrl>`
`Content-Type: application/json`
`Authorization: Bearer <token>`  *(only if token configured)*

```json
{
  "source": "vitalix",
  "appVersion": "1.0.0",
  "device": "Pixel 8",
  "exportedAt": "2026-07-21T09:00:00Z",
  "rangeDays": 7,
  "days": [
    {
      "date": "2026-07-20",
      "activity":  { "steps": 8123, "activeCalories": 412.0, "distance": 6100.0, "floorsClimbed": 12, "totalCalories": 2210.0, "vo2Max": 44.1 },
      "body":      { "weight": 71.2, "bodyFat": 18.4, "boneMass": 3.1, "height": 178.0, "leanBodyMass": 58.0 },
      "vitals":    { "heartRate": {"min":52,"max":146,"avg":68}, "restingHeartRate": 54, "hrv": 42.0, "spo2": {"min":95,"max":99,"avg":97}, "bloodGlucose": {...}, "bloodPressure": {...}, "bodyTemperature": 36.6, "respiratoryRate": 14.0 },
      "sleep":     { "durationMinutes": 431, "stages": { "deep": 78, "light": 240, "rem": 96, "awake": 17 } },
      "cycle":     { "menstruation": "...", "cervicalMucus": "...", "ovulationTest": "...", "sexualActivity": "..." },
      "nutrition": { "hydrationMl": 1800, "energyKcal": 2100 },
      "exercises": [ { "name": "Running", "start": "2026-07-20T06:12:00Z", "durationMinutes": 32 } ],
      "samples": [
        { "metric": "heartRate",     "start": "2026-07-20T10:04:12Z", "value": 68 },
        { "metric": "steps",         "start": "2026-07-20T10:00:00Z", "end": "2026-07-20T11:00:00Z", "value": 412 },
        { "metric": "bloodPressure", "start": "2026-07-20T07:30:00Z", "value": 118, "value2": 76 },
        { "metric": "sleepStage",    "start": "2026-07-20T00:12:00Z", "end": "2026-07-20T01:30:00Z", "text": "deep" }
      ]
    }
  ]
}
```

**Rules**
- Only metrics the user enabled appear; disabled metrics are omitted (not null).
- Numeric aggregate metrics (heart rate, SpO2, glucose, BP) use `MinMaxAvg`.
- `exercises` is an array of sessions for that day.
- One `POST` carries the whole export (all days in one request). If payloads grow large,
  a future revision can chunk by day — out of scope for v1.

### Raw samples (added — detail granularity)

Alongside the per-day summary, every **enabled** metric also forwards its underlying
timestamped Health Connect records in a per-day `samples` array. This gives the receiver
both a fast daily view and full drill-down. `HealthConnectManager` already reads these raw
records to compute the aggregates, so it emits the same records rather than re-reading.

Each sample is `{ metric, start, end?, value?, value2?, text? }`:

| Record shape | Metrics | Fields used |
|--------------|---------|-------------|
| Instantaneous | heartRate, hrv, spo2, bloodGlucose, respiratoryRate, bodyTemperature, restingHeartRate, weight, bodyFat, boneMass, height, leanBodyMass, vo2Max, power, speed | `start`, `value` |
| Interval | steps, distance, activeCalories, totalCalories, floorsClimbed, elevationGained, wheelchairPushes, hydration, nutrition | `start`, `end`, `value` |
| Two-value | bloodPressure | `start`, `value` (systolic), `value2` (diastolic) |
| Categorical / staged | sleepStage, menstruation, cervicalMucus, ovulationTest, sexualActivity | `start`, `end?`, `text` |

**Rules**
- `samples` includes records for **all enabled metrics** (not opt-in). Because this can be
  high-volume (HR/HRV/SpO2/respiratory), `saferExportMode` chunking and the high-volume
  warnings in the UI are load-bearing — keep them.
- `metric` values are the stable string keys above; the receiver maps them to storage.
- Sample times are UTC ISO-8601. Exercise sessions stay in the separate `exercises` array
  (not duplicated into `samples`).

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No server URL configured | Block sync; prompt user to set URL. Worker returns `failure`. |
| Missing Health Connect permissions | Launch permission request (UI); worker returns `retry`. |
| Network error / 5xx / timeout | Manual: error toast. Auto: `Result.retry()` with WorkManager backoff. |
| Non-2xx 4xx (e.g. 401) | Manual: error toast with status. Auto: `Result.failure()` (config problem, no point retrying). |
| Per-metric HC read failure | Skip that metric, log, continue with the rest (safer-export mode reads in smaller windows). |

---

## Branding

- App display name: **Vitalix**.
- Launcher icon: convert `docs/branding/vitalix-icon.svg` → vector drawable +
  adaptive-icon mipmaps. Favicon variant (heart-pulse only) not needed for the app.
- Theme colors from `docs/branding/vitalix-branding.md`:
  Vital Teal `#0FA9A0` (primary), Pulse Green `#34D399` (accent).
- Replace the default template `activity_main` / fragments with the Vitalix export UI.

---

## Dependencies

Add:
- `androidx.health.connect:connect-client`
- `com.squareup.okhttp3:okhttp`
- `androidx.security:security-crypto` (EncryptedSharedPreferences)

Already present: WorkManager (used by `ExportWorker`).

Remove: Google Sheets API, Google Play Services auth, GSON/Google API client (all tied to
the dropped Sheets path).

---

## Testing

| Test | Type | Asserts |
|------|------|---------|
| `ServerForwarder.buildPayload()` | unit | Schema shape; only enabled metrics present; `MinMaxAvg` structure; `samples` array present per enabled metric with correct field shape; `Bearer` header set iff token configured. |
| `SyncSettings` config ↔ prefs mapping | unit | Round-trip of `ExportConfig` flags and server settings. |
| `HealthConnectManager` aggregation | unit (fake records) | Per-day bucketing, min/max/avg math, day-boundary handling, and raw-sample emission — using injected fake record lists where the HC client is abstracted behind an interface. |
| Full HC read + POST | on-device manual | End-to-end against the Vitalix receiver (`web/`). |

---

## Receiver

The webhook receiver is a full Node.js + Postgres service in `web/`, specified separately
in `2026-07-21-vitalix-receiver-design.md`. It ingests this payload into normalized tables
(daily summary + raw `samples` time-series) and exposes read endpoints for verification.

---

## Out of Scope (v1)

- Per-day payload chunking / streaming.
- Sheets/CSV destinations.
- Reminder notifications.
- Multi-server / multiple destinations.
- Retry queue persistence beyond WorkManager's built-in backoff.

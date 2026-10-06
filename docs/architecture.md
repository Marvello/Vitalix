# Vitalix — Architecture

How the system works today. Written from the code (October 2026); it replaces the
per-feature specs and plans that used to live in `docs/superpowers/` (still in git
history if you need the original reasoning). Keep this file current: when a change
alters a flow, boundary, endpoint or invariant below, update it in the same commit.

Companion docs:
- [`database-erd.md`](database-erd.md) — every table, key and migration.
- [`health-connect-data-coverage.md`](health-connect-data-coverage.md) — which
  Health Connect record types and fields are captured, and how they map to storage.
- [`branding/vitalix-branding.md`](branding/vitalix-branding.md) — palette, voice, assets.

---

## 1. System overview

```
 Android phone                                   Self-hosted receiver (web/)
┌───────────────────────────────┐   HTTPS POST   ┌──────────────────────────────┐
│ Health Connect                │  /api/health   │ Express (Node 24)            │
│   ↓ HealthConnectManager      │ ─────────────▶ │  mapPayload → persist        │
│ ServerForwarder (JSON, chunks)│  Bearer JWT    │  Postgres 18                 │
│ ExportWorker / Backfill / UI  │                │  EJS dashboard, admin, AI    │
└───────────────────────────────┘ ◀───────────── └──────────────────────────────┘
          ▲  FCM push (no_sync, insight_ready, app_update)   │
          └──────────────── Firebase ◀──────────────────────┘
                     Zealot (APK hosting) ──webhook──▶ /api/webhooks/zealot
```

Vitalix reads Health Connect on the phone and forwards it to a server the user
controls. Nothing goes to a third-party data path. The receiver is multi-user
(invite-only accounts) and stores both per-day rollups and every raw reading.

Deployment: one receiver replica + Postgres on the homelab k3s cluster behind
cloudflared (`homeserver/k8s/vitalix/vitalix.yaml`); `web/docker-compose.yml` is
the local/stand-alone equivalent. The app ships through Zealot (beta and
production channels) via fastlane — never hand-bump `version.properties`.

---

## 2. Android app (`android/`)

Package `com.android.vitalix` (`.beta` flavor for beta), minSdk 30, Views/XML UI.

### Component boundaries (keep strict)

| Component | Knows | Must not know |
|-----------|-------|---------------|
| `HealthConnectManager` | Health Connect: permissions, reads, per-day bucketing, raw samples, HC writes (weight/height) | network, settings storage |
| `ServerForwarder` | JSON payload + HTTP POST, chunking | Health Connect |
| `SyncSettings` | all config (`SharedPreferences` + `SecurePrefs`) | — |

`MainActivity` and the workers read/write config only through `SyncSettings`
(exception: `SyncLog` keeps its own `vitalix_synclog` prefs). Health Connect is
hidden behind `health/RecordReader`, so `HealthConnectManager` is unit-tested with
`FakeRecordReader`.

### Main classes

| Class | Role |
|-------|------|
| `MainActivity` | Metric toggles, days-back, manual Sync, full-history toggle, auto-sync card, permission flow |
| `HealthConnectManager` | Reads every enabled record type for a window → `List<DailyHealthData>` (+ raw `samples`); tracks `lastFailedMetrics` |
| `health/RecordReader` | Paged HC reads with throttle retry; bisects around records the SDK can't construct; `SecurityException` → `PermanentlyUnavailable` |
| `ServerForwarder` | Builds the payload, splits into 7-day chunks (re-split above 512 KB), POSTs via `AuthedHttp` |
| `ExportWorker` | Periodic auto-sync, every 4 h, network-constrained, exponential backoff |
| `BackfillWorker` | One-off full history as a foreground `dataSync` worker: 30-day slices walking back up to 10 years, stops after 6 empty slices |
| `SyncLog` / `SyncLogActivity` | Last 200 runs (manual/auto/full) with status *Sent · Partial · Failed* |
| `BatteryGuardian` | Doze exemption + OEM app-killer guidance so the worker actually fires |
| `auth/AuthClient`, `AuthStore`, `AuthedHttp` | Login/signup/forgot/refresh calls; tokens in `SecurePrefs`; OkHttp authenticator refreshes on 401 (serialized) |
| `security/SecurePrefs` | Tink AES-256-GCM over plain prefs, keyset wrapped by an Android Keystore key. Excluded from backup/transfer |
| `OnboardingActivity`, `SettingsActivity` | Profile (name, height, weight, BMI scale); height/weight also written to Health Connect |
| `UpdateManager`, `UpdateActivity` | Zealot "latest release" check on open, APK download (Zealot origin only) and install |
| `VitalixFirebaseService`, `FcmRegistrar` | Renders pushes; registers the FCM token with the server on app open |
| `InsightActivity` | Shows the day's AI insight; opened from the `insight_ready` push |
| `SignupActivity` | Invite-code signup; also opened by the `vitalix://signup` link in invite emails |

### Sync model

| Trigger | Window | Notes |
|---------|--------|-------|
| Manual | last *N* calendar days (form field, default 7) | |
| Auto (`ExportWorker`) | back to the day of `lastSync`, minimum yesterday + today | fails loudly if background read isn't granted |
| Full history (`BackfillWorker`) | 30-day slices back to 10 years | retries throttled slices, then stops with a message |

Invariants:
- **Every window starts at local midnight** (`HealthConnectManager.windowStart`).
  The server stores per-day totals; a mid-day start would send — and overwrite —
  a partial total for the oldest day.
- **`lastSync` advances only on a clean, non-empty read.** A throttled metric or
  an empty read is re-read on the next run.
- Health Connect permissions are per record type; partial grants are normal and
  sync whatever was allowed. Feature permissions (`READ_HEALTH_DATA_HISTORY`,
  `READ_HEALTH_DATA_IN_BACKGROUND`) are requested only when the installed Health
  Connect supports them.

### Error handling

| Condition | Manual | Auto | Backfill |
|-----------|--------|------|----------|
| No server URL | prompt | `failure` | `failure` |
| Background read not granted | — | `failure`, logged with fix hint | — |
| Network / 5xx | "Failed: …" | `retry` (backoff) | stop, message |
| 401 after refresh failed | back to login | `failure` | stop, "sign in again" |
| Other 4xx / payload too large | "Failed: …" | `failure` | stop |
| Some metrics unreadable | "Sent, but X could not be read" | `PARTIAL`, `lastSync` kept | retried, then stop |

---

## 3. Payload contract (`POST /api/health`)

```json
{
  "source": "vitalix", "appVersion": "1.5.4", "device": "Pixel 8",
  "exportedAt": "2026-10-05T09:00:00Z", "rangeDays": 2,
  "chunk": { "index": 0, "total": 1 },
  "profileHeightM": 1.78, "bmiScale": "standard",
  "timeZone": "Asia/Jakarta", "failedMetrics": ["SleepSessionRecord"],
  "days": [{
    "date": "2026-10-05",
    "activity": { "steps": 8123, "...": "..." },
    "body": {}, "vitals": { "heartRate": { "min": 52, "max": 146, "avg": 68 } },
    "sleep": {}, "cycle": {}, "nutrition": {},
    "exercises": [{ "name": "Running", "start": "…", "durationMinutes": 32,
                    "source": "com.google.android.apps.fitness", "hcId": "…",
                    "laps": [], "segments": [], "route": [] }],
    "samples": [{ "metric": "heartRate", "start": "…", "end": "…", "value": 68,
                  "value2": null, "text": null, "source": "…", "hcId": "…",
                  "meta": { "bodyPosition": "sitting" } }]
  }]
}
```

Rules:
- Only enabled metrics appear; disabled ones are omitted, not null.
- Distribution metrics (heart rate, SpO₂, glucose, BP, …) use `{min, max, avg}`.
- `samples` carries every raw reading with its Health Connect UID (`hcId`) and
  origin package (`source`); `meta` holds per-reading context enums. One
  `NutritionRecord` becomes a `nutrition` sample plus one `nutrition.<field>`
  sample per nutrient, all sharing `hcId` and `start`.
- Unknown sample metrics are skipped and counted, never fatal.
- `timeZone` (device zone ID) is stored on the user and sets their day boundaries
  for insights; `failedMetrics` (omitted when empty) lists the Health Connect
  record types this read couldn't return and is stored on the `syncs` row.
- Sleep sessions belong to the day they **end** (total and stages alike).
- The metric vocabulary is defined on both sides (Android `ExportConfig` /
  `HealthConnectManager`; server `mapPayload.js`, `persist.js`, `records.js`,
  `stats.js`). Adding a metric touches both — see the coverage doc.

---

## 4. Receiver (`web/`)

Node 24, Express 5, `pg`, EJS. No ORM: all ingest SQL lives in `persist.js`.

### Modules

| Module | Role |
|--------|------|
| `index.js` | Bootstrap, `trust proxy`, rate limits, runs migrations before listening |
| `migrate.js` | Forward-only SQL runner over `db/migrations/NNN_*.sql`, advisory-locked |
| `db.js` | The single `pg.Pool`, `query`, `withTransaction` |
| `mapPayload.js` | Pure: payload JSON → row objects |
| `persist.js` | One transaction per POST (see Ingest) |
| `records.js` | Metric aggregation catalog, `/api/records` bucketing, per-source rollup |
| `stats.js`, `chartData.js`, `dailyInsights.js`, `syncCheck.js` | Dashboard queries, chart series, AI cron, stale-sync cron |
| `auth/*` | bcrypt passwords, JWT + hashed refresh/reset/invite tokens, `requireAuth`/`requireAdmin`, mailer |
| `ai/*` | Prompt building, OpenAI-compatible client (120 s timeout), recommendation storage |
| `firebase.js`, `zealot.js` | FCM sender; Zealot API (invite download link, update info) |
| `rateLimit.js` | In-memory fixed-window limiter (single replica only) |

### Ingest (`persist`)

Per POST, in one transaction: insert a `syncs` row, then for each day:
1. Upsert `health_days` on `(user_id, day)`; scalar columns merge with
   `COALESCE(new, old)`, so a column absent from this payload keeps its value.
2. Replace `day_aggregates` and `samples` **per metric present** in the payload —
   metrics not in the payload keep their rows.
3. Upsert `exercises` on `(day_id, hc_id)`.
4. Upsert `records` on `(user_id, type, start_at, hc_id)`.
5. Upsert `day_source_metrics` on `(user_id, day, metric, source)`.

`records` is the idempotent, native-granularity source of truth; `samples` is the
older day-scoped copy kept for the current dashboard queries.

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/health` | user | Ingest a payload |
| GET | `/api/days`, `/api/days/:date` | user | Day rollups / one day in full |
| GET | `/api/records` | user | Raw or bucketed (minute/hour/day/week) series |
| GET | `/healthz` | — | Liveness + DB ping |
| POST | `/api/auth/{signup,login,refresh,logout,forgot,reset}` | — / token | Account flows (JSON for the app) |
| GET/POST | `/login`, `/signup`, `/forgot`, `/reset`, `/logout` | — | Same flows as web forms |
| GET | `/dashboard`, `/dashboard/:date`, `/daily-review` | user (cookie) | Charts, day detail, daily review + AI insight |
| POST/PUT/DELETE | `/dashboard/layout…` | user | Custom card order |
| GET/POST | `/api/ai/recommendations…` | user | Latest / by day / generate (rate limited) |
| POST | `/api/fcm/register` | user | Store device push token |
| GET | `/admin`; `/api/admin/users`, `/api/admin/invites…` | admin | Users (role, disable), invites (create, resend, revoke) |
| POST | `/api/admin/run-sync-check` | `x-sync-token` | Hourly cron: push `no_sync` to users silent > 36 h (re-notify ≤ 1/24 h) |
| POST | `/api/admin/run-daily-insights` | `x-cron-token` | Daily cron: generate yesterday's insight, push `insight_ready` |
| POST | `/api/webhooks/zealot` | `?token=` (Zealot can't send headers) | New build → push `app_update` to `app-updates-beta` / `app-updates` by `release_type` |

### Auth

- Invite-only signup. `npm run create-admin` bootstraps the first admin; admins
  invite by email (invite email carries a Zealot download link + QR).
- Access JWT (`ACCESS_TTL`, default 14 d) + rotating refresh token (30 d, stored
  hashed, revocable). The app sends `Authorization: Bearer`; the web uses
  `httpOnly`, `SameSite=Lax` cookies (`Secure` when `NODE_ENV=production`).
- `requireAuth` re-reads the user on every request: a disabled account is
  refused immediately and the role comes from the database, not the token.
- Login/signup/forgot/reset are rate limited per IP (login also per email).
- Forgot-password never reveals whether an email exists.

### Configuration

| Var | Required | Purpose |
|-----|----------|---------|
| `DATABASE_URL`, `JWT_SECRET` | yes | Postgres, token signing (server refuses to start without them) |
| `PORT`, `NODE_ENV`, `APP_BASE_URL` | no | Listener, cookie `Secure`, links in emails |
| `ACCESS_TTL`, `REFRESH_TTL`, `RESET_TTL_MS`, `INVITE_TTL_MS`, `BCRYPT_ROUNDS` | no | Auth tuning |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | no | Email; unset → links logged to console |
| `ZEALOT_ENDPOINT`, `ZEALOT_TOKEN`, `ZEALOT_CHANNEL_KEY`, `ZEALOT_WEBHOOK_SECRET` | no | Download links, update webhook |
| `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT` | no | Push notifications |
| `SYNC_CRON_SECRET`, `CRON_SECRET` | no | Cron endpoint secrets (`CRON_SECRET` falls back to `SYNC_CRON_SECRET`) |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | no | LLM for insights (default local Ollama) |
| `TRUST_PROXY` | no | Proxy hops trusted for client IP (default private networks) |

---

## 5. Features at a glance

| Feature | Where | Notes |
|---------|-------|-------|
| Source filter & per-source overlay | `day_source_metrics`, dashboard | Compare apps writing the same metric |
| Per-reading context (`meta`) | `samples.meta`, `records.meta` | BP position, glucose meal relation, … |
| Exercise detail | `exercises.detail` | Laps, segments, GPS route (route needs its own grant) |
| Custom dashboard | `dashboard_layouts` | Add/remove/reorder cards |
| BMI | `stats.bmiSeries`, `chartData.js` | Weight forward-filled; height from HC or profile; standard/Asian WHO cut-offs |
| Daily review + AI insight | `/daily-review`, `ai/recommendations.js` | See §5a |
| Stale-sync push | `syncCheck.js` | Server is the source of truth (`syncs.received_at`) |
| In-app update | Zealot + FCM | Full-screen changelog (Android-only commits since the last release, built by the Fastfile), download, install |

### 5a. AI insight

- **Completed days only**, judged in the user's zone (`users.timezone`, UTC if
  unknown); the page defaults to yesterday and the daily cron picks each user's
  local yesterday. Days with nothing recorded are skipped without an LLM call.
- **Prompt** (`buildPrompts`, pure, unit-tested): labelled values with units, the
  7-day average with its day count and % change, sleep stages (dropped when they
  cover < 80% of the night), workouts. `0`/null is "(not recorded)". The fixed
  system prompt forbids inventing data, reading calories burned as food, and
  diagnosis; output is 2–4 plain-text `- lead: sentence` lines.
- **Incomplete data**: if the day's last sync ran before local midnight or listed
  `failed_metrics`, the prompt is marked INCOMPLETE and a fixed "Data note" line
  is prepended to the stored text — not left to the model.
- Output is cleaned (headings, bold, emoji) before storing; temperature 0.3.

---

## 6. Testing

- Web: `cd web && npm test` (node:test). `test/persist.db.test.js` runs against a
  throwaway Postgres when `TEST_DATABASE_URL` is set — see `web/README.md`.
- Android: `cd android && ./gradlew testProductionDebugUnitTest` (JVM; HC behind
  `FakeRecordReader`). No instrumented tests yet.
- CI: `.github/workflows/web.yml` tests and publishes the web image on `main`.
  Android has no CI; releases go through fastlane.

## 7. Known debt

- Metric catalog is duplicated across Kotlin and JS with no shared fixture or
  payload `schemaVersion`.
- `samples` duplicates `records`; ingest is one INSERT per row.
- `HealthConnectManager` and `MainActivity` are large; manual sync and the two
  workers each assemble their own run.
- `/api/records` buckets by UTC day while `health_days` uses the phone's local date
  (`users.timezone` now exists to fix this).
- Sleep rows stored before the end-day fix have totals and stages on different
  days until a full-history backfill re-sends them.
- Android lint reports RestrictedApi uses of Health Connect's `*_INT_TO_STRING_MAP`.

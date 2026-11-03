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
          ▲  FCM push (no_sync, insight_ready, digest_ready, anomaly, app_update) │
          └──────────────── Firebase ◀──────────────────────┘
                     Zealot (APK hosting) ──webhook──▶ /api/webhooks/zealot
```

Vitalix reads Health Connect on the phone and forwards it to a server the user
controls. Nothing goes to a third-party data path. The receiver is multi-user
(invite-only accounts) and stores both per-day rollups and every raw reading.

Deployment: one receiver replica + Postgres on the homelab k3s cluster behind
cloudflared (`common-tech/homeserver/k8s/vitalix/vitalix.yaml`, which also holds the two
CronJobs: `vitalix-sync-check` hourly at :00, `vitalix-daily-insights` hourly at :05, which also runs the anomaly check — append
` ; curl -fsS --max-time 880 -X POST http://vitalix-app:3000/api/admin/run-anomaly-check -H "x-cron-token: $CRON_SECRET"`
to the folded `>-` command after the insights curl; `;` rather than `&&` so the anomaly check still runs if insights fails). The same `:05` job also runs the digests — append
` ; curl -fsS --max-time 880 -X POST http://vitalix-app:3000/api/admin/run-digests -H "x-cron-token: $CRON_SECRET"`
after the anomaly curl (hourly is right: each run only picks users past 08:00 local on their Monday / 1st with no digest row yet); `web/docker-compose.yml` is
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
  "schemaVersion": 2,
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
- `schemaVersion` (integer, optional; absent = `1`) is `PAYLOAD_SCHEMA_VERSION` in
  `ServerForwarder.kt` and `mapPayload.js`. The receiver answers `400
  "unsupported schemaVersion"` only for a *higher* version than it knows; older
  app builds that send none keep working.
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
  `stats.js`). Adding a metric touches both — see the coverage doc. Adding a
  metric = update `docs/fixtures/payload-v2.json` (one day, every section key, one
  sample per sample metric; `nutrition.*` is represented by `nutrition.protein`):
  `mapPayload.test.js` (server maps it, nothing skipped) and `ServerForwarderTest`
  (an all-enabled export emits exactly the fixture's keys) both fail until it matches.
  `power`/`speed` are sample-only, so they are not in the fixture's `activity` section.

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
| `stats.js`, `chartData.js`, `dailyInsights.js`, `anomalies.js`, `digests.js`, `syncCheck.js` | Dashboard queries, chart series, AI cron, digest cron, stale-sync cron |
| `auth/*` | bcrypt passwords, JWT + hashed refresh/reset/invite tokens, `requireAuth`/`requireAdmin`, mailer |
| `ai/*` | Prompt building, OpenAI-compatible client (120 s timeout), recommendation storage |
| `firebase.js`, `zealot.js` | FCM sender; Zealot API (invite download link, update info) |
| `journal.js`, `routes/journal.js` | `validateEntry` (pure) and the `/api/journal` routes |
| `rateLimit.js` | In-memory fixed-window limiter (single replica only) |

### Ingest (`persist`)

Per POST, in one transaction: insert a `syncs` row, then for each day:
1. Upsert `health_days` on `(user_id, day)`; scalar columns merge with
   `COALESCE(new, old)`, so a column absent from this payload keeps its value.
2. Replace `day_aggregates` **per metric present** in the payload —
   metrics not in the payload keep their rows.
3. Upsert `exercises` on `(day_id, hc_id)`.
4. Upsert `records` on `(user_id, type, start_at, hc_id)`.
5. Upsert `day_source_metrics` on `(user_id, day, metric, source)`.

Steps 3-5 and the aggregates insert are single `INSERT … SELECT FROM unnest(…)` statements per day; duplicate conflict keys inside one payload are deduped in JS (last wins).

`records` is the idempotent, native-granularity source of truth; the dashboard
day detail, `/api/days/:date`, the sample count and the heart-rate split all read
it (`stats.dayReadings`, `readingDay` in `src/stats.js`). A reading's local day
(user zone) is its `start_at`, except `sleepStage`, which belongs to the day its
session ends, mirroring the phone's bucketing. The old `samples` table is gone
(migration 018 first copies sample-only readings into `records` as `legacy-sample:<id>`, then drops it — **back up the DB before deploying**).

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/health` | user | Ingest a payload |
| GET | `/api/days`, `/api/days/:date` | user | Day rollups / one day in full |
| GET | `/api/records` | user | Raw or bucketed (minute/hour/day/week) series |
| GET | `/healthz` | — | Liveness + DB ping |
| POST | `/api/auth/{signup,login,refresh,logout,forgot,reset}` | — / token | Account flows (JSON for the app) |
| GET/POST | `/login`, `/signup`, `/forgot`, `/reset`, `/logout` | — | Same flows as web forms |
| GET | `/auth/oidc/start`, `/auth/oidc/callback` | — | Authentik SSO for the web dashboard (only when `OIDC_*` set); ends in the same cookies as `/login` |
| GET | `/dashboard`, `/dashboard/:date`, `/daily-review` | user (cookie) | Charts, day detail, daily review + AI insight |
| POST/PUT/DELETE | `/dashboard/layout…` | user | Custom card order |
| GET/POST | `/api/ai/recommendations…` | user | Latest / by day / generate (rate limited) |
| POST | `/api/ai/recommendations/:day/feedback` | user | Thumbs on a day's insight, body `{value: 1\|-1\|0}` (0 clears) → 204; 400 bad day/value, 404 no row. GET by day also returns `feedback`. Web `/daily-review` calls it via same-origin `fetch` (cookie auth, SameSite=Lax, no CSRF token — same as the `/dashboard/layout` calls); totals per model and recent downvotes on `/admin` |
| GET | `/api/ai/digests/latest?kind=week\|month` | user | Latest weekly / monthly digest `{kind, period_start, period_end, text}`; 400 on another kind, 404 if none (§5b) |
| GET | `/api/journal?from&to` | user | Own journal entries for `[from, to]` (YYYY-MM-DD, default the user's today) → `{entries: [{id, day, kind, value_num, value_text, logged_at}]}` |
| POST | `/api/journal` | user | Add `{kind, value_num\|value_text, logged_at}` → 201 + the row. Kinds: `mood` int 1-5, `caffeine` cups 0-20, `alcohol` drinks 0-30, `symptom`/`medication`/`note` text 1-200 chars. `logged_at` ISO, ≤ 1 day ahead; `day` is derived server-side from it in `users.timezone` (a client `day` is ignored). 400 invalid; 60/hour per user |
| DELETE | `/api/journal/:id` | user | Delete own entry → 204; 404 when absent or another user's |
| POST | `/api/fcm/register` | user | Store device push token |
| GET | `/admin`; `/api/admin/users`, `/api/admin/invites…` | admin | Users (role, disable), invites (create, resend, revoke) |
| POST | `/api/admin/run-sync-check` | `x-sync-token` | Hourly cron: push `no_sync` to users silent > 36 h (re-notify ≤ 1/24 h) |
| POST | `/api/admin/run-anomaly-check` | `x-cron-token` | Hourly cron (same `:05` job): personal-baseline alerts for each user's local yesterday after 08:00 local (§5), stored in `anomaly_alerts`, push `anomaly` once per (user, day, rule) |
| POST | `/api/admin/run-digests` | `x-cron-token` | Hourly cron (same `:05` job): weekly digest on the user's local Monday, monthly on the 1st, after 08:00 local (§5b), stored in `ai_digests`, push `digest_ready` once per (user, kind, period) |
| POST | `/api/admin/run-daily-insights` | `x-cron-token` | Hourly cron: per-user insight after 08:00 local (§5a), push `insight_ready` |
| POST | `/api/webhooks/zealot` | `?token=` (Zealot can't send headers) | New build → push `app_update` to `app-updates-beta` / `app-updates` by `release_type` |

### Auth

- Invite-only signup. `npm run create-admin` bootstraps the first admin; admins
  invite by email (invite email carries a Zealot download link + QR).
- Access JWT (`ACCESS_TTL`, default 14 d) + rotating refresh token (30 d, stored
  hashed, revocable). The app sends `Authorization: Bearer`; the web uses
  `httpOnly`, `SameSite=Lax` cookies (`Secure` when `NODE_ENV=production`).
- `requireAuth` re-reads the user on every request: a disabled account is
  refused immediately and the role comes from the database, not the token.
- **Authentik SSO (web only, optional):** `src/auth/oidc.js` runs the authorization-code flow with
  PKCE + state + nonce (`openid-client`; the three ride in a 10-min JWT-signed `oidc_flow` cookie).
  The id_token's email must be `email_verified` and match an existing, enabled user —
  SSO never creates accounts. Success issues the normal access + refresh cookies. The Android
  app is unchanged (email/password + Bearer).
- Login/signup/forgot/reset and the SSO callback are rate limited per IP (login also per email).
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
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | no | Authentik SSO for the web dashboard; off unless all four are set |

---

## 5. Features at a glance

| Feature | Where | Notes |
|---------|-------|-------|
| Source filter & per-source overlay | `day_source_metrics`, dashboard | Compare apps writing the same metric |
| Per-reading context (`meta`) | `records.meta` | BP position, glucose meal relation, … |
| Exercise detail | `exercises.detail` | Laps, segments, GPS route (route needs its own grant) |
| Custom dashboard | `dashboard_layouts` | Add/remove/reorder cards |
| BMI | `stats.bmiSeries`, `chartData.js` | Weight forward-filled; height from HC or profile; standard/Asian WHO cut-offs |
| Daily review + AI insight | `/daily-review`, `ai/recommendations.js` | See §5a |
| Readiness score | `readiness.js`, dashboard card, `/daily-review`, AI prompt | 0-100 from HRV (0.4), resting HR (0.3), sleep vs 8 h (0.3); HRV/RHR are `50 ± 15·z` against the previous 28 days, needing ≥ 7 days of that metric; ≥ 2 parts else no score |
| Anomaly alerts | `anomalies.js`, `anomaly_alerts`, `/daily-review`, `VitalixFirebaseService` | Against the previous 28 days (statistical rules need ≥ 14): `rhr_up` (resting HR ≥ mean + max(sd, 3) on each of the last 3 days), `hrv_drop` (HRV ≤ mean − 2·sd, sd > 0), `spo2_low` (min < 90), `bp_high` (sys ≥ 140 or dia ≥ 90). Push `{type: anomaly, day, rule, value, baseline}` (strings; bp value = `sys/dia`), channel `alerts`, tap opens `InsightActivity` |
| Journal | `journal.js`, `routes/journal.js`, `journal_entries`, `JournalActivity`, `/dashboard/:date`, `/daily-review` | Manual mood / caffeine / alcohol / symptom / medication / note. Feeds the AI prompt as one line (`Journal: mood 2/5; caffeine 4 cups; symptom: headache`: mood averaged, caffeine/alcohol summed, zero sums omitted, symptom/medication text one line capped at 60 chars; **notes are never sent to the LLM**) and `dailySeries` (`mood` avg, `caffeine`/`alcohol` sums; rows still come from `health_days`, so journal-only days do not appear) |
| Stale-sync push | `syncCheck.js` | Server is the source of truth (`syncs.received_at`) |
| In-app update | Zealot + FCM | Full-screen changelog (Android-only commits since the last release, built by the Fastfile), download, install |

### 5a. AI insight

- **Completed days only**, judged in the user's zone (`users.timezone`, UTC if
  unknown); the page defaults to yesterday. Days with nothing recorded are skipped
  without an LLM call.
- **When the worker runs**: k8s CronJob `vitalix-daily-insights`
  (`common-tech/homeserver/k8s/vitalix/vitalix.yaml`) calls `POST /api/admin/run-daily-insights`
  hourly at :05. `PENDING_USERS_SQL` (`dailyInsights.js`) picks a user only once it
  is past **08:00 in their own zone** (`GENERATE_HOUR`), for their local yesterday,
  if that day has data and no insight yet — so each user gets one insight a day
  around 08:00 local, then an `insight_ready` push. The wait gives the phone's
  4-hourly auto-sync time to send the end of the night; disabled users are skipped.
  Users can still generate on demand from `/daily-review` (10/hour).
- **Prompt** (`buildPrompts`, pure, unit-tested): labelled values with units, the
  7-day average with its day count and % change, sleep stages (dropped when they
  cover < 80% of the night), workouts. `0`/null is "(not recorded)". The fixed
  system prompt forbids inventing data, reading calories burned as food, and
  diagnosis; output is 2–4 plain-text `- lead: sentence` lines.
- **Readiness line**: when scorable, the prompt carries `Readiness: 72/100 (HRV 80, resting HR 65, sleep 70)`
  (missing parts omitted; no line when `null`).
- **Incomplete data**: if the day's last sync ran before local midnight or listed
  `failed_metrics`, the prompt is marked INCOMPLETE and a fixed "Data note" line
  is prepended to the stored text — not left to the model.
- Output is cleaned (headings, bold, emoji) before storing; temperature 0.3.

### 5b. Digests

- **Periods** (`ai/digest.js`, `periodFor` / `isDue`, string/UTC date math on the
  user's local date, so a Jakarta Monday is a Monday even while UTC is Sunday):
  week = the previous Mon–Sun, due when the local date is a Monday; month = the
  previous calendar month, due on the 1st. The previous period for comparison is
  the same-length period right before it.
- **When it runs**: the `:05` CronJob also calls `POST /api/admin/run-digests`
  (`digests.js`). A user is picked once past **08:00 local** (`GENERATE_HOUR`) when
  `isDue` and no `ai_digests` row exists for `(user, kind, period_start)`. The
  unique key makes hourly re-runs free: no second LLM call, no second push. The
  push (`{type: digest_ready, kind, start}`) is sent only after a successful
  generate; `AI_UNCONFIGURED` stops the run, `NO_DATA` skips the user.
- **Prompt** (`buildDigestPrompts`, pure): per metric (resting HR, HRV, sleep,
  steps, active kcal, readiness) the period average, previous-period average, %
  change (omitted when the previous average is missing or 0) and "N of M days
  recorded"; best and worst day by readiness; workout count and minutes. Same
  no-invented-data / no-diagnosis rules as the daily note (shared in
  `SHARED_RULES`); output is 3–5 `- lead: sentence` lines.
- **Surfaces**: `GET /api/ai/digests/latest?kind=` serves the newest row;
  `/daily-review` shows the latest weekly digest; the app's push opens
  `InsightActivity` with a `digestKind` extra (title "Week of <start>" /
  "<Month YYYY>"), notification on the `insights` channel.

---

## 6. Testing

- Web: `cd web && npm test` (node:test). `test/persist.db.test.js` runs against a
  throwaway Postgres when `TEST_DATABASE_URL` is set — see `web/README.md`.
- Android: `cd android && ./gradlew testProductionDebugUnitTest` (JVM; HC behind
  `FakeRecordReader`). No instrumented tests yet.
- CI: `.github/workflows/web.yml` tests and publishes the web image on `main`.
  `.github/workflows/android.yml` runs `testProductionDebugUnitTest` + `assembleProductionDebug`
  (Temurin 21, unsigned, no secrets; `google-services.json` is committed) on PRs and `main`
  pushes touching `android/`. Releases still go through fastlane.

## 7. Known debt

- Ingest tables are one `unnest` INSERT per day. New readings without a Health Connect UID are not stored (`records` needs `hc_id`).
- `HealthConnectManager` and `MainActivity` are large; manual sync and the two
  workers each assemble their own run.
- Sleep rows stored before the end-day fix have totals and stages on different
  days until a full-history backfill re-sends them.
- Android lint reports RestrictedApi uses of Health Connect's `*_INT_TO_STRING_MAP`.

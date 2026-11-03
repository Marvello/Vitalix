# Vitalix Roadmap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 12 roadmap items picked on 2026-11-03: anomaly alerts, readiness score, weekly/monthly digest, correlation explorer, manual journal, home-screen widget, data export + account deletion, Health Connect Changes API, insight feedback, known-debt cleanup, Android CI, deferred UI work.

**Architecture:** Server features follow the existing worker pattern (`syncCheck.js` / `dailyInsights.js`: pure SQL constant + injectable `run*({query, messaging})`, cron-secret admin route, FCM data push rendered by `VitalixFirebaseService`). Baseline statistics live in one pure module shared by readiness, anomalies and the correlation page. Android keeps its strict boundaries: `HealthConnectManager` (HC only), `ServerForwarder` (JSON/HTTP only), `SyncSettings` (config only).

**Tech Stack:** Node 24 / Express 5 / `pg` / EJS / `node:test`; Postgres 18; Kotlin, Views/XML, WorkManager, Health Connect `connect-client`, FCM; GitHub Actions.

**Spec:** the 2026-11-03 brainstorm (items 1–6, 9–14) + `docs/architecture.md` (current design, read first).

## Global Constraints

- Work in `/Users/marvellooni/Project/Vitalix`; one branch per phase (`feat/roadmap-a-debt`, `feat/roadmap-b-insights`, …), commit per task.
- Migrations are forward-only `web/db/migrations/NNN_name.sql`, next free number is **018**; number them in the order tasks land.
- Every change that alters a flow, endpoint, table, payload field or invariant updates `docs/architecture.md`, `docs/database-erd.md` (and `docs/health-connect-data-coverage.md` for capture changes) **in the same commit**. Run `graphify update .` after code changes.
- Payload rule stays: only enabled metrics appear; omitted, not null; new top-level fields are optional so older app builds keep working.
- Never hand-bump `android/version.properties`; releases go through fastlane.
- Branding/voice: Vital Teal `#0FA9A0` (text on white `vital_teal_text` `#0B7A73`), Pulse Green `#34D399`. Notification and UI copy is direct and technical, no emoji, no wellness fluff, no diagnosis ("see a doctor" is not added by us either).
- Cron endpoints: header `x-cron-token` checked against `config.cronSecret`; new jobs go in `common-tech/homeserver/k8s/vitalix/vitalix.yaml` (separate repo, commit there).
- Personal-baseline rules need data: **≥ 14 days in the 28-day window** for statistical rules, **≥ 7** for readiness. Below that → no result, never a guess.
- Rate limits use `rateLimit()` from `src/rateLimit.js` (single replica assumption holds).
- Web tests: `cd web && npm test`; DB tests need `TEST_DATABASE_URL`. Android tests: `cd android && ./gradlew testProductionDebugUnitTest`, build check `assembleProductionDebug`.
- New GitHub Actions: look up current action majors with `gh api repos/<owner>/<action>/releases/latest` (never copy `@v4` from `web.yml`), `runs-on: ubuntu-26.04`.

## Review Focus

1. **User with a timezone east/west of UTC** — every "day" (anomaly day, digest week, journal day, `/api/records` bucket) must be the user's local day from `users.timezone`, not UTC. Tests in Tasks 3, 7, 9, 11 pin a `Asia/Jakarta` case.
2. **New user / sparse data** — fewer than the baseline minimum days must yield `null`/no alert, not a 0 score or a false alarm. Tests in Tasks 6, 7, 8.
3. **Cron re-runs every hour** — anomaly, digest pushes must be sent at most once per (user, day, rule) / (user, kind, period). Dedup via unique key + `ON CONFLICT DO NOTHING RETURNING`; tests in Tasks 8, 9.
4. **Older app build talking to the new server** (no `schemaVersion`, no `deletedHcIds`, no `journal`) — ingest must behave exactly as today. Tests in Tasks 2, 15.
5. **Health Connect changes token expired or permission set changed** — worker must fall back to the window read and take a fresh token, never silently skip data. Test in Task 15.

---

## Phase A — Foundations & debt (branch `feat/roadmap-a-debt`)

### Task 1: Android CI

**Files:**
- Create: `.github/workflows/android.yml`

- [ ] **Step 1:** Look up latest majors for `actions/checkout`, `actions/setup-java`, `gradle/actions` via `gh api`.
- [ ] **Step 2:** Workflow triggers on push to `main` + PRs with `paths: [android/**, .github/workflows/android.yml]`; job on `ubuntu-26.04`, Temurin JDK 21 (Gradle 9.5 runtime; app compiles Java 11), `gradle/actions/setup-gradle`, then in `android/`: `./gradlew testProductionDebugUnitTest assembleProductionDebug`. No signing, no secrets; if the build needs `google-services.json`, write a dummy from a committed `android/ci/google-services.json` stub.
- [ ] **Step 3:** Push branch, confirm the run is green with `gh run watch`.
- [ ] **Step 4:** Update `docs/architecture.md` §6 ("Android has no CI" → describe job). Commit `ci(android): unit tests + debug build on PR`.

### Task 2: Payload `schemaVersion` + shared metric fixture

**Files:**
- Create: `docs/fixtures/payload-v2.json` (one day, every metric key the app can emit, one sample per sample metric)
- Modify: `android/.../ServerForwarder.kt` (`buildPayload` adds `"schemaVersion": 2`), `web/src/mapPayload.js`, `web/src/routes/health.js`
- Test: `web/test/mapPayload.test.js`, `android/app/src/test/java/com/android/vitalix/ServerForwarderTest.kt`

**Interfaces:**
- Produces: `PAYLOAD_SCHEMA_VERSION = 2` (Kotlin const in `ServerForwarder`, JS export in `mapPayload.js`); `mapPayload(body).schemaVersion` (number, `1` when absent).

- [ ] **Step 1: Failing tests.**
  - JS `fixture payload maps every metric`: read `../docs/fixtures/payload-v2.json`, `mapPayload` → assert `unknownSamples === 0` (or the existing skipped-count field) and every `SCALAR_MAP` column present.
  - JS `missing schemaVersion is treated as 1`.
  - JS `schemaVersion above PAYLOAD_SCHEMA_VERSION → 400 "unsupported schemaVersion"` (route test).
  - Kotlin `buildPayload emits schemaVersion 2` and `fixture metric keys == keys buildPayload emits for an all-enabled ExportConfig` (test reads the fixture via `File("../../docs/fixtures/payload-v2.json")`, compares key sets of `activity/body/vitals/sleep/cycle/nutrition` and sample `metric` values).
- [ ] **Step 2:** Run both suites, expect FAIL.
- [ ] **Step 3:** Implement; route rejects only *higher* versions.
- [ ] **Step 4:** Run both suites, expect PASS.
- [ ] **Step 5:** Update architecture §3 (field + "adding a metric = update the fixture, both tests enforce it"), §7 (remove the debt line). Commit `feat: payload schemaVersion + shared metric fixture`.

### Task 3: `/api/records` buckets by the user's local day

**Files:**
- Modify: `web/src/records.js:35` (`buildRecordsQuery`), `web/src/routes/health.js` (pass tz)
- Test: `web/test/records.test.js`

**Interfaces:**
- Produces: `buildRecordsQuery({ userId, from, to, types, bucket, tz })` — `tz` IANA string, default `"UTC"`.

- [ ] **Step 1: Failing test** `day bucket truncates in the user's zone`: `buildRecordsQuery({..., bucket:"day", tz:"Asia/Jakarta"})` → `text` matches `/date_trunc\('day', start_at AT TIME ZONE \$\d\)/` and `values` include `"Asia/Jakarta"`; `minute`/`hour` buckets also use the zone; `raw` unchanged.
- [ ] **Step 2:** Run, FAIL.
- [ ] **Step 3:** Implement: zone goes in as a bind parameter (never interpolated); `bucket_start` returned as local timestamp. Route reads tz with `userTimeZone(req.user.id)` from `ai/recommendations.js`.
- [ ] **Step 4:** Run, PASS.
- [ ] **Step 5:** Architecture §7 drop the UTC line. Commit `fix(records): bucket in user's timezone`.

### Task 4: Batch ingest INSERTs

**Files:**
- Modify: `web/src/persist.js` (`replaceSamples`, `upsertRecords`, `upsertSourceMetrics`)
- Test: `web/test/persist.db.test.js`

- [ ] **Step 1: Failing test** `ingest of 2000 samples issues ≤ 10 queries`: wrap the client passed to persist with a counting `query`; also existing 3 DB tests must stay green.
- [ ] **Step 2:** Run with `TEST_DATABASE_URL`, FAIL on count.
- [ ] **Step 3:** One `INSERT … SELECT * FROM unnest($1::text[], $2::timestamptz[], …)` per table per day, same conflict targets as today. ponytail ceiling: one statement per day keeps param arrays small; no COPY.
- [ ] **Step 4:** Run, PASS (all persist tests).
- [ ] **Step 5:** Architecture §7 drop "one INSERT per row". Commit `perf(persist): unnest batch inserts`.

### Task 5: Dashboard reads `records`; drop `samples`

**Files:**
- Modify: `web/src/stats.js:112,143` (`summary`, `heartRateSplit`), `web/src/routes/pages.js:497` (day detail), `web/src/routes/health.js:74` (`/api/days/:date`), `web/src/persist.js` (stop writing samples)
- Create: `web/db/migrations/0NN_drop_samples.sql` (`DROP TABLE samples;`)
- Test: `web/test/persist.db.test.js`, existing chart/stat tests

- [ ] **Step 1: Failing DB test** `day detail reads from records`: ingest a payload, `DELETE FROM samples`, call the day-detail query helper → still returns the readings. Extract the day-detail query into `stats.dayReadings(userId, day, tz) -> rows` so it is testable; it selects `records` where `start_at` falls in the user's local day.
- [ ] **Step 2:** Run, FAIL.
- [ ] **Step 3:** Port the four queries to `records` (`type` ↔ `metric`, filter by `user_id` + local-day range instead of `day_id`). Response field names of `/api/days/:date` stay identical (`metric`, `start_at`, …) — alias in SQL.
- [ ] **Step 4:** Run full suite, PASS. Compare `/dashboard` and `/dashboard/<date>` for one real day before/after on a local DB copy (screenshot or HTML diff).
- [ ] **Step 5:** Add migration, remove sample writes from `persist.js` (keep `mapSamples` — it feeds `records`). Update ERD (table gone, notes), architecture §4 Ingest + §7. Commit `refactor: dashboard on records, drop samples`.
- [ ] **Step 6:** Deploy note: migration is destructive → **take a DB backup before rollout** (per deploy-backup policy: migration = backup).

---

## Phase B — Insights (branch `feat/roadmap-b-insights`)

### Task 6: Baseline module

**Files:**
- Create: `web/src/baseline.js`, `web/test/baseline.test.js`

**Interfaces:**
- Produces:
  - `stats(values: number[]) -> { mean, sd, n } | null` — ignores null/NaN; `null` when `n === 0`; sample SD (n−1), `sd = 0` when `n === 1`.
  - `BASELINE_DAYS = 28`
  - `METRIC_SOURCES` — `{ restingHr: "health_days.resting_heart_rate", hrv: "day_aggregates hrv avg", spo2Min: "day_aggregates spo2 min", bpSys: "day_aggregates bpSystolic avg", bpDia: "day_aggregates bpDiastolic avg", sleepMin: "health_days.sleep_duration_minutes", deepMin: "health_days.sleep_deep", steps: "health_days.steps" }` (doc map; one SQL below implements it)
  - `async dailySeries(userId, from, to, { query } = {}) -> Array<{ day: "YYYY-MM-DD", restingHr, hrv, spo2Min, bpSys, bpDia, sleepMin, deepMin, steps, activeKcal }>` — one SQL: `health_days` LEFT JOIN pivoted `day_aggregates`, ordered by day.

- [ ] **Step 1: Failing tests:** `stats([60,62,64]) → {mean:62, sd:2, n:3}`; `stats([null, NaN]) → null`; `stats([5]) → {mean:5, sd:0, n:1}`; `dailySeries` SQL snapshot test (`assert.match` on `day_aggregates`, `bpSystolic`, `ORDER BY`).
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement. **Step 4:** Run, PASS.
- [ ] **Step 5:** Commit `feat(web): baseline stats + daily series`.

### Task 7: Readiness score

**Files:**
- Create: `web/src/readiness.js`, `web/test/readiness.test.js`
- Modify: `web/src/stats.js` (`CARD_CATALOG` + key `readiness`), `web/views/dashboard.ejs` (card), `web/src/ai/recommendations.js` (`buildPrompts` gets `readiness`), `web/src/routes/pages.js` (`/dashboard`, `/daily-review` pass it)

**Interfaces:**
- Consumes: `stats`, `dailySeries`, `BASELINE_DAYS` (Task 6).
- Produces: `readinessScore({ today, history }) -> { score: number, parts: { hrv?, restingHr?, sleep? } } | null` where `today` is one `dailySeries` row and `history` the 28 rows before it.

Formula (pure, fixed):
- `hrv` part = `clamp(50 + 15·z, 0, 100)`, `z = (today.hrv − mean)/sd` (sd 0 → part 50).
- `restingHr` part = `clamp(50 − 15·z, 0, 100)` (higher RHR → lower).
- `sleep` part = `min(1, sleepMin / 480) · 100`.
- Weights `hrv 0.4, restingHr 0.3, sleep 0.3`; missing parts drop out and the rest re-normalise; **need ≥ 2 parts** and **≥ 7 history days** for the statistical parts, else that part is missing. Score rounded to integer.

- [ ] **Step 1: Failing tests:** all-at-mean + 8 h sleep → 80; HRV +1 sd, RHR −1 sd, 8 h → 95; only sleep present → `null`; history of 6 days → statistical parts missing → `null`; sd 0 → parts 50.
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement. **Step 4:** Run, PASS.
- [ ] **Step 5:** Card: 30-day line of daily scores (compute per day from one `dailySeries(from−28, to)` call), today's number large; hidden when no score in range (existing `visibleMetrics` rule). Prompt: add line `Readiness: 72/100 (HRV 80, resting HR 65, sleep 70)`; `buildPrompts` test asserts the line and its absence when `null`.
- [ ] **Step 6:** Full suite PASS; open `/dashboard` locally to see the card. Architecture §5 row. Commit `feat: readiness score card + prompt line`.

### Task 8: Anomaly alerts

**Files:**
- Create: `web/db/migrations/0NN_anomaly_alerts.sql`, `web/src/anomalies.js`, `web/test/anomalies.test.js`
- Modify: `web/src/routes/admin.js` (endpoint), `web/views/daily-review.ejs` + `pages.js` (list the day's alerts), `android/.../VitalixFirebaseService.kt` (new `anomaly` type + channel `alerts`), `common-tech/homeserver/k8s/vitalix/vitalix.yaml` (curl added to the `:05` CronJob)

**Interfaces:**
- Consumes: Task 6 (`stats`, `dailySeries`, `BASELINE_DAYS`), `deadTokens` from `syncCheck.js`, `GENERATE_HOUR` from `dailyInsights.js`.
- Produces:
  - table `anomaly_alerts(id bigserial, user_id bigint FK users CASCADE, day date, rule text, value double precision, baseline double precision, created_at timestamptz default now(), UNIQUE(user_id, day, rule))`
  - `detectAnomalies({ today, recent, history }) -> Array<{ rule, value, baseline }>` — `today` = evaluated day row, `recent` = the 3 rows ending at `today`, `history` = 28 rows before `recent`.
  - `PENDING_ANOMALY_USERS_SQL` — same shape as `PENDING_USERS_SQL`: enabled users past 08:00 local with a `health_days` row for local yesterday.
  - `runAnomalyCheck({ query, messaging }) -> { candidates, alerts, pushed }`
  - `POST /api/admin/run-anomaly-check` (`x-cron-token`)
  - push data `{ type: "anomaly", day, rule, value, baseline }` (strings)

Rules (fixed):
| rule | condition | needs history |
|------|-----------|---------------|
| `rhr_up` | each of the 3 `recent` days: `restingHr ≥ mean + max(sd, 3)` | ≥ 14 |
| `hrv_drop` | `today.hrv ≤ mean − 2·sd` and `sd > 0` | ≥ 14 |
| `spo2_low` | `today.spo2Min < 90` | none |
| `bp_high` | `today.bpSys ≥ 140` or `today.bpDia ≥ 90` | none |

Notification copy (Android, fixed):
- `rhr_up`: "Resting heart rate above baseline for 3 days (%1$s vs %2$s bpm)"
- `hrv_drop`: "HRV well below baseline (%1$s vs %2$s ms)"
- `spo2_low`: "Blood oxygen dipped to %1$s%% overnight"
- `bp_high`: "Blood pressure averaged %1$s mmHg" (value = sys/dia text)
Title "Vitalix alert". Tap → `InsightActivity` for `day`.

- [ ] **Step 1: Failing tests (pure):** each rule fires on its boundary value and not just below it; `rhr_up` needs all 3 days; 13 history days → no statistical rule fires but `spo2_low` still does; null metrics never fire.
- [ ] **Step 2: Failing tests (runner, injected query/messaging like `dailyInsights.test.js`):** alert insert uses `ON CONFLICT (user_id, day, rule) DO NOTHING RETURNING id`; push only for rows actually inserted (second run → `pushed: 0`); `messaging` null → alerts still stored, `pushed: 0`; `PENDING_ANOMALY_USERS_SQL` matches `/AT TIME ZONE COALESCE\(u\.timezone, 'UTC'\)/` and `disabled_at IS NULL`.
- [ ] **Step 3:** Run, FAIL. **Step 4:** Implement migration, module, route. **Step 5:** Run, PASS.
- [ ] **Step 6:** Android: channel `alerts` (importance default), string resources for the 4 copies, branch in `VitalixFirebaseService`; unknown `rule` → no notification. `compileProductionDebugKotlin` clean.
- [ ] **Step 7:** Daily-review page lists alerts for the shown day. CronJob: append second `curl … /api/admin/run-anomaly-check` to the `:05` job (commit in `common-tech`).
- [ ] **Step 8:** Docs: architecture endpoints table, §5 row, push types in the overview diagram; ERD table. Commit `feat: personal-baseline anomaly alerts`.

### Task 9: Weekly / monthly digest

**Files:**
- Create: `web/db/migrations/0NN_ai_digests.sql`, `web/src/ai/digest.js`, `web/src/digests.js`, `web/test/digest.test.js`
- Modify: `web/src/routes/ai.js`, `web/src/routes/admin.js`, `web/views/daily-review.ejs`, `android/.../VitalixFirebaseService.kt`, `android/.../InsightActivity.kt`, k8s CronJob

**Interfaces:**
- Consumes: `generateCompletion` (`ai/llmClient.js`), `cleanOutput`, `userTimeZone`, `todayIn`, `shiftDay` (`ai/recommendations.js`), `dailySeries` (Task 6), `readinessScore` (Task 7), `deadTokens`.
- Produces:
  - table `ai_digests(id, user_id FK CASCADE, kind text CHECK (kind IN ('week','month')), period_start date, period_end date, text, metrics_snapshot jsonb, provider, model, prompt_tokens, completion_tokens, created_at, UNIQUE(user_id, kind, period_start))`
  - `periodFor(kind, localToday: "YYYY-MM-DD") -> { start, end }` — week = previous Mon–Sun; month = previous calendar month.
  - `isDue(kind, localToday) -> boolean` — week: localToday is Monday; month: day-of-month is 1.
  - `buildDigestPrompts({ kind, days, prevDays, workouts, journal? }) -> { system, user, hasData }` — per metric: period avg, previous-period avg, % change, days recorded; best/worst day by readiness; workout count + minutes. Same system-prompt rules as daily (no invented data, no diagnosis), output 3–5 `- lead: sentence` lines.
  - `generateDigest(userId, kind, start, end) -> { text }` (throws `AI_UNCONFIGURED` / `NO_DATA` like `generateRecommendation`)
  - `runDigests({ query, messaging, generate }) -> { candidates, generated, pushed, failed }` — users past 08:00 local where `isDue`, no row yet.
  - `GET /api/ai/digests/latest?kind=week|month` → `{ kind, period_start, period_end, text }` or 404
  - `POST /api/admin/run-digests` (`x-cron-token`)
  - push `{ type: "digest_ready", kind, start }`

- [ ] **Step 1: Failing tests:** `periodFor("week","2026-11-09")` → `{start:"2026-11-02", end:"2026-11-08"}`; `periodFor("month","2026-12-01")` → Nov 1–30; `isDue` Monday/1st only; `buildDigestPrompts` with 3 recorded days marks "3 of 7 days recorded" and `hasData:false` when 0; runner skips when row exists, `AI_UNCONFIGURED` breaks the loop, push shape.
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement. **Step 4:** Run, PASS.
- [ ] **Step 5:** Android: `digest_ready` → notification "Your weekly summary is ready" / "Your monthly summary is ready" (channel `insights`); `InsightActivity` extra `digestKind` → fetch `/api/ai/digests/latest?kind=…`, title "Week of <start>" / "<Month YYYY>". Web: latest weekly digest block on `/daily-review`.
- [ ] **Step 6:** CronJob: add `curl …/api/admin/run-digests` to the `:05` job. Docs (architecture §5a sibling "§5b Digests", endpoints, ERD). Commit `feat: weekly and monthly AI digests`.

### Task 10: Insight feedback

**Files:**
- Create: `web/db/migrations/0NN_insight_feedback.sql` (`ALTER TABLE ai_recommendations ADD feedback smallint CHECK (feedback IN (-1,1)), ADD feedback_at timestamptz;`)
- Modify: `web/src/routes/ai.js`, `web/views/daily-review.ejs`, `web/views/admin.ejs` + `pages.js` (`/admin`), `android/.../InsightActivity.kt` + layout
- Test: `web/test/aiRoutes.test.js`

**Interfaces:**
- Produces: `POST /api/ai/recommendations/:day/feedback` body `{ value: 1 | -1 | 0 }` (0 clears) → 204; 404 if no row; 400 otherwise. Same-origin form post for web (existing CSRF approach of other dashboard POSTs).

- [ ] **Step 1: Failing tests:** value 2 → 400; missing row → 404; valid → UPDATE with `feedback = NULLIF($v, 0)`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement route + UI (two icon buttons, selected state). Admin page: last 30 days count up/down per `model` and the 20 most recent downvoted texts (for manual prompt tuning). **Step 4:** PASS.
- [ ] **Step 5:** Docs. Commit `feat: thumbs feedback on AI insights`.

---

## Phase C — Data features (branch `feat/roadmap-c-data`)

### Task 11: Manual journal (mood, symptoms, meds, caffeine, alcohol, note)

**Files:**
- Create: `web/db/migrations/0NN_journal.sql`, `web/src/journal.js`, `web/src/routes/journal.js`, `web/test/journal.test.js`, `android/.../JournalActivity.kt`, `android/.../JournalClient.kt`, `res/layout/activity_journal.xml`
- Modify: `web/src/index.js` (mount), `web/src/ai/recommendations.js` (`buildPrompts({ …, journal })`), `web/src/baseline.js` (`dailySeries` adds `mood`, `caffeine`, `alcohol`), day detail + daily-review views, `MainActivity` menu, manifest

**Interfaces:**
- Produces:
  - table `journal_entries(id bigserial, user_id FK CASCADE, day date NOT NULL, kind text NOT NULL CHECK (kind IN ('mood','symptom','medication','caffeine','alcohol','note')), value_num double precision, value_text text CHECK (length(value_text) <= 200), logged_at timestamptz NOT NULL, created_at timestamptz default now())`, index `(user_id, day)`
  - `validateEntry(body) -> { ok: true, entry } | { ok: false, error }` — mood: `value_num` integer 1–5; caffeine: cups 0–20; alcohol: drinks 0–30; symptom/medication/note: `value_text` 1–200 chars; `day` derived from `logged_at` in the user's zone server-side (client may not send `day`).
  - `GET /api/journal?from&to`, `POST /api/journal`, `DELETE /api/journal/:id` (own rows only; 404 otherwise). POST rate limit 60/hour.
  - `dailySeries` row fields: `mood` (avg), `caffeine` (sum), `alcohol` (sum).
  - prompt line: `Journal: mood 2/5; caffeine 4 cups; symptom: headache`.

- [ ] **Step 1: Failing tests:** `validateEntry` boundaries per kind (mood 0/6 rejected, 201-char note rejected, unknown kind rejected); `logged_at` 2026-11-03T18:30Z with tz `Asia/Jakarta` → day `2026-11-04`; DELETE of another user's id → 404; `buildPrompts` includes/omits the journal line.
- [ ] **Step 2:** FAIL. **Step 3:** Implement server. **Step 4:** PASS.
- [ ] **Step 5:** Android: `JournalActivity` — mood row of 5 buttons, +/- steppers for caffeine/alcohol, symptom chips (`headache`, `fatigue`, `nausea`, `sore throat`, `stress`) + free text, medication + note text fields; today's entries list with delete. `JournalClient` uses `AuthedHttp`. Menu item "Journal". Manual check on emulator: add, list, delete.
- [ ] **Step 6:** Web: journal entries shown on `/dashboard/:date` and `/daily-review`. Docs (architecture endpoints + §5 row, ERD). Commit `feat: manual journal`.

### Task 12: Correlation explorer

**Files:**
- Create: `web/src/correlate.js`, `web/test/correlate.test.js`, `web/views/correlations.ejs`
- Modify: `web/src/routes/pages.js` (`GET /insights/correlations`), nav partial

**Interfaces:**
- Consumes: `dailySeries` (Tasks 6/11).
- Produces:
  - `pearson(xs, ys) -> { r, n } | null` — pairs where both finite; `null` when `n < 10` or either variance 0.
  - `pairSeries(rows, xKey, yKey, lag: 0 | 1) -> Array<[x, y]>` — `y` taken from the row `lag` days after `x`'s day (by date, not index — gaps don't shift pairs).
  - `PRESETS = [ {x:"sleepMin", y:"hrv", lag:1, label:"Sleep → next-day HRV"}, {x:"sleepMin", y:"restingHr", lag:1, label:"Sleep → next-day resting HR"}, {x:"steps", y:"deepMin", lag:1, label:"Steps → that night's deep sleep"}, {x:"activeKcal", y:"restingHr", lag:1, label:"Active calories → next-day resting HR"}, {x:"caffeine", y:"deepMin", lag:1, label:"Caffeine → that night's deep sleep"}, {x:"alcohol", y:"hrv", lag:1, label:"Alcohol → next-day HRV"} ]` (sleep belongs to the day it ends, so "that night" = lag 1).
  - Page query params `x`, `y` (whitelisted to `dailySeries` keys), `lag` (0|1), `days` (30|90|180, default 90).

- [ ] **Step 1: Failing tests:** perfect line → r 1; 9 pairs → null; constant series → null; `pairSeries` with a missing day does not pair 11-03 with 11-05 at lag 1; unknown `x` → 400.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Page: preset list with r + n each, selected pair as hand-drawn inline SVG scatter (same approach as `dashboard.ejs`), plain-language strength label (|r| < 0.2 none, < 0.4 weak, < 0.6 moderate, else strong) and the line "Correlation, not cause." **Step 4:** PASS.
- [ ] **Step 5:** Docs. Commit `feat: correlation explorer`.

### Task 13: Data export + account deletion

**Files:**
- Create: `web/src/routes/account.js`, `web/src/exportData.js`, `web/test/account.test.js`, `web/views/account.ejs`
- Modify: `web/src/index.js`, nav partial, `android/.../SettingsActivity.kt` + layout, `android/.../auth/AuthClient.kt`

**Interfaces:**
- Produces:
  - `GET /account` (page), `GET /account/export.json` — streamed JSON `{ exportedAt, user: {email, timezone, profile}, health_days: [...], day_aggregates: [...], records: [...], exercises: [...], journal: [...], ai_recommendations: [...], ai_digests: [...], anomaly_alerts: [...] }` with `Content-Disposition: attachment; filename="vitalix-export-YYYY-MM-DD.json"`; `records` streamed in pages of 5000 via keyset on `id` (never loads all rows). Rate limit 3/hour.
  - `GET /account/export-days.csv` — `health_days` columns, one row per day.
  - `DELETE /api/account` body `{ password }` and `POST /account/delete` (form, password + typed email) → verify password with `verify()`, refuse with 409 if user is the **only** enabled admin, `DELETE FROM users WHERE id=$1` (cascade), clear cookies / revoke refresh. Rate limit 5/hour.

- [ ] **Step 1: Failing tests:** wrong password → 403 and user still exists; last admin → 409; success → user row gone and refresh tokens gone (DB test); export JSON parses and contains every top-level key, other users' rows absent (DB test with two users).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Android Settings: "Delete account" → dialog with password field, red confirm "Delete permanently"; on 200 clear `AuthStore` + `SecurePrefs`, go to `LoginActivity`. "Export data" opens `${serverUrl}/account` in the browser.
- [ ] **Step 6:** Docs (endpoints, auth section: deletion cascade). Commit `feat: data export and account deletion`.

---

## Phase D — Android (branch `feat/roadmap-d-android`)

### Task 14: Home-screen widget

**Files:**
- Create: `android/.../widget/VitalixWidget.kt` (AppWidgetProvider), `android/.../widget/WidgetState.kt`, `res/layout/widget_vitalix.xml`, `res/xml/widget_vitalix_info.xml`, test `WidgetStateTest.kt`
- Modify: manifest, `ExportWorker.kt`, `MainActivity.kt` (manual sync), `BackfillWorker.kt`, `VitalixFirebaseService.kt`

**Interfaces:**
- Produces:
  - `WidgetState` — own prefs file `vitalix_widget` (like `SyncLog`, outside `SyncSettings`: it is state, not config): `data class Snapshot(val status: String, val at: Long, val stepsToday: Long?, val sleepLastNightMin: Int?, val insightReadyDay: String?)`; `fun save(ctx, s)`, `fun load(ctx): Snapshot?`; pure `fun fromDays(days: List<DailyHealthData>, today: LocalDate, status, at): Snapshot`.
  - `VitalixWidget.refresh(context)` — pushes `RemoteViews` to all instances.
  - Layout 2×1 min (`targetCellWidth 2`, `targetCellHeight 1`): status line `Sent · 14:05` / `Failed (retry)`, steps, sleep `7h 12m`, "Insight ready" chip when `insightReadyDay == yesterday`. Tap → `MainActivity`; chip tap → `InsightActivity`. `updatePeriodMillis = 0` (event-driven).

- [ ] **Step 1: Failing test** `fromDays` picks today's steps and the sleep of the day that ends today; empty days → nulls.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; call `WidgetState.save` + `VitalixWidget.refresh` after every sync outcome (manual, auto, backfill) and on `insight_ready` push. **Step 4:** PASS.
- [ ] **Step 5:** Emulator: add widget, run manual sync, see values update; light + dark launcher. Commit `feat(android): home-screen widget`.

### Task 15: Health Connect Changes API (incremental sync + deletions)

**Files:**
- Create: `android/.../health/ChangesSource.kt`, `android/.../health/ChangesPlanner.kt`, test `ChangesPlannerTest.kt` (no migration — existing `hc_id` columns suffice)
- Test: `web/test/mapPayload.test.js`, `web/test/persist.db.test.js`
- Modify: `HealthConnectManager.kt`, `ExportWorker.kt`, `SyncSettings.kt`, `ServerForwarder.kt` (payload `deletedHcIds`, parse response), `web/src/mapPayload.js`, `web/src/persist.js`, `web/src/routes/health.js`

**Design (fixed):**
- Token covers the set of **currently granted** record types; stored as `changesToken` + `changesTypes` (sorted, comma-joined) in `SyncSettings`. Granted set differs from `changesTypes` → treat as no token.
- Token is fetched **before** a successful window read (manual, auto fallback, backfill completion) so changes during the read are not lost.
- `ExportWorker` with a valid token: page `getChanges` until `!hasMore`. Upsertions → set of local dates touched (record start..end in device zone, sleep → end date). Deletions → list of record ids. Then re-read **those days in full** via the existing `readHealthDataByDay` path (per-day totals stay correct) and send them with `deletedHcIds`. Always include today + yesterday even with no changes (cheap, keeps the "re-read yesterday for late wearable data" invariant).
- `changesTokenExpired` or any `getChanges` failure → old window path (since `lastSync`) + new token. Logged in `SyncLog` as `Sent (full window)`.
- Token and `lastSync` advance only on a clean, non-empty send (existing invariant).
- Server: `deletedHcIds` (optional array of strings, ≤ 10 000) → in the persist transaction `DELETE FROM records WHERE user_id=$1 AND hc_id = ANY($2)` and same for `exercises` (joined via `health_days.user_id`); response body gains `{ deleted: n }`. Known ceiling (`ponytail:` comment in persist): a `health_days` scalar whose only source record was deleted keeps its old value, because days merge with `COALESCE(new, old)` — fix needs a recompute-from-records step, add when it shows up.

**Interfaces:**
- Produces:
  - `interface ChangesSource { suspend fun token(types: Set<KClass<out Record>>): String; suspend fun changes(token: String): ChangesPage }` with `data class ChangesPage(val upserts: List<Pair<Instant, Instant>>, val deletedIds: List<String>, val nextToken: String, val hasMore: Boolean, val expired: Boolean)`; real impl wraps `HealthConnectClient.getChangesToken/getChanges`, fake for tests.
  - `ChangesPlanner.plan(pages: List<ChangesPage>, zone: ZoneId, today: LocalDate): Plan` — `data class Plan(val days: SortedSet<LocalDate>, val deletedIds: List<String>, val fallback: Boolean)`.
  - `HealthConnectManager.readDays(cfg: ExportConfig, days: Set<LocalDate>): List<DailyHealthData>` — reads each contiguous run of days with the existing window reader.

- [ ] **Step 1: Failing Kotlin tests:** upsert spanning 23:00–07:00 marks both local dates (any interval marks every local date it touches — this always includes a sleep session's end date, so no record-class special case); `expired` page → `fallback = true`; no changes → days = {yesterday, today}; changed granted set → token ignored (test on `SyncSettings` mapping helper).
- [ ] **Step 2: Failing web tests:** `mapPayload` keeps `deletedHcIds` (array of strings, drops non-strings, caps at 10 000 → 400 above); DB test: ingest record, then payload with its `hcId` in `deletedHcIds` → row gone, other user's row with the same `hc_id` untouched; payload without the field behaves as today.
- [ ] **Step 3:** Run both, FAIL. **Step 4:** Implement server, then Android. **Step 5:** Run both, PASS.
- [ ] **Step 6:** Device/emulator check: sync, delete a weight entry in Health Connect, wait for auto-sync (or trigger worker via `adb shell cmd jobscheduler run`), confirm the record is gone server-side and the sync log shows the run.
- [ ] **Step 7:** Docs: architecture §2 Sync model (new row), §3 payload field, §4 ingest step; coverage doc note. Commit `feat: incremental sync via Health Connect changes + deletions`.

### Task 16: Deferred UI work

**Files:**
- Create: `res/values-night/colors.xml`, `res/values/dimens.xml`, `res/values/styles_text.xml`, `res/layout/main_*.xml` (includes)
- Modify: `res/layout/activity_main.xml` and other layouts, `MainActivity.kt`, `SettingsActivity.kt`, `ForgotActivity.kt`, `BackfillWorker` progress surfacing

- [ ] **Step 1: Dark mode** — night palette: background `#0F1417`, surface `#172024`, text primary `#E6EEF0`, secondary `#9FB3B8`, teal text `#34C7BD` (≥ 4.5:1 on surface — verify with a contrast check), fills keep `#0FA9A0`. Check every screen in dark mode on the emulator (screenshot each).
- [ ] **Step 2: Type/spacing scale** — `dimens.xml` spacing 4/8/12/16/24/32dp; text appearances `Vitalix.Title` 20sp, `Vitalix.Body` 15sp, `Vitalix.Caption` 12sp; replace the mixed 13/16sp body sizes. Screenshot compare light mode before/after.
- [ ] **Step 3: Loading/empty states** — sync button shows progress + disables while running; Settings save, Forgot submit disable + spinner; backfill progress "Reading <month YYYY>…" in the main status line.
- [ ] **Step 4: Split `activity_main.xml`** into `<include>` files per card (`main_metrics`, `main_sync`, `main_autosync`, `main_backfill`); no behavior change — `assembleProductionDebug` + manual tap-through.
- [ ] **Step 5:** Mark items done in `tasks/todo-ui-improve.md`. Commit per step (`ui: dark mode palette`, …).

---

## Wrap-up (after each phase)

- [ ] `cd web && npm test` (+ DB tests with `TEST_DATABASE_URL`) and `cd android && ./gradlew testProductionDebugUnitTest assembleProductionDebug` green.
- [ ] `graphify update .`; `CLAUDE.md` touched only if a boundary/command changed.
- [ ] Cross-project memory (`common-tech/memory/`) updated if a fact is durable (e.g. new cron endpoints).
- [ ] Deploy web (DB backup first when the phase has a migration: A, B, C do; D has none → restart only); release app via fastlane beta.
- [ ] Review section appended below.

## Review (2026-11-03)

All 16 tasks implemented via subagent-driven development (fresh implementer + spec/quality review per task, fix loops where needed), then a whole-branch review (opus) and one fix wave. Branches stack: `feat/roadmap-a-debt` → `-b-insights` → `-c-data` → `-d-android` (final head carries the final-review fixes).

- Verification at final head: web 200/200 with TEST_DATABASE_URL (0 skipped); android `testProductionDebugUnitTest` + `assembleProductionDebug` green; lint = 19 known RestrictedApi errors, none new.
- Device (emulator API 34): widget render light/dark; Changes API deletion end-to-end (HC delete → server row gone); dark-mode screens; loading states; backfill month status. Not verified on device: widget live-sync update, push-driven chip, notification taps, Changes fallback path (unit-tested), Update screen.
- Bugs caught in review: sleep stages assigned by stage end (now session end); 018 would have dropped pre-records history (now copied); export held a pool connection across backpressure; widget failures could break sync; recordSpan failure silently skipped data; day page crashed with journal entries; notification taps collided; unbounded changes plan could stall auto-sync.
- Plan corrections (rulings): readiness test values 65/76 (formula binding); query-count test as O(1) equality; bucket_start stays timestamptz; changes token kept when valid (manual + backfill).
- Pending ops (not done here): DB backup → deploy server (migrations 018–023) → add the two documented `:05` cron curls to `common-tech/homeserver/k8s/vitalix/vitalix.yaml` → release app via fastlane beta. First push will run the new Android CI.
- Known ceilings (documented, ponytail-marked): deleted record's day only re-read if yesterday/today (health_days scalars, day_aggregates, day_source_metrics keep old value); changes plan capped at 31 days; window functions span all record types; cookie-auth POSTs rely on SameSite=Lax (destructive delete additionally gated by password + typed email).

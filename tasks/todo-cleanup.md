# Roadmap cleanup — the 52 deferred minors

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Close every minor left open after the roadmap (list of 2026-11-04, numbered #1–#52), on branch `fix/roadmap-cleanup` off `main` c9594f3.

**Spec:** the numbered list in the 2026-11-04 conversation + the user's four answers (below). Architecture: `docs/architecture.md`.

## Global Constraints
- Worktree `/Users/marvellooni/Project/Vitalix-cleanup`; never `git stash`; never kill processes by port (`lsof … | kill` killed the emulator once).
- Web tests: `cd web && TEST_DATABASE_URL=postgres://t:t@127.0.0.1:55432/t npm test` (container `vitalix-testdb`). Android: `cd android && ./gradlew testProductionDebugUnitTest assembleProductionDebug` (+ `lint`: 19 known RestrictedApi errors, no new ones).
- Migration 018 is NOT deployed anywhere (main is unpushed) → it may be edited in place. Migrations 019–023 likewise; still prefer new migrations for new schema.
- Docs (`docs/architecture.md`, `docs/database-erd.md`) updated in the same commit as behaviour changes. Strings in resources; brand voice; no emoji.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no deploy, no edits to other repos.

## User decisions (binding)
- **D1 (#51):** primary buttons use the darker teal `#0B7A73` fill with white text; `#0FA9A0` stays for accents/logo.
- **D2 (#37/#38):** add a same-origin check on cookie-authenticated web POSTs and export downloads: reject (403) when `Origin` is present and ≠ `APP_BASE_URL` origin, or when `Sec-Fetch-Site` is `cross-site`. Bearer-token API requests are exempt.
- **D3 (#49):** background fallback window read capped at 31 days; SyncLog note "Older days skipped — run Full history".
- **D4 (#20):** readiness card shows finished days only (latest completed local day), like daily review.

## Controller defaults (recorded rulings)
- **C1 (#10/#14):** edit migration 018 in place: match key adds `source`; dedupe sample rows across day_ids with `DISTINCT ON (user, type, start_at, source)` before inserting.
- **C2 (#11):** readings without an hc_id get a deterministic synthetic id `nouid:` + sha1(type|start|end|value|value2|text|source) so they're stored (idempotent) instead of dropped.
- **C3 (#7):** batch dedupe moves into SQL (`DISTINCT ON` over `unnest … WITH ORDINALITY`, last wins) so precision matches Postgres.
- **C4 (#47):** a token-mode plan with nothing to send advances the changes token only (not `lastSync`).
- **C5 (#23):** add `anomaly_alerts.pushed_at`; runner retries unpushed alerts for the same local day.
- **C6 (#15):** each DB test file gets its own database (created from a helper), so the serial flag can go.
- **C7 (#45):** widget treats a snapshot from a previous day as stale (steps/sleep "—") and schedules an inexact refresh shortly after local midnight (no exact-alarm permission).

---

### Task 1: Web ingest + migration 018 (#3 #4 #5 #7 #8 #9 #10 #11 #14)
**Files:** `web/src/mapPayload.js`, `web/src/persist.js`, `web/src/routes/health.js`, `web/db/migrations/018_drop_samples.sql`, tests `web/test/healthRoute.test.js`, `mapPayload.test.js`, `persist.db.test.js`.
- [ ] #3 accept-path route test asserts `200`.
- [ ] #4 single top-level import in mapPayload.test.js.
- [ ] #5 `schemaVersion` present but not a positive integer → 400 `"invalid schemaVersion"`; test `"3"`, `2.5`, `0`.
- [ ] #7 C3: dedupe in SQL; test: two readings 0.5 ms apart (`…00.0001Z` vs `…00.0006Z`) both stored; exact duplicates collapse, last wins.
- [ ] #8 `countQueries` mock restored in `finally`.
- [ ] #9 non-object `meta` stored as NULL (test).
- [ ] #10/#14 C1 in 018; migration test: two sources same instant both copied; same reading under two day_ids copied once.
- [ ] #11 C2: UID-less samples stored with `nouid:` id; re-sending is idempotent (DB test).
- [ ] Docs: ERD 018 row, architecture §3/§4.

### Task 2: Web day correctness + perf (#6 #12 #13 #17 #18 #19 #20 #50 + dashboard range test)
**Files:** `web/src/auth/middleware.js`, `web/src/ai/recommendations.js` (`userTimeZone`), `web/src/stats.js` (`readingsInDays`), `web/src/records.js`, `web/src/readiness.js`, `web/src/routes/pages.js`, views, tests.
- [ ] #12 `requireAuth` loads `timezone` with the user it already re-reads → `req.user.timezone`; `userTimeZone` callers in request paths use it (keep `userTimeZone` for crons).
- [ ] #13 window function only over `sleepStage` rows (UNION with non-sleep rows); same results (existing tests + one new).
- [ ] #50 `/api/records` `day`/`week` buckets put `sleepStage` on the session-end day using the same expression as `readingsInDays` (shared SQL fragment); test.
- [ ] #6 rename zoned-bucket test; include `week`.
- [ ] #17 fix garbled readiness test title. #18 `readinessSeries` indexes rows by day (no rescan). #19 part labels exported once and used by dashboard + prompt.
- [ ] #20 D4: readiness card's latest = last completed local day; series excludes today.
- [ ] Dashboard test asserts the range end is the user's local today (Asia/Jakarta, pinned clock).

### Task 3: Web runners (#23 #24 #25 #26)
**Files:** `web/src/anomalies.js`, `web/src/digests.js`, `web/src/ai/digest.js`, new migration (`anomaly_alerts.pushed_at`), tests.
- [ ] #23 C5: insert sets `pushed_at` NULL; set on successful push; each run also pushes today's unpushed alerts for that user's local day.
- [ ] #24 digest pending SQL requires ≥1 `health_days` row in the period (no hourly NO_DATA re-query).
- [ ] #25 digest insert `ON CONFLICT DO NOTHING RETURNING id`; push only when a row was inserted.
- [ ] #26 `generateDigest` test covers hrv, restingHr, activeKcal lines.
- [ ] Docs + ERD.

### Task 4: Web pages (#27 #29 #30 #31 #32 #33 #34 #35)
- [ ] #27 after in-page Generate, the feedback buttons render (client-side), test via render or route.
- [ ] #29 `/dashboard/:date` renders a day that has journal entries but no `health_days` row (404 only when neither exists).
- [ ] #30 caffeine/alcohol rounded to 1 decimal in the prompt line.
- [ ] #31 `pearson`: zero-variance check with relative epsilon; r clamped to [-1,1]; tests.
- [ ] #32 correlations route errors → 500 page (not redirect).
- [ ] #33 tests: 200 render with data, `strength()` thresholds at boundaries.
- [ ] #34 page notes "Journal metrics use days with an entry."
- [ ] #35 fix nav indentation.

### Task 5: Web security + export (#37 #38 #39 #41 #42)
- [ ] D2: `sameOrigin` middleware applied to cookie-auth POST/PUT/DELETE page routes and `/account/export*`; Bearer requests skip it; tests (cross Origin → 403, same → ok, Bearer cross → ok, `Sec-Fetch-Site: cross-site` → 403).
- [ ] #39 account tests independent (own users per test); disconnect test (destroy mid-stream → no further queries); filename date test with pinned clock in Asia/Jakarta.
- [ ] #41 `streamExport` returns the final write result.
- [ ] #42 whole-export deadline `EXPORT_DEADLINE_MS = 15 min` → destroy.
- [ ] Docs: architecture auth section.

### Task 6: Test infra + CI (#1 #2 #15 #16)
- [ ] #15 C6: `web/test/helpers/testDb.js` creates a fresh database per DB test file (from `TEST_DATABASE_URL` admin conn), runs migrations, drops it after; all DB test files use it; remove `--test-concurrency=1` + README note updated. Full suite run 3× green.
- [ ] #16 consistent env setup across DB tests (via the helper).
- [ ] #1 `concurrency: { group: android-${{ github.ref }}, cancel-in-progress: true }` in android.yml (and web.yml for PRs only — don't cancel main image builds).
- [ ] #2 build once locally with `local.properties` moved aside and `ANDROID_HOME` set; record result.

### Task 7: Android sync (#40 #47 #48 #49)
- [ ] #49 D3: fallback window capped at 31 days in the testable decision layer; SyncLog note string resource; unit test.
- [ ] #47 C4 + unit test.
- [ ] #48 extract ExportWorker's token/fallback decision into a pure unit (inputs: token validity, plan, lastSync, today) with tests for every branch; device check of the fallback path on the emulator (clear the token via a debug path or invalid types key) — report.
- [ ] #40 `AuthClient.deleteAccount` maps: no server URL → specific message; 401 after refresh failure → session cleared + LoginActivity; IO → "Couldn't reach the server"; tests on the pure mapper.

### Task 8: Android widget + notifications (#22 #28 #43 #44 #45 #46)
- [ ] #22 anomaly notification ids via explicit `when(rule)` mapping (no hash); test distinct.
- [ ] #28 InsightActivity feedback buttons: strings in resources; selected state via a color-state/selector (not alpha only). Keep the 2 NUL bytes in InsightActivity.kt.
- [ ] #43 `android:previewImage` PNG for API 30 (render from the widget preview).
- [ ] #44 break SyncLog↔widget cycle: SyncLog exposes an outcome listener registered in `VitalixApp`.
- [ ] #45 C7 + test of staleness in the pure layer.
- [ ] #46 lock only around read-modify-write; refresh outside the lock.

### Task 9: Android UI (#51 #52 + contrast table)
- [ ] D1: primary button fill → `#0B7A73` (new color name, e.g. `button_primary`), white text; night variant keeps ≥ 4.5:1; widget chip unaffected unless it fails contrast.
- [ ] SyncLog RUNNING colour → `text_secondary` (night-aware).
- [ ] Spinner drawable built once per button; spinner colour from the button's text colour.
- [ ] `activity_main.xml` indentation + leftover 20dp/10dp → scale values.
- [ ] Corrected contrast table (light surface `#FFFEF7FF`) in `tasks/todo-ui-improve.md`.
- [ ] Emulator: re-shoot Journal dark; reach Update screen (adb with a fake update info / debug intent if possible) and screenshot; screenshots of primary buttons light+dark.

### Controller verification (after tasks)
- [ ] Browser check (#21 #36): run local server against the test DB with seeded data, view readiness card and correlation scatter in Chrome, screenshot.
- [ ] Final whole-branch review; fix wave; merge per user.

## Review
_(filled on completion)_

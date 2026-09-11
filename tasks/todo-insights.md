# Feature: Daily AI Insight — worker + in-app screen

**Goal:** A daily worker generates each user's AI insight for *yesterday*, pushes "your insight is ready", and the app shows it in a native screen.

## Decisions
- **Day:** yesterday (`now() - 1 day`, user's assumption: yesterday's data exists).
- **Audience:** every user with a `health_days` row for yesterday, when server AI (`config.ai.baseUrl`) is configured. `ai_config` column stays unused (already dead). Skip users already holding a recommendation for that day (don't re-spend tokens).
- **Trigger:** `POST /api/admin/run-daily-insights`, guarded by cron secret, external daily cron (run a few hours after midnight so yesterday is fully ingested).
- **Reuse, don't duplicate:** extract the route's generation body into one shared function.

## Backend (`web/`)
- [ ] `src/ai/recommendations.js` (new) — `generateRecommendation(userId, day)`: the current route body (read today/yesterday/7d, deltas, baseline, `generateCompletion`, upsert into `ai_recommendations`). Returns `{text}` or throws. Exports `buildPrompts` (moved from route).
- [ ] `src/routes/ai.js` — route calls `generateRecommendation(req.user.id, day)` (thin wrapper, same HTTP behaviour). Add `GET /api/ai/recommendations/:day` (requireAuth) → stored row `{day, text, created_at}` or 404; and `GET /api/ai/recommendations` → latest.
- [ ] `src/dailyInsights.js` (new) — `runDailyInsights({query,messaging})`: find users with yesterday data and no rec yet → `generateRecommendation` → on success push `{type:"insight_ready", day}` to their tokens (reuse token fetch + dead-token prune from syncCheck). Returns `{generated, pushed, failed}`.
- [ ] `src/config.js` — `cronSecret: process.env.CRON_SECRET || syncCronSecret` (one secret for both cron endpoints).
- [ ] `src/routes/admin.js` — `POST /api/admin/run-daily-insights` (header `x-cron-token` vs `config.cronSecret`) → `runDailyInsights()`.
- [ ] Tests: `test/dailyInsights.test.js` — selection (has-yesterday + no-existing-rec), push shape `{type:"insight_ready"}`, skip when AI unconfigured, mocked query+messaging+generator. Keep `generateRecommendation` injectable for the worker test.

## Android (`android/app/.../vitalix/`)
- [ ] `InsightActivity.kt` (new) + `activity_insight.xml` — fetch `GET /api/ai/recommendations/:day` via `AuthedHttp` (day from intent extra, default yesterday), render date + text in a scrollable view; empty/error state ("No insight yet — sync and check back"). Vitalix branding (Vital Teal).
- [ ] `VitalixFirebaseService` — `type=="insight_ready"` branch → notification "Your health insight is ready" on `insights` channel → tap opens `InsightActivity` with the `day` extra.
- [ ] `MainActivity` — toolbar menu item "Insight" → open `InsightActivity` (yesterday) so it's reachable without a push.
- [ ] `AndroidManifest.xml` — register `InsightActivity`.

## Ops
- [ ] Daily cron: `curl -X POST $BASE/api/admin/run-daily-insights -H "x-cron-token: $CRON_SECRET"`.

## Review — DONE 2026-09-11
- Web 88/88 tests green; Android `compileProductionDebugKotlin` + resources clean.
- Backend: `ai/recommendations.js` (shared `generateRecommendation`), slimmed `routes/ai.js` + `GET /api/ai/recommendations[/:day]`, `dailyInsights.js` worker, `POST /api/admin/run-daily-insights` (`x-cron-token`/`config.cronSecret`), `config.cronSecret`, `test/dailyInsights.test.js` (4 tests).
- Android: `InsightActivity` + `activity_insight.xml` (loading/empty/error/insight states), `insight_ready` push branch → opens it, MainActivity "Insight" menu, manifest entry.
- Checks: worker token query has no fan-out; failed gen → no push; AI-unconfigured breaks early; GET route order is method/path-safe; `LocalDate` day format matches server.

## Ops
- [ ] Daily cron: `curl -X POST $BASE/api/admin/run-daily-insights -H "x-cron-token: $CRON_SECRET"` (run a few hours after midnight).
- [ ] `CRON_SECRET` falls back to `SYNC_CRON_SECRET` if unset.

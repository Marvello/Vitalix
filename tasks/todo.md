# Audit fixes P0–P1 (branch `fix/audit-p0-p1`, 2026-10-05)

Source: 5-persona repo review. P0 = data loss, P1 = security/privacy/crash.

## P0
- [x] 1. Day-aligned read window — `HealthConnectManager.readHealthDataByDay(cfg)` starts at local midnight (`daysBack` = calendar days incl. today); `ExportWorker` daysBack = calendar days since lastSync day, min 2 (re-reads yesterday for late wearable data). Unit test the day math.
- [x] 1b. Server: `replaceAggregates`/`replaceSamples` delete only metrics present in the payload (a throttled/absent metric no longer wipes stored rows).
- [x] 2. `records` identity → `(user_id, type, start_at, hc_id)` (migration 015) + persist conflict target. Nutrition nutrients stop overwriting each other.
- [x] 3. `lastSync` only advances on a clean, non-empty read (ExportWorker + manual sync).
- [x] 4. Declare + request `READ_HEALTH_DATA_IN_BACKGROUND` (feature-gated); ExportWorker fails loudly when not granted.

## P1
- [x] 5. Remove Microsoft Clarity (dep, BuildConfig field, init).
- [x] 6. `requireAuth` re-checks `disabled_at` + `role` in DB per request.
- [x] 7. `AuthedHttp`: serialize refresh, reuse a token another thread refreshed, clear session only on 401 from refresh (not IO errors).
- [x] 8. `pages.js` BMI placeholder TDZ crash.
- [x] 9. In-memory rate limiter on auth (API + form) + AI generate; `trust proxy` for private-net proxies; LLM fetch timeout.
- [x] 10. `pool.on('error')`; `release(err)` when ROLLBACK fails.
- [x] 11. APK download only from Zealot origin (choke point `downloadApk`); FCM update push ignored unless newer versionCode.
- [x] 12. Exclude `vitalix_auth*`/`vitalix_secure*` prefs from backup + device transfer.

## Verify
- [x] `cd web && npm test`; persist/auth checks against a throwaway Postgres
- [x] `cd android && ./gradlew testProductionDebugUnitTest assembleProductionDebug`


## Review
- Web: 90/90 unit; `persist.db.test.js` 3/3 on Postgres 18 — all 3 fail on pre-fix code. Migration 015 applied cleanly to a populated pre-015 DB; range query uses the new key.
- Android: 60/60 unit (new: AuthedHttpTest, SyncWindowTest, Zealot-origin test); `assembleProductionDebug` OK. Lint: 19 errors, all pre-existing RestrictedApi `*_INT_TO_STRING_MAP`.
- Extra: `SyncLog.dateOf` used API-34 `LocalDate.ofInstant` (minSdk 30) → crash on Android 11–13 during backfill. Fixed.
- Not verified on device: background-read prompt + worker path. Existing users get the new permission prompt on next manual Sync.
- Skipped: APK SHA-256 check (needs Zealot to publish a checksum); same-origin + signature match cover it for now.
- Follow-ups: sync folionix `db.js` with the updated `common-tech/tech-standard/postgres-client.md`; homeserver `k8s/vitalix/vitalix.yaml` runs `NODE_ENV: development` → auth cookies not `Secure` in prod.

---

# Feature: No-Sync Push Notification (server source of truth)

**Goal:** When a user's device stops sending health data, the server detects it and pushes an FCM notification to that user's device(s).

## Decisions (locked)
- **Source of truth:** `syncs.received_at` — `MAX(received_at) WHERE user_id=$1`. No schema change to ingest.
- **Stale threshold:** 36h since last sync. **Re-notify:** at most once / 24h until they resync.
- **Trigger:** `POST /api/admin/run-sync-check`, guarded by shared-secret header (cron has no JWT), called by external cron hourly.
- **Never-synced users:** NOT notified. We alert on *stopped* syncing, not *never started* (avoids nagging fresh signups). → flag if you want the opposite.
- **Token registration auth:** `requireAuth` + Bearer via existing `AuthedHttp`.

## Backend (`web/`)
- [ ] `db/migrations/014_no_sync_notify.sql` — `ALTER TABLE users ADD COLUMN no_sync_notified_at timestamptz;` (dedup marker).
- [ ] `src/config.js` — add `syncCronSecret: process.env.SYNC_CRON_SECRET || null`.
- [ ] `src/routes/fcm.js` (new) — `POST /api/fcm/register` (`requireAuth`), body `{token, app_id}` → upsert `fcm_tokens` (`ON CONFLICT (token) DO UPDATE user_id, updated_at`). Mount in `index.js`.
- [ ] `src/syncCheck.js` (new) — `runSyncCheck()`:
  - query stale users (see SQL below) that have ≥1 fcm_token,
  - `messaging.sendEachForMulticast({ tokens, data:{type:"no_sync"} })`,
  - delete tokens that come back `messaging/registration-token-not-registered`,
  - set `no_sync_notified_at = now()` for notified users.
- [ ] `src/routes/admin.js` — `POST /api/admin/run-sync-check`, shared-secret header check (`config.syncCronSecret`), calls `runSyncCheck()`, returns `{checked, notified, pruned}`.
- [ ] `web/test/syncCheck.test.js` — stale+token+not-recently-notified selected; fresh-synced / never-synced / already-notified excluded; messaging mocked.

### Stale query
```sql
SELECT u.id, array_agg(f.token) AS tokens, MAX(s.received_at) AS last_sync
FROM users u
JOIN fcm_tokens f ON f.user_id = u.id
LEFT JOIN syncs s ON s.user_id = u.id
GROUP BY u.id, u.no_sync_notified_at
HAVING MAX(s.received_at) IS NOT NULL                         -- synced before
   AND MAX(s.received_at) < now() - interval '36 hours'       -- now stale
   AND (u.no_sync_notified_at IS NULL
        OR u.no_sync_notified_at < now() - interval '24 hours'); -- not nagged today
```

## Android (`android/app/.../vitalix/`)
- [ ] `VitalixFirebaseService.onMessageReceived` — add `type == "no_sync"` branch → local notification ("Vitalix hasn't synced — open to check Health Connect / connection"), tap opens MainActivity.
- [ ] Token registration — on app open + after login: `FirebaseMessaging.getInstance().token` → `POST /api/fcm/register` via `AuthedHttp` (idempotent upsert). Skip deprecated `onNewToken`.

## Ops (not code)
- [ ] Hourly cron: `curl -X POST $BASE/api/admin/run-sync-check -H "x-sync-token: $SYNC_CRON_SECRET"`. (GitHub Action or platform scheduler — deploy-specific.)

## Review — DONE 2026-09-10
Backend (all tests green, 84/84):
- `014_no_sync_notify.sql` — `users.no_sync_notified_at` dedup column.
- `config.js` — `syncCronSecret` (`SYNC_CRON_SECRET`).
- `routes/fcm.js` — `POST /api/fcm/register` (authed upsert into `fcm_tokens`).
- `syncCheck.js` — `runSyncCheck()`: stale query (36h, ≥1 prior sync, renotify 24h) → `sendEachForMulticast {type:"no_sync"}` → prune dead tokens → stamp.
- `routes/admin.js` — `POST /api/admin/run-sync-check` (shared-secret `x-sync-token`).
- `index.js` — mounts `fcmRouter`.
- `test/syncCheck.test.js` — 6 tests (SQL shape, deadTokens, notify/prune/stamp, no-stamp-on-all-fail, firebase-disabled).

Android (compileProductionDebugKotlin clean):
- `FcmRegistrar.kt` — fetches FCM token, POSTs to `<origin>/api/fcm/register` via AuthedHttp. Fire-and-forget, idempotent.
- `MainActivity.onCreate` — calls `FcmRegistrar.register(this)` (covers app-open + post-login).
- `VitalixFirebaseService` — `type=="no_sync"` branch → local notification on new `sync_alerts` channel, taps into MainActivity.

## Remaining (ops / deploy — not code)
- [ ] Set `SYNC_CRON_SECRET` + `FIREBASE_SERVICE_ACCOUNT(_PATH)` in prod env.
- [ ] Wire hourly cron: `curl -X POST $BASE/api/admin/run-sync-check -H "x-sync-token: $SYNC_CRON_SECRET"`.
- [ ] Migration 014 runs automatically on next server boot (runPendingMigrations).

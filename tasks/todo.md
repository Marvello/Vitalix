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

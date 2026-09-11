-- 014_no_sync_notify — dedup marker for the no-sync push nudge.
-- Set to now() whenever a "your device stopped syncing" push is sent, so the
-- hourly sync-check re-notifies at most once per RENOTIFY window.
ALTER TABLE users ADD COLUMN no_sync_notified_at timestamptz;

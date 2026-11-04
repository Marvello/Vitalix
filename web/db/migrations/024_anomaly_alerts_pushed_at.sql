-- 024_anomaly_alerts_pushed_at: set once the push was actually sent, so a failed push is
-- retried by the next hourly run and a sent one never repeats. Existing rows were
-- already handled (pushed or not) before this column existed: never re-push them.
ALTER TABLE anomaly_alerts ADD COLUMN pushed_at timestamptz;
UPDATE anomaly_alerts SET pushed_at = created_at;

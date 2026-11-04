-- 024_anomaly_alerts_pushed_at: pushed_at is set when a run claims the alert for pushing and
-- cleared again if the send fails, so a failed push is retried by the next hourly run and
-- a sent one never repeats. text = the push value when it is not the number (bp "sys/dia").
-- Existing rows were already handled (pushed or not) before this column existed: never re-push them.
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS pushed_at timestamptz;
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS text text;
UPDATE anomaly_alerts SET pushed_at = created_at WHERE pushed_at IS NULL;

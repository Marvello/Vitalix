-- 019_anomaly_alerts: personal-baseline anomaly alerts, one row per (user, day, rule).
-- The unique key is the push dedup: ON CONFLICT DO NOTHING RETURNING id.
CREATE TABLE anomaly_alerts (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  day        date NOT NULL,
  rule       text NOT NULL,
  value      double precision,
  baseline   double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anomaly_alerts_user_day_rule_key UNIQUE (user_id, day, rule)
);

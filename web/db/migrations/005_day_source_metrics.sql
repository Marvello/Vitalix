-- 005_day_source_metrics: per-source daily rollup + one-time backfill from records
-- (was 1721900000000_day_source_metrics.cjs). SUM/LAST/TEXT lists MUST match
-- aggregationFor() in src/records.js.
CREATE TABLE day_source_metrics (
  id        bigserial,
  user_id   bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  day       date NOT NULL,
  metric    text NOT NULL,
  source    text NOT NULL,
  value_num double precision,
  min       double precision,
  max       double precision,
  avg       double precision,
  count     integer,
  CONSTRAINT day_source_metrics_pkey PRIMARY KEY (id),
  CONSTRAINT day_source_metrics_identity UNIQUE (user_id, day, metric, source)
);
CREATE INDEX day_source_metrics_user_id_metric_day_index ON day_source_metrics (user_id, metric, day);

-- Backfill from records. Day derived from start_at (UTC); live ingest keys day
-- by the payload bucket, so boundary readings may differ slightly -- acceptable
-- for historical rows (DO NOTHING keeps ingest authoritative).
INSERT INTO day_source_metrics (user_id, day, metric, source, value_num, min, max, avg, count)
SELECT user_id, day, metric, source,
       CASE WHEN metric = ANY(ARRAY['steps','distance','activeCalories','totalCalories','floorsClimbed','elevationGained','wheelchairPushes','hydration','nutrition']::text[])  THEN sum_val
            WHEN metric = ANY(ARRAY['weight','bodyFat','boneMass','height','leanBodyMass','restingHeartRate']::text[]) THEN last_val
            ELSE avg_val END AS value_num,
       CASE WHEN metric = ANY(ARRAY['steps','distance','activeCalories','totalCalories','floorsClimbed','elevationGained','wheelchairPushes','hydration','nutrition']::text[]) OR metric = ANY(ARRAY['weight','bodyFat','boneMass','height','leanBodyMass','restingHeartRate']::text[]) THEN NULL ELSE min_val END,
       CASE WHEN metric = ANY(ARRAY['steps','distance','activeCalories','totalCalories','floorsClimbed','elevationGained','wheelchairPushes','hydration','nutrition']::text[]) OR metric = ANY(ARRAY['weight','bodyFat','boneMass','height','leanBodyMass','restingHeartRate']::text[]) THEN NULL ELSE max_val END,
       CASE WHEN metric = ANY(ARRAY['steps','distance','activeCalories','totalCalories','floorsClimbed','elevationGained','wheelchairPushes','hydration','nutrition']::text[]) OR metric = ANY(ARRAY['weight','bodyFat','boneMass','height','leanBodyMass','restingHeartRate']::text[]) THEN NULL ELSE avg_val END,
       cnt
FROM (
  SELECT user_id,
         (start_at AT TIME ZONE 'UTC')::date AS day,
         type AS metric,
         COALESCE(source, '(unknown)') AS source,
         sum(value_num) AS sum_val,
         min(value_num) AS min_val,
         max(value_num) AS max_val,
         avg(value_num) AS avg_val,
         (array_agg(value_num ORDER BY start_at DESC))[1] AS last_val,
         count(*)::int AS cnt
  FROM records
  WHERE value_num IS NOT NULL AND type <> ALL(ARRAY['menstruation','cervicalMucus','ovulationTest','sexualActivity','sleepStage']::text[])
  GROUP BY user_id, day, metric, source
) g
ON CONFLICT ON CONSTRAINT day_source_metrics_identity DO NOTHING;

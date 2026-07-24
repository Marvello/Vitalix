// Per-source daily rollup: one representative value per (user, day, metric,
// source), so the dashboard can overlay a line per source. Populated at ingest
// (see src/persist.js) and backfilled here from the raw records store.
//
// The sum/last/text metric lists MUST match aggregationFor() in src/records.js.
// They are frozen into this one-time backfill on purpose; live ingest keeps
// them in sync going forward.
const SUM = ["steps", "distance", "activeCalories", "totalCalories", "floorsClimbed",
  "elevationGained", "wheelchairPushes", "hydration", "nutrition"];
const LAST = ["weight", "bodyFat", "boneMass", "height", "leanBodyMass", "restingHeartRate"];
const TEXT = ["menstruation", "cervicalMucus", "ovulationTest", "sexualActivity", "sleepStage"];

const arr = (xs) => `ARRAY[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;

exports.up = (pgm) => {
  pgm.createTable("day_source_metrics", {
    id: "bigserial",
    user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" },
    day: { type: "date", notNull: true },
    metric: { type: "text", notNull: true },
    source: { type: "text", notNull: true },
    value_num: { type: "double precision" },
    min: { type: "double precision" },
    max: { type: "double precision" },
    avg: { type: "double precision" },
    count: { type: "integer" },
  });
  pgm.addConstraint("day_source_metrics", "day_source_metrics_pkey", { primaryKey: "id" });
  pgm.addConstraint("day_source_metrics", "day_source_metrics_identity", {
    unique: ["user_id", "day", "metric", "source"],
  });
  pgm.createIndex("day_source_metrics", ["user_id", "metric", "day"]);

  // Backfill from records. Day is derived from start_at (UTC); live ingest keys
  // day by the payload's day bucket, so boundary readings may differ slightly —
  // acceptable for historical rows (DO NOTHING keeps ingest authoritative).
  pgm.sql(`
    INSERT INTO day_source_metrics (user_id, day, metric, source, value_num, min, max, avg, count)
    SELECT user_id, day, metric, source,
           CASE WHEN metric = ANY(${arr(SUM)})  THEN sum_val
                WHEN metric = ANY(${arr(LAST)}) THEN last_val
                ELSE avg_val END AS value_num,
           CASE WHEN metric = ANY(${arr(SUM)}) OR metric = ANY(${arr(LAST)}) THEN NULL ELSE min_val END,
           CASE WHEN metric = ANY(${arr(SUM)}) OR metric = ANY(${arr(LAST)}) THEN NULL ELSE max_val END,
           CASE WHEN metric = ANY(${arr(SUM)}) OR metric = ANY(${arr(LAST)}) THEN NULL ELSE avg_val END,
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
      WHERE value_num IS NOT NULL AND type <> ALL(${arr(TEXT)})
      GROUP BY user_id, day, metric, source
    ) g
    ON CONFLICT ON CONSTRAINT day_source_metrics_identity DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("day_source_metrics");
};

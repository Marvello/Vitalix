// Derives bucketed series from the raw `records` table. Pure query building +
// the metric->aggregation catalog, kept free of the DB client so it is
// unit-testable without Postgres.

const SUM = ["steps", "distance", "activeCalories", "totalCalories", "floorsClimbed",
  "elevationGained", "wheelchairPushes", "hydration", "nutrition",
  "mindfulness", "intermenstrualBleeding"];
const LAST = ["weight", "bodyFat", "boneMass", "height", "leanBodyMass", "restingHeartRate",
  "basalMetabolicRate", "bodyWaterMass", "basalBodyTemperature", "menstruationPeriod"];
const TEXT = ["menstruation", "cervicalMucus", "ovulationTest", "sexualActivity", "sleepStage",
  "activityIntensity"];
// Everything else (heartRate, hrv, spo2, bloodGlucose, respiratoryRate,
// bloodPressure, power, speed, bodyTemperature, vo2Max) is a distribution.

const RULES = new Map();
for (const t of SUM) RULES.set(t, "sum");
for (const t of LAST) RULES.set(t, "last");
for (const t of TEXT) RULES.set(t, "text");

/** Aggregation rule for a metric type; unknown types default to a distribution. */
export function aggregationFor(type) {
  if (typeof type === "string" && type.startsWith("nutrition.")) return "sum";
  return RULES.get(type) ?? "minmaxavg";
}

/** date_trunc units we allow; also the API's `bucket` allowlist. `raw` is ungrouped. */
export const BUCKETS = new Set(["raw", "minute", "hour", "day", "week"]);

export const RAW_LIMIT = 5000;

/**
 * Builds a parameterized query for GET /api/records.
 * @returns {{ text: string, values: any[] }}
 */
export function buildRecordsQuery({ userId, from, to, types, bucket }) {
  if (!BUCKETS.has(bucket)) throw new Error(`invalid bucket: ${bucket}`);
  const values = [userId, from, to];
  let typeClause = "";
  if (Array.isArray(types) && types.length) {
    values.push(types);
    typeClause = ` AND type = ANY($${values.length})`;
  }
  const where = `WHERE user_id = $1 AND start_at >= $2 AND start_at < $3${typeClause}`;

  if (bucket === "raw") {
    return {
      text: `SELECT type, hc_id, start_at, end_at, value_num, value_secondary, value_text, source
             FROM records ${where} ORDER BY start_at LIMIT ${RAW_LIMIT}`,
      values,
    };
  }
  // date_trunc unit is from the validated allowlist above, never user text.
  return {
    text: `SELECT type,
                  date_trunc('${bucket}', start_at) AS bucket_start,
                  count(*)::int AS count,
                  sum(value_num) AS sum,
                  min(value_num) AS min,
                  max(value_num) AS max,
                  avg(value_num) AS avg,
                  min(value_secondary) AS min2,
                  max(value_secondary) AS max2,
                  avg(value_secondary) AS avg2,
                  (array_agg(value_num ORDER BY start_at DESC))[1] AS last,
                  (array_agg(value_text ORDER BY start_at DESC))[1] AS last_text
           FROM records ${where}
           GROUP BY type, bucket_start
           ORDER BY bucket_start, type`,
    values,
  };
}

/** Picks the fields that matter for a type's rule, so the API response is lean. */
export function shapeBucketRow(row) {
  const rule = aggregationFor(row.type);
  const base = { type: row.type, bucket_start: row.bucket_start, count: row.count };
  if (rule === "sum") return { ...base, sum: row.sum };
  if (rule === "last") return { ...base, last: row.last };
  if (rule === "text") return { ...base, last_text: row.last_text };
  return {
    ...base,
    min: row.min,
    max: row.max,
    avg: row.avg,
    ...(row.min2 != null ? { min2: row.min2, max2: row.max2, avg2: row.avg2 } : {}),
  };
}

/**
 * Rolls mapped samples up to one value per (metric, source) for a single day.
 * Uses the same aggregation rules as the bucketed API: sum metrics are summed,
 * last metrics take the latest reading, distributions carry min/max/avg (with
 * value_num = avg for a single overlay line). Text metrics and null values are
 * dropped; a null source becomes '(unknown)' so it groups and keys predictably.
 */
export function rollupSourceMetrics(samples) {
  const groups = new Map();
  for (const s of samples) {
    if (aggregationFor(s.metric) === "text") continue;
    if (s.value_num == null) continue;
    const source = s.source ?? "(unknown)";
    const key = `${s.metric}|${source}`;
    let g = groups.get(key);
    if (!g) { g = { metric: s.metric, source, values: [] }; groups.set(key, g); }
    g.values.push({ v: Number(s.value_num), t: s.start_at });
  }
  const out = [];
  for (const g of groups.values()) {
    const rule = aggregationFor(g.metric);
    const nums = g.values.map((x) => x.v);
    const count = nums.length;
    let value_num, min = null, max = null, avg = null;
    if (rule === "sum") {
      value_num = nums.reduce((a, b) => a + b, 0);
    } else if (rule === "last") {
      value_num = g.values.reduce((a, b) => (a.t >= b.t ? a : b)).v;
    } else {
      // Single-pass min/max/sum: a spread (Math.min(...nums)) would risk a
      // stack overflow on a day's worth of continuous readings for one source.
      min = Infinity;
      max = -Infinity;
      let sum = 0;
      for (const v of nums) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      avg = sum / count;
      value_num = avg;
    }
    out.push({ metric: g.metric, source: g.source, value_num, min, max, avg, count });
  }
  return out;
}

import { query } from "./db.js";

/** Metrics charted as a min/max band with an average line. */
export const BAND_METRICS = ["heartRate", "spo2", "hrv", "respiratoryRate"];

/**
 * Every day-level column the dashboard knows how to draw, with how to draw it.
 * The dashboard renders the ones that actually hold data for the range, so a
 * user who has weight but no floors sees weight and no empty floors chart.
 */
export const DAY_METRICS = [
  { column: "steps", label: "Steps", chart: "bar", trend: true, sourceKey: "steps" },
  { column: "distance", label: "Distance", unit: "m", chart: "line", sourceKey: "distance" },
  { column: "total_calories", label: "Total calories", unit: "kcal", chart: "line", sourceKey: "totalCalories" },
  { column: "active_calories", label: "Active calories", unit: "kcal", chart: "line", sourceKey: "activeCalories" },
  { column: "floors_climbed", label: "Floors climbed", chart: "bar", sourceKey: "floorsClimbed" },
  { column: "elevation_gained", label: "Elevation gained", unit: "m", chart: "line", sourceKey: "elevationGained" },
  { column: "wheelchair_pushes", label: "Wheelchair pushes", chart: "bar", sourceKey: "wheelchairPushes" },
  { column: "resting_heart_rate", label: "Resting heart rate", unit: "bpm", chart: "line", sourceKey: "restingHeartRate" },
  { column: "vo2_max", label: "VO2 max", unit: "mL/kg/min", chart: "line", sourceKey: "vo2Max" },
  { column: "weight", label: "Weight", unit: "kg", chart: "line", sourceKey: "weight" },
  { column: "body_fat", label: "Body fat", unit: "%", chart: "line", sourceKey: "bodyFat" },
  { column: "lean_body_mass", label: "Lean body mass", unit: "kg", chart: "line", sourceKey: "leanBodyMass" },
  { column: "bone_mass", label: "Bone mass", unit: "kg", chart: "line", sourceKey: "boneMass" },
  { column: "height", label: "Height", unit: "m", chart: "line", sourceKey: "height" },
  { column: "body_temperature", label: "Body temperature", unit: "\u00b0C", chart: "line", sourceKey: "bodyTemperature" },
  { column: "hydration_ml", label: "Hydration", unit: "mL", chart: "bar", sourceKey: "hydration" },
  { column: "energy_kcal", label: "Nutrition energy", unit: "kcal", chart: "bar", sourceKey: "nutrition" },
];

/** How many days in the range carry a value for each of [DAY_METRICS]. */
export async function coverage(userId, from, to) {
  const counts = DAY_METRICS.map((m) => `count(${m.column}) AS ${m.column}`).join(", ");
  const { rows } = await query(
    `SELECT ${counts} FROM health_days WHERE user_id = $1 AND day BETWEEN $2 AND $3`,
    [userId, from, to]
  );
  const row = rows[0] ?? {};
  return Object.fromEntries(DAY_METRICS.map((m) => [m.column, Number(row[m.column] ?? 0)]));
}

/** Workout sessions grouped by kind, most frequent first. */
export async function exerciseBreakdown(userId, from, to) {
  const { rows } = await query(
    `SELECT e.name, count(*)::int AS sessions,
            coalesce(sum(e.duration_minutes), 0)::int AS minutes
       FROM exercises e
       JOIN health_days hd ON hd.id = e.day_id
      WHERE hd.user_id = $1 AND hd.day BETWEEN $2 AND $3
      GROUP BY e.name
      ORDER BY sessions DESC, minutes DESC`,
    [userId, from, to]
  );
  return rows;
}

/**
 * Per-day rows for the charted columns, oldest first (chart order). Days with no
 * row at all are absent — {@link fillDays} decides how gaps are drawn.
 */
export async function dailyRows(userId, from, to) {
  const columns = DAY_METRICS.map((m) => m.column).join(", ");
  const { rows } = await query(
    `SELECT day, ${columns},
            sleep_duration_minutes, sleep_deep, sleep_light, sleep_rem, sleep_awake
       FROM health_days
      WHERE user_id = $1 AND day BETWEEN $2 AND $3
      ORDER BY day`,
    [userId, from, to]
  );
  return rows;
}

/** Per-day min/max/avg for band metrics, oldest first. */
export async function aggregateRows(userId, from, to) {
  const { rows } = await query(
    `SELECT hd.day, da.metric, da.min, da.max, da.avg
       FROM day_aggregates da
       JOIN health_days hd ON hd.id = da.day_id
      WHERE hd.user_id = $1 AND hd.day BETWEEN $2 AND $3
      ORDER BY hd.day`,
    [userId, from, to]
  );
  return rows;
}

/** Range totals and averages, computed in SQL so a long range stays one round-trip. */
export async function summary(userId, from, to) {
  const { rows } = await query(
    `SELECT count(*)::int                       AS days,
            coalesce(sum(steps), 0)::bigint     AS total_steps,
            avg(steps)                          AS avg_steps,
            coalesce(sum(distance), 0)          AS total_distance,
            coalesce(sum(active_calories), 0)   AS total_active_calories,
            coalesce(sum(total_calories), 0)    AS total_total_calories,
            avg(sleep_duration_minutes)         AS avg_sleep_minutes,
            avg(resting_heart_rate)             AS avg_resting_hr,
            max(day)                            AS last_day
       FROM health_days
      WHERE user_id = $1 AND day BETWEEN $2 AND $3`,
    [userId, from, to]
  );
  const { rows: ex } = await query(
    `SELECT count(*)::int AS workouts, coalesce(sum(e.duration_minutes), 0)::int AS workout_minutes
       FROM exercises e
       JOIN health_days hd ON hd.id = e.day_id
      WHERE hd.user_id = $1 AND hd.day BETWEEN $2 AND $3`,
    [userId, from, to]
  );
  const { rows: samples } = await query(
    `SELECT count(*)::bigint AS samples
       FROM samples s
       JOIN health_days hd ON hd.id = s.day_id
      WHERE hd.user_id = $1 AND hd.day BETWEEN $2 AND $3`,
    [userId, from, to]
  );
  return { ...rows[0], ...ex[0], ...samples[0] };
}

/** Which metrics this user actually has, so the UI only offers real ones. */
export async function availableMetrics(userId, from, to) {
  const { rows } = await query(
    `SELECT DISTINCT da.metric
       FROM day_aggregates da
       JOIN health_days hd ON hd.id = da.day_id
      WHERE hd.user_id = $1 AND hd.day BETWEEN $2 AND $3
      ORDER BY da.metric`,
    [userId, from, to]
  );
  return rows.map((r) => r.metric);
}

/**
 * Splits heart-rate samples into those recorded during a workout and the rest,
 * per day. "Resting" here means everything outside a logged exercise session —
 * sleep and sitting included — which is why it is labelled non-workout rather
 * than resting heart rate proper (that is its own recorded metric).
 */
export async function heartRateSplit(userId, from, to) {
  const { rows } = await query(
    `WITH hr AS (
       SELECT hd.day, s.start_at, s.value_num
         FROM samples s
         JOIN health_days hd ON hd.id = s.day_id
        WHERE hd.user_id = $1 AND hd.day BETWEEN $2 AND $3
          AND s.metric = 'heartRate' AND s.value_num IS NOT NULL
     ), windows AS (
       -- Sessions are matched by timestamp, not by day, so one crossing midnight
       -- still claims its samples on both sides.
       SELECT e.start_at,
              e.start_at + make_interval(mins => coalesce(e.duration_minutes, 0)) AS end_at
         FROM exercises e
         JOIN health_days hd ON hd.id = e.day_id
        WHERE hd.user_id = $1 AND hd.day BETWEEN $2 AND $3
     )
     SELECT hr.day,
            CASE WHEN EXISTS (
              SELECT 1 FROM windows w
               WHERE hr.start_at >= w.start_at AND hr.start_at < w.end_at
            ) THEN 'active' ELSE 'rest' END AS scope,
            min(hr.value_num) AS min,
            max(hr.value_num) AS max,
            avg(hr.value_num) AS avg,
            count(*)::int     AS samples
       FROM hr
      GROUP BY 1, 2
      ORDER BY 1`,
    [userId, from, to]
  );
  return rows;
}

/** Newest-first list for the recent-days table. */
export async function recentDays(userId, limit = 14) {
  const { rows } = await query(
    `SELECT day, steps, distance, active_calories, sleep_duration_minutes, resting_heart_rate
       FROM health_days
      WHERE user_id = $1
      ORDER BY day DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/** Distinct data sources present in the range, for the dashboard source filter. */
export async function availableSources(userId, from, to) {
  const { rows } = await query(
    `SELECT DISTINCT source FROM day_source_metrics
      WHERE user_id = $1 AND day BETWEEN $2 AND $3
      ORDER BY source`,
    [userId, from, to]
  );
  return rows.map((r) => r.source);
}

/** Number of data points per source in range. */
export async function sourceCounts(userId, from, to) {
  const { rows } = await query(
    `SELECT source, sum(count)::int AS total
       FROM day_source_metrics
      WHERE user_id = $1 AND day BETWEEN $2 AND $3
      GROUP BY source
      ORDER BY total DESC`,
    [userId, from, to]
  );
  return Object.fromEntries(rows.map((r) => [r.source, r.total]));
}

/** Per-(day, metric, source) rollup rows for the requested metrics and sources. */
export async function sourceRows(userId, from, to, metrics, sources) {
  if (!metrics.length || !sources.length) return [];
  const { rows } = await query(
    `SELECT day, metric, source, value_num, min, max, avg
       FROM day_source_metrics
      WHERE user_id = $1 AND day BETWEEN $2 AND $3
        AND metric = ANY($4) AND source = ANY($5)
      ORDER BY day`,
    [userId, from, to, metrics, sources]
  );
  return rows;
}

export const CARD_CATALOG = [
  // Activity
  { key: "steps",             label: "Steps",              category: "Activity",        type: "bar"  },
  { key: "distance",          label: "Distance",           category: "Activity",        type: "line" },
  { key: "total_calories",    label: "Total calories",     category: "Activity",        type: "line" },
  { key: "active_calories",   label: "Active calories",    category: "Activity",        type: "line" },
  { key: "floors_climbed",    label: "Floors climbed",     category: "Activity",        type: "bar"  },
  { key: "elevation_gained",  label: "Elevation gained",   category: "Activity",        type: "line" },
  { key: "wheelchair_pushes", label: "Wheelchair pushes",  category: "Activity",        type: "bar"  },
  // Heart & Lungs
  { key: "resting_heart_rate",    label: "Resting heart rate",  category: "Heart & Lungs", type: "line" },
  { key: "band:heartRate",        label: "Heart rate",          category: "Heart & Lungs", type: "band" },
  { key: "band:spo2",             label: "SpO2",                category: "Heart & Lungs", type: "band" },
  { key: "band:hrv",              label: "HRV",                 category: "Heart & Lungs", type: "band" },
  { key: "band:respiratoryRate",  label: "Respiratory rate",    category: "Heart & Lungs", type: "band" },
  { key: "vo2_max",               label: "VO2 max",             category: "Heart & Lungs", type: "line" },
  // Body
  { key: "weight",           label: "Weight",          category: "Body", type: "line" },
  { key: "body_fat",         label: "Body fat",        category: "Body", type: "line" },
  { key: "lean_body_mass",   label: "Lean body mass",  category: "Body", type: "line" },
  { key: "bone_mass",        label: "Bone mass",       category: "Body", type: "line" },
  { key: "height",           label: "Height",          category: "Body", type: "line" },
  { key: "body_temperature", label: "Body temperature",category: "Body", type: "line" },
  // Nutrition
  { key: "hydration_ml",  label: "Hydration",  category: "Nutrition", type: "bar"  },
  { key: "energy_kcal",   label: "Energy",     category: "Nutrition", type: "bar"  },
  // Sleep & Recovery
  { key: "sleep",  label: "Sleep",  category: "Sleep & Recovery", type: "stacked" },
  // Workouts
  { key: "workouts",  label: "Workouts",                    category: "Workouts", type: "table" },
  { key: "hr_split",  label: "Heart rate — workout vs rest", category: "Workouts", type: "split_band" },
  // Overview
  { key: "recent",  label: "Recent days",  category: "Overview", type: "table" },
];

const VALID_KEYS = new Set(CARD_CATALOG.map((c) => c.key));

export function isValidCardKey(key) {
  return VALID_KEYS.has(key);
}

export async function getLayout(userId) {
  const { rows } = await query(
    "SELECT cards FROM dashboard_layouts WHERE user_id = $1",
    [userId],
  );
  return rows.length ? rows[0].cards : null;
}

export async function saveLayout(userId, cards) {
  await query(
    `INSERT INTO dashboard_layouts (user_id, cards)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET cards = $2`,
    [userId, JSON.stringify(cards)],
  );
}

export async function deleteLayout(userId) {
  await query("DELETE FROM dashboard_layouts WHERE user_id = $1", [userId]);
}

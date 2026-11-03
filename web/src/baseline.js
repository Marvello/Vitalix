import { query as dbQuery } from "./db.js";

export const BASELINE_DAYS = 28;

// Doc map: where each dailySeries field comes from (DAILY_SERIES_SQL implements it).
export const METRIC_SOURCES = {
  restingHr: "health_days.resting_heart_rate",
  hrv: "day_aggregates hrv avg",
  spo2Min: "day_aggregates spo2 min",
  bpSys: "day_aggregates bpSystolic avg",
  bpDia: "day_aggregates bpDiastolic avg",
  sleepMin: "health_days.sleep_duration_minutes",
  deepMin: "health_days.sleep_deep",
  steps: "health_days.steps",
  activeKcal: "health_days.active_calories",
  mood: "journal_entries mood avg",
  caffeine: "journal_entries caffeine sum (cups)",
  alcohol: "journal_entries alcohol sum (drinks)",
};

// Mean + sample SD (n-1) of the finite numbers in `values`; null when none.
export function stats(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length === 1 ? 0 : Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  return { mean, sd, n: v.length };
}

export const DAILY_SERIES_SQL = `
  SELECT h.day::text AS day,
         h.resting_heart_rate AS "restingHr",
         MAX(a.avg) FILTER (WHERE a.metric = 'hrv') AS hrv,
         MIN(a.min) FILTER (WHERE a.metric = 'spo2') AS "spo2Min",
         MAX(a.avg) FILTER (WHERE a.metric = 'bpSystolic') AS "bpSys",
         MAX(a.avg) FILTER (WHERE a.metric = 'bpDiastolic') AS "bpDia",
         h.sleep_duration_minutes AS "sleepMin",
         h.sleep_deep AS "deepMin",
         h.steps,
         h.active_calories AS "activeKcal",
         MAX(j.mood) AS mood, MAX(j.caffeine) AS caffeine, MAX(j.alcohol) AS alcohol
  FROM health_days h
  LEFT JOIN day_aggregates a ON a.day_id = h.id
  LEFT JOIN (
    SELECT day,
           AVG(value_num) FILTER (WHERE kind = 'mood') AS mood,
           SUM(value_num) FILTER (WHERE kind = 'caffeine') AS caffeine,
           SUM(value_num) FILTER (WHERE kind = 'alcohol') AS alcohol
    FROM journal_entries WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day
  ) j ON j.day = h.day
  WHERE h.user_id = $1 AND h.day BETWEEN $2 AND $3
  GROUP BY h.id
  ORDER BY h.day`;

const num = (x) => (x == null ? null : Number(x));

// One row per stored day in [from, to] (YYYY-MM-DD, inclusive); metrics are number|null.
export async function dailySeries(userId, from, to, { query = dbQuery } = {}) {
  const { rows } = await query(DAILY_SERIES_SQL, [userId, from, to]);
  return rows.map(({ day, ...m }) => ({
    day,
    ...Object.fromEntries(Object.entries(m).map(([k, x]) => [k, num(x)])),
  }));
}

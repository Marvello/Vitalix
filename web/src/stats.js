import { query } from "./db.js";

/** Metrics charted as a min/max band with an average line. */
export const BAND_METRICS = ["heartRate", "spo2", "hrv", "respiratoryRate"];

/**
 * Per-day rows for the charted columns, oldest first (chart order). Days with no
 * row at all are absent — {@link fillDays} decides how gaps are drawn.
 */
export async function dailyRows(userId, from, to) {
  const { rows } = await query(
    `SELECT day, steps, distance, active_calories, total_calories,
            sleep_duration_minutes, sleep_deep, sleep_light, sleep_rem, sleep_awake,
            resting_heart_rate, weight, hydration_ml, energy_kcal, floors_climbed
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

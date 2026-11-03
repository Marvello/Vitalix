import { query as dbQuery } from "./db.js";
import { messaging as defaultMessaging } from "./firebase.js";
import { pushToUser } from "./push.js";
import { GENERATE_HOUR } from "./dailyInsights.js";
import { BASELINE_DAYS, dailySeries, stats } from "./baseline.js";

export const MIN_HISTORY = 14; // statistical rules need this many days in the window

// Same pick as dailyInsights' PENDING_USERS_SQL minus the NOT EXISTS: the unique
// key on anomaly_alerts makes re-runs free, so there is no per-user "done" marker.
export const PENDING_ANOMALY_USERS_SQL = `
  SELECT u.id, y.day::text AS day
  FROM users u
  CROSS JOIN LATERAL (
    SELECT (now() AT TIME ZONE COALESCE(u.timezone, 'UTC')) AS local_now
  ) n
  CROSS JOIN LATERAL (SELECT n.local_now::date - 1 AS day) y
  WHERE u.disabled_at IS NULL
    AND EXTRACT(HOUR FROM n.local_now) >= ${GENERATE_HOUR}
    AND EXISTS (SELECT 1 FROM health_days h WHERE h.user_id = u.id AND h.day = y.day)`;

const has = (x) => typeof x === "number" && Number.isFinite(x);
const baselineOf = (history, key) => {
  const s = stats(history.map((r) => r[key]));
  return s && s.n >= MIN_HISTORY ? s : null;
};

// today = evaluated day row; recent = the 3 rows ending at today; history = the
// 28 rows before recent. Returns [{ rule, value, baseline, text? }] (text = bp "sys/dia").
export function detectAnomalies({ today, recent, history }) {
  const out = [];

  const rhr = baselineOf(history, "restingHr");
  if (rhr && recent.length === 3 && recent.every((r) => has(r.restingHr))) {
    const limit = rhr.mean + Math.max(rhr.sd, 3);
    if (recent.every((r) => r.restingHr >= limit)) out.push({ rule: "rhr_up", value: today.restingHr, baseline: rhr.mean });
  }

  const hrv = baselineOf(history, "hrv");
  if (hrv && hrv.sd > 0 && has(today.hrv) && today.hrv <= hrv.mean - 2 * hrv.sd) {
    out.push({ rule: "hrv_drop", value: today.hrv, baseline: hrv.mean });
  }

  if (has(today.spo2Min) && today.spo2Min < 90) out.push({ rule: "spo2_low", value: today.spo2Min, baseline: null });

  if ((has(today.bpSys) && today.bpSys >= 140) || (has(today.bpDia) && today.bpDia >= 90)) {
    const text = [today.bpSys, today.bpDia].filter(has).map(Math.round).join("/");
    out.push({ rule: "bp_high", value: has(today.bpSys) ? today.bpSys : today.bpDia, baseline: null, text });
  }
  return out;
}

const shift = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
const INSERT_SQL = `INSERT INTO anomaly_alerts (user_id, day, rule, value, baseline)
  VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, day, rule) DO NOTHING RETURNING id`;

// Evaluates each pending user's local yesterday, stores new alerts and pushes
// one `anomaly` message per alert actually inserted. Deps injected for testing.
export async function runAnomalyCheck({ query = dbQuery, messaging = defaultMessaging } = {}) {
  const { rows } = await query(PENDING_ANOMALY_USERS_SQL);
  let alerts = 0;
  let pushed = 0;

  for (const { id, day } of rows) {
    const firstRecent = shift(day, -2);
    const series = await dailySeries(id, shift(firstRecent, -BASELINE_DAYS), day, { query });
    const byDay = new Map(series.map((r) => [r.day, r]));
    const today = byDay.get(day);
    if (!today) continue;
    const recent = [0, 1, 2].map((i) => byDay.get(shift(firstRecent, i))).filter(Boolean);
    const history = series.filter((r) => r.day < firstRecent);

    for (const a of detectAnomalies({ today, recent, history })) {
      const ins = await query(INSERT_SQL, [id, day, a.rule, a.value, a.baseline]);
      if (!ins.rows.length) continue;
      alerts++;
      const data = {
        type: "anomaly", day, rule: a.rule,
        value: a.text ?? String(Math.round(a.value)),
        baseline: a.baseline == null ? "" : String(Math.round(a.baseline)),
      };
      if ((await pushToUser({ query, messaging }, id, data)).sent) pushed++;
    }
  }
  return { candidates: rows.length, alerts, pushed };
}

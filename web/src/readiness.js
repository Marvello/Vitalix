import { stats, BASELINE_DAYS, dailySeries } from "./baseline.js";

const MIN_HISTORY_DAYS = 7;
const WEIGHTS = { hrv: 0.4, restingHr: 0.3, sleep: 0.3 };
const clamp = (x) => Math.min(100, Math.max(0, x));
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Position against the personal baseline: 50 at the mean, +-15 per SD. `sign` -1 = lower is better.
function zPart(value, history, sign) {
  const b = stats(history);
  if (typeof value !== "number" || !b || b.n < MIN_HISTORY_DAYS) return null;
  return clamp(50 + (b.sd === 0 ? 0 : sign * 15 * ((value - b.mean) / b.sd)));
}

/**
 * Pure. `today`: a dailySeries row; `history`: the (up to 28) rows before it.
 * Weighted mean of the parts present (HRV 0.4, resting HR 0.3, sleep 0.3); null under 2 parts.
 */
export function readinessScore({ today, history }) {
  const raw = {
    hrv: zPart(today.hrv, history.map((r) => r.hrv), 1),
    restingHr: zPart(today.restingHr, history.map((r) => r.restingHr), -1),
    sleep: typeof today.sleepMin === "number" ? Math.min(1, today.sleepMin / 480) * 100 : null,
  };
  const present = Object.keys(raw).filter((k) => raw[k] != null);
  if (present.length < 2) return null;
  const weight = present.reduce((s, k) => s + WEIGHTS[k], 0);
  const score = Math.round(present.reduce((s, k) => s + WEIGHTS[k] * raw[k], 0) / weight);
  return { score, parts: Object.fromEntries(present.map((k) => [k, Math.round(raw[k])])) };
}

/** Score for each row of `rows` with from <= day <= to; history is picked by date, not index. */
export function readinessSeries(rows, from, to) {
  const out = [];
  for (const today of rows) {
    if (today.day < from || today.day > to) continue;
    const start = shift(today.day, -BASELINE_DAYS);
    const r = readinessScore({ today, history: rows.filter((h) => h.day < today.day && h.day >= start) });
    if (r) out.push({ day: today.day, ...r });
  }
  return out;
}

/** Readiness for one day, or null. */
export async function readinessForDay(userId, day) {
  const rows = await dailySeries(userId, shift(day, -BASELINE_DAYS), day);
  return readinessSeries(rows, day, day)[0] ?? null;
}

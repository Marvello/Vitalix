import { shiftDay } from "./ai/recommendations.js";

export const PRESETS = [
  { x: "sleepMin", y: "hrv", lag: 1, label: "Sleep → next-day HRV" },
  { x: "sleepMin", y: "restingHr", lag: 1, label: "Sleep → next-day resting HR" },
  { x: "steps", y: "deepMin", lag: 1, label: "Steps → that night's deep sleep" },
  { x: "activeKcal", y: "restingHr", lag: 1, label: "Active calories → next-day resting HR" },
  { x: "caffeine", y: "deepMin", lag: 1, label: "Caffeine → that night's deep sleep" },
  { x: "alcohol", y: "hrv", lag: 1, label: "Alcohol → next-day HRV" },
];

export const METRICS = ["restingHr", "hrv", "spo2Min", "bpSys", "bpDia", "sleepMin", "deepMin", "steps", "activeKcal", "mood", "caffeine", "alcohol"];

/** Pairs [x, y] by date: y comes from the row `lag` days after x's day; a missing day yields no pair. */
export function pairSeries(rows, xKey, yKey, lag) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (const r of rows) {
    const y = byDay.get(lag ? shiftDay(r.day, lag) : r.day);
    if (y) out.push([r[xKey], y[yKey]]);
  }
  return out;
}

/** Pearson r over pairs where both are finite numbers; null when n < 10 or either variance is (numerically) 0; r is clamped to [-1, 1]. */
export function pearson(xs, ys) {
  const p = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = p.length;
  if (n < 10) return null;
  const mx = p.reduce((s, [x]) => s + x, 0) / n;
  const my = p.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  // Relative epsilon: float noise on a constant series must not read as variance.
  if (sxx <= 1e-12 * n * Math.max(1, mx * mx) || syy <= 1e-12 * n * Math.max(1, my * my)) return null;
  return { r: Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy))), n };
}

export function strength(r) {
  const a = Math.abs(r);
  return a < 0.2 ? "none" : a < 0.4 ? "weak" : a < 0.6 ? "moderate" : "strong";
}

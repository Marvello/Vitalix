/**
 * Pure shaping of database rows into the series the dashboard draws. Kept free
 * of SQL and DOM so the awkward parts — date gaps, null vs zero, rolling
 * averages — are unit-testable without a database or a browser.
 */

/** `Date` or string to YYYY-MM-DD, the key format used throughout the charts. */
export function toKey(day) {
  if (day instanceof Date) {
    // Local parts, not toISOString(): a UTC shift can move a day across midnight.
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    return `${day.getFullYear()}-${m}-${d}`;
  }
  return String(day).slice(0, 10);
}

/** Every date from `from` to `to` inclusive, so gaps are visible rather than skipped. */
export function dateRange(from, to) {
  const out = [];
  const cursor = new Date(`${toKey(from)}T00:00:00Z`);
  const end = new Date(`${toKey(to)}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Aligns rows onto a continuous date axis. A missing day is null, not 0 — the
 * difference between "didn't wear the watch" and "took no steps" matters.
 */
export function fillDays(rows, from, to, column) {
  const byDay = new Map(rows.map((r) => [toKey(r.day), r]));
  return dateRange(from, to).map((date) => {
    const row = byDay.get(date);
    const value = row ? row[column] : null;
    return { date, value: value == null ? null : Number(value) };
  });
}

/** Trailing mean over `window` points, ignoring nulls; null until any data exists. */
export function rollingAverage(points, window = 7) {
  return points.map((p, i) => {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1)
      .map((s) => s.value)
      .filter((v) => v != null);
    if (slice.length === 0) return { date: p.date, value: null };
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    return { date: p.date, value: Math.round(mean * 100) / 100 };
  });
}

/** Min/max/avg per day for one band metric, aligned to the date axis. */
export function bandSeries(aggregateRows, from, to, metric) {
  const byDay = new Map(
    aggregateRows.filter((r) => r.metric === metric).map((r) => [toKey(r.day), r])
  );
  return dateRange(from, to).map((date) => {
    const r = byDay.get(date);
    return {
      date,
      min: r?.min == null ? null : Number(r.min),
      max: r?.max == null ? null : Number(r.max),
      avg: r?.avg == null ? null : Number(r.avg),
    };
  });
}

/**
 * Pairs the workout and non-workout heart-rate aggregates onto one date axis,
 * so both can be drawn in a single chart. Either side may be missing for a day:
 * no workout means no active reading, which is not the same as a zero.
 */
export function splitSeries(rows, from, to, scopes = ["active", "rest"]) {
  const byDay = new Map();
  for (const r of rows) {
    const key = toKey(r.day);
    if (!byDay.has(key)) byDay.set(key, {});
    byDay.get(key)[r.scope] = r;
  }
  const num = (v) => (v == null ? null : Number(v));
  return dateRange(from, to).map((date) => {
    const day = byDay.get(date) ?? {};
    const point = { date };
    for (const scope of scopes) {
      const r = day[scope];
      point[scope] = r
        ? { min: num(r.min), max: num(r.max), avg: num(r.avg), samples: num(r.samples) }
        : null;
    }
    return point;
  });
}

/** Sleep stages as stacked series; days without sleep data stay null across the board. */
export function sleepStages(rows, from, to) {
  const byDay = new Map(rows.map((r) => [toKey(r.day), r]));
  return dateRange(from, to).map((date) => {
    const r = byDay.get(date);
    const num = (v) => (v == null ? null : Number(v));
    return {
      date,
      deep: num(r?.sleep_deep),
      light: num(r?.sleep_light),
      rem: num(r?.sleep_rem),
      awake: num(r?.sleep_awake),
      total: num(r?.sleep_duration_minutes),
    };
  });
}

/**
 * Picks the day metrics worth drawing: those with at least one value in the
 * range. Rendering the full catalogue would fill the page with flat empty
 * charts for everything a given device never records.
 */
export function visibleMetrics(catalog, coverage) {
  return catalog.filter((m) => (coverage?.[m.column] ?? 0) > 0);
}

/**
 * Summary tiles, dropping any whose value is missing. An absent metric reads
 * better as no tile than as a tile showing "—" or a hollow 0.
 */
export function visibleTiles(tiles) {
  return tiles.filter((t) => t.value !== null && t.value !== undefined);
}

/** Human-facing summary tiles. Nulls become "—" rather than 0 or NaN. */
export function summaryTiles(summary) {
  const num = (v) => (v == null ? null : Number(v));
  // A summed metric that totals zero across the range was never recorded.
  const zeroToNull = (v) => (v ? v : null);
  const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const hours = (minutes) => {
    if (minutes == null) return null;
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  };
  return [
    { label: "Days recorded", value: num(summary.days) ?? 0 },
    { label: "Total steps", value: round(num(summary.total_steps)) },
    { label: "Avg steps / day", value: round(num(summary.avg_steps)) },
    { label: "Distance", value: zeroToNull(round(num(summary.total_distance) / 1000, 2)), unit: "km" },
    // Devices record one or the other; showing an empty tile for the variant
    // this user's phone never writes is just noise.
    {
      label: "Active calories",
      value: zeroToNull(round(num(summary.total_active_calories))),
      unit: "kcal",
    },
    {
      label: "Total calories",
      value: zeroToNull(round(num(summary.total_total_calories))),
      unit: "kcal",
    },
    { label: "Avg sleep", value: hours(num(summary.avg_sleep_minutes)) },
    { label: "Avg resting HR", value: round(num(summary.avg_resting_hr)), unit: "bpm" },
    { label: "Workouts", value: zeroToNull(num(summary.workouts)) },
  ];
}

/** Nicely formatted metric names for chart titles. */
export function metricLabel(metric) {
  const known = {
    heartRate: "Heart rate",
    spo2: "Blood oxygen",
    hrv: "Heart rate variability",
    respiratoryRate: "Respiratory rate",
    bloodGlucose: "Blood glucose",
    bodyTemperature: "Body temperature",
  };
  if (known[metric]) return known[metric];
  // camelCase to sentence case: "totalCalories" -> "Total calories".
  const spaced = metric.replace(/([A-Z])/g, (c) => " " + c.toLowerCase()).trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Overlay palette for per-source lines. Deliberately avoids the combined line's
 * teal (#0FA9A0) and the 7-day-average green (#34D399) so sources stand apart.
 */
const SOURCE_PALETTE = ["#6366f1", "#f59e0b", "#ec4899", "#0ea5e9", "#eab308", "#a855f7", "#ef4444", "#14b8a6"];

/** Stable source→color map, keyed by position in the given source list. */
export function assignSourceColors(sources) {
  const map = {};
  sources.forEach((s, i) => { map[s] = SOURCE_PALETTE[i % SOURCE_PALETTE.length]; });
  return map;
}

const KNOWN_APPS = {
  "com.google.android.apps.fitness": "Google Fit",
  "com.samsung.shealth": "Samsung Health",
  "com.samsung.health": "Samsung Health",
  "com.sec.android.app.shealth": "Samsung Health",
  "com.huawei.health": "Huawei Health",
  "com.xiaomi.wearable": "Mi Fitness",
  "com.mi.health": "Mi Health",
  "com.fitbit.FitbitMobile": "Fitbit",
  "com.garmin.android.apps.connectmobile": "Garmin Connect",
  "com.polar.polarflow": "Polar Flow",
  "com.withings.wiscale2": "Withings",
  "com.oura.android": "Oura",
  "com.whoop.android": "WHOOP",
  "com.strava": "Strava",
  "com.zepp.client": "Zepp",
  "com.amazfit.watch": "Amazfit",
  "com.headspin.coros": "COROS",
  "com.suunto.suuntoapp": "Suunto",
  "com.apple.health": "Apple Health",
  "com.android.vitalix": "Vitalix",
  "com.healthexport": "Health Export",
};

const PREFIX_APPS = [
  ["com.android.healthconnect", "Health Connect"],
  ["com.google.android.apps.healthdata", "Health Connect"],
];

export function sourceDisplayName(pkg) {
  if (!pkg) return "Unknown";
  if (KNOWN_APPS[pkg]) return KNOWN_APPS[pkg];
  for (const [prefix, name] of PREFIX_APPS) {
    if (pkg.startsWith(prefix)) return name;
  }
  const parts = pkg.split(".");
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (/^[a-f0-9]{20,}$/.test(last) && parts.length >= 3) return parts[parts.length - 2];
    return last.charAt(0).toUpperCase() + last.slice(1);
  }
  return pkg;
}

/**
 * Per-source daily lines for one metric, aligned to the same date axis as the
 * combined series so the overlays share the chart's x-axis. Only sources with
 * at least one value in range are returned.
 */
export function sourceLines(rows, from, to, metricKey, colors) {
  const bySource = new Map();
  for (const r of rows) {
    if (r.metric !== metricKey) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, new Map());
    bySource.get(r.source).set(toKey(r.day), r);
  }
  const axis = dateRange(from, to);
  const out = [];
  for (const [source, byDay] of bySource) {
    const points = axis.map((date) => {
      const r = byDay.get(date);
      return { date, value: r && r.value_num != null ? Number(r.value_num) : null };
    });
    if (points.some((p) => p.value != null)) {
      out.push({ source, color: colors[source] ?? "#94a3b8", points });
    }
  }
  return out;
}

/**
 * Carries the last known value forward across gaps in the data.
 * Returns null before the first data point exists.
 */
export function fillForward(rows, from, to, column) {
  const byDay = new Map(rows.map((r) => [toKey(r.day), r]));
  let last = null;
  return dateRange(from, to).map((date) => {
    const row = byDay.get(date);
    const value = row ? row[column] : null;
    if (value != null) last = Number(value);
    return { date, value: last };
  });
}

/**
 * Computes BMI from weight (kg) and height (m).
 * Returns null if either input is null or height is 0 or negative.
 * Result is rounded to 1 decimal place.
 */
export function bmiFromWeightHeight(weightKg, heightM) {
  if (weightKg == null || heightM == null || heightM <= 0) return null;
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10;
}

/**
 * Categorizes BMI based on the given scale ("standard" or "asian").
 * Standard uses WHO boundaries: <18.5 (Underweight), 18.5-24.9 (Normal), 25-29.9 (Overweight), >=30 (Obese).
 * Asian uses adjusted boundaries: <18.5 (Underweight), 18.5-22.9 (Normal), 23-27.4 (Overweight), >=27.5 (Obese).
 * Returns null if bmi is null.
 */
export function bmiCategory(bmi, scale) {
  if (bmi == null) return null;
  if (scale === "asian") {
    if (bmi < 18.5) return "Underweight";
    if (bmi < 23) return "Normal";
    if (bmi < 27.5) return "Overweight";
    return "Obese";
  }
  if (bmi < 18.5) return "Underweight";
  if (bmi < 25) return "Normal";
  if (bmi < 30) return "Overweight";
  return "Obese";
}

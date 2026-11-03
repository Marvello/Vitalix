import { withTransaction } from "./db.js";
import { rollupSourceMetrics } from "./records.js";

const DAY_COLUMNS = [
  "steps", "active_calories", "total_calories", "distance", "floors_climbed",
  "elevation_gained", "power", "speed", "wheelchair_pushes", "vo2_max",
  "weight", "body_fat", "bone_mass", "height", "lean_body_mass",
  "resting_heart_rate", "body_temperature",
  "sleep_duration_minutes", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake",
  "menstruation", "cervical_mucus", "ovulation_test", "sexual_activity",
  "hydration_ml", "energy_kcal",
];

async function upsertDay(client, syncId, userId, day) {
  const cols = ["sync_id", "user_id", "day", ...DAY_COLUMNS];
  const values = [syncId, userId, day.day, ...DAY_COLUMNS.map((c) => day.scalars[c] ?? null)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  // Merge rather than replace: a sync that covers only part of a day (the app's
  // backfill slices overlap at their boundaries) would otherwise blank columns it
  // simply didn't see. COALESCE keeps the previously stored value in that case.
  const updates = [
    "sync_id = EXCLUDED.sync_id",
    ...DAY_COLUMNS.map((c) => `${c} = COALESCE(EXCLUDED.${c}, health_days.${c})`),
  ].join(", ");
  const sql = `
    INSERT INTO health_days (${cols.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT (user_id, day) DO UPDATE SET ${updates}
    RETURNING id`;
  const { rows } = await client.query(sql, values);
  return rows[0].id;
}

// One INSERT … SELECT FROM unnest(typed arrays) per call, so statement count is
// independent of row count. cols: [name, pgType, pick(row)]. keyOf dedupes in JS
// (last wins) because ON CONFLICT DO UPDATE cannot hit one row twice per statement.
// ponytail: one statement per day keeps param arrays small; no COPY.
async function bulkInsert(client, table, cols, rows, { keyOf, onConflict = "" } = {}) {
  if (keyOf) rows = [...new Map(rows.map((r) => [keyOf(r), r])).values()];
  if (!rows.length) return 0;
  const sql = `INSERT INTO ${table} (${cols.map((c) => c[0]).join(", ")})
    SELECT * FROM unnest(${cols.map((c, i) => `$${i + 1}::${c[1]}[]`).join(", ")}) ${onConflict}`;
  await client.query(sql, cols.map((c) => rows.map(c[2])));
  return rows.length;
}
const json = (v) => (v == null ? null : JSON.stringify(v));
// Same instant, different string spelling, is the same conflict key.
const instant = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? v : t; };

// Replace per metric, not per day: a metric absent from this payload (throttled
// by Health Connect, or outside an older app's partial window) keeps its rows.
async function replaceAggregates(client, dayId, aggregates) {
  const metrics = [...new Set(aggregates.map((a) => a.metric))];
  await client.query("DELETE FROM day_aggregates WHERE day_id = $1 AND metric = ANY($2)", [dayId, metrics]);
  await bulkInsert(client, "day_aggregates", [
    ["day_id", "bigint", () => dayId], ["metric", "text", (a) => a.metric],
    ["min", "double precision", (a) => a.min], ["max", "double precision", (a) => a.max],
    ["avg", "double precision", (a) => a.avg],
  ], aggregates);
}

async function replaceExercises(client, dayId, exercises) {
  const withId = exercises.filter((e) => e.hc_id);
  const withoutId = exercises.filter((e) => !e.hc_id);
  const cols = [
    ["day_id", "bigint", () => dayId], ["name", "text", (e) => e.name],
    ["start_at", "timestamptz", (e) => e.start_at], ["duration_minutes", "integer", (e) => e.duration_minutes],
    ["source", "text", (e) => e.source], ["hc_id", "text", (e) => e.hc_id ?? null],
    ["detail", "jsonb", (e) => json(e.detail)],
  ];
  // Legacy path for UID-less rows: clear only those we would re-insert blind.
  if (withoutId.length) {
    await client.query("DELETE FROM exercises WHERE day_id = $1 AND hc_id IS NULL", [dayId]);
    await bulkInsert(client, "exercises", cols, withoutId);
  }
  await bulkInsert(client, "exercises", cols, withId, {
    keyOf: (e) => e.hc_id,
    onConflict: `ON CONFLICT (day_id, hc_id) DO UPDATE SET
      name = EXCLUDED.name, start_at = EXCLUDED.start_at,
      duration_minutes = EXCLUDED.duration_minutes, source = EXCLUDED.source, detail = EXCLUDED.detail`,
  });
}

async function upsertRecords(client, userId, samples) {
  // older app builds without a UID: keep out of records
  return bulkInsert(client, "records", [
    ["user_id", "bigint", () => userId], ["type", "text", (s) => s.metric], ["hc_id", "text", (s) => s.hc_id],
    ["start_at", "timestamptz", (s) => s.start_at], ["end_at", "timestamptz", (s) => s.end_at],
    ["value_num", "double precision", (s) => s.value_num], ["value_secondary", "double precision", (s) => s.value_secondary],
    ["value_text", "text", (s) => s.value_text], ["source", "text", (s) => s.source], ["meta", "jsonb", (s) => json(s.meta)],
  ], samples.filter((s) => s.hc_id), {
    keyOf: (s) => `${s.metric}|${instant(s.start_at)}|${s.hc_id}`,
    onConflict: `ON CONFLICT (user_id, type, start_at, hc_id) DO UPDATE SET
      end_at = EXCLUDED.end_at, value_num = EXCLUDED.value_num,
      value_secondary = EXCLUDED.value_secondary, value_text = EXCLUDED.value_text, source = EXCLUDED.source, meta = EXCLUDED.meta`,
  });
}

async function upsertSourceMetrics(client, userId, day) {
  // rollupSourceMetrics yields one row per (metric, source): no in-batch duplicates.
  return bulkInsert(client, "day_source_metrics", [
    ["user_id", "bigint", () => userId], ["day", "date", () => day.day], ["metric", "text", (r) => r.metric],
    ["source", "text", (r) => r.source], ["value_num", "double precision", (r) => r.value_num],
    ["min", "double precision", (r) => r.min], ["max", "double precision", (r) => r.max],
    ["avg", "double precision", (r) => r.avg], ["count", "integer", (r) => r.count],
  ], rollupSourceMetrics(day.samples), {
    onConflict: `ON CONFLICT ON CONSTRAINT day_source_metrics_identity DO UPDATE SET
      value_num = EXCLUDED.value_num, min = EXCLUDED.min, max = EXCLUDED.max,
      avg = EXCLUDED.avg, count = EXCLUDED.count`,
  });
}

// Records the phone saw deleted in Health Connect, scoped to this user.
// ponytail: a health_days scalar whose only source record was deleted keeps its
// old value, because days merge with COALESCE(new, old); fix needs a
// recompute-from-records step, add when it shows up. day_source_metrics rows
// (no hc_id) likewise stay until that day is re-sent.
async function deleteByHcId(client, userId, ids) {
  if (!ids?.length) return 0;
  const r = await client.query("DELETE FROM records WHERE user_id = $1 AND hc_id = ANY($2)", [userId, ids]);
  const e = await client.query(
    `DELETE FROM exercises e USING health_days d
      WHERE e.day_id = d.id AND d.user_id = $1 AND e.hc_id = ANY($2)`, [userId, ids]);
  return r.rowCount + e.rowCount;
}

export function persist(userId, mapped) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO syncs (user_id, source, app_version, device, exported_at, range_days, failed_metrics) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [userId, mapped.sync.source, mapped.sync.app_version, mapped.sync.device, mapped.sync.exported_at, mapped.sync.range_days, mapped.sync.failed_metrics ?? null]
    );
    const syncId = rows[0].id;
    // Before the upserts: a re-read in this same payload is newer than the deletion.
    const deleted = await deleteByHcId(client, userId, mapped.deletedHcIds);
    let samples = 0, exercises = 0, records = 0, sourceMetrics = 0;
    for (const day of mapped.days) {
      const dayId = await upsertDay(client, syncId, userId, day);
      await replaceAggregates(client, dayId, day.aggregates);
      await replaceExercises(client, dayId, day.exercises);
      records += await upsertRecords(client, userId, day.samples);
      sourceMetrics += await upsertSourceMetrics(client, userId, day);
      samples += day.samples.length;
      exercises += day.exercises.length;
    }
    return { days: mapped.days.length, samples, exercises, records, sourceMetrics, deleted };
  });
}

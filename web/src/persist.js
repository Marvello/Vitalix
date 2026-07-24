import { withTransaction } from "./db.js";

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

async function replaceAggregates(client, dayId, aggregates) {
  await client.query("DELETE FROM day_aggregates WHERE day_id = $1", [dayId]);
  for (const a of aggregates) {
    await client.query(
      "INSERT INTO day_aggregates (day_id, metric, min, max, avg) VALUES ($1,$2,$3,$4,$5)",
      [dayId, a.metric, a.min, a.max, a.avg]
    );
  }
}

async function replaceSamples(client, dayId, samples) {
  await client.query("DELETE FROM samples WHERE day_id = $1", [dayId]);
  for (const s of samples) {
    await client.query(
      "INSERT INTO samples (day_id, metric, start_at, end_at, value_num, value_secondary, value_text, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [dayId, s.metric, s.start_at, s.end_at, s.value_num, s.value_secondary, s.value_text, s.source]
    );
  }
}

async function replaceExercises(client, dayId, exercises) {
  await client.query("DELETE FROM exercises WHERE day_id = $1", [dayId]);
  for (const e of exercises) {
    await client.query(
      "INSERT INTO exercises (day_id, name, start_at, duration_minutes, source) VALUES ($1,$2,$3,$4,$5)",
      [dayId, e.name, e.start_at, e.duration_minutes, e.source]
    );
  }
}

export function persist(userId, mapped) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO syncs (user_id, source, app_version, device, exported_at, range_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [userId, mapped.sync.source, mapped.sync.app_version, mapped.sync.device, mapped.sync.exported_at, mapped.sync.range_days]
    );
    const syncId = rows[0].id;
    let samples = 0, exercises = 0;
    for (const day of mapped.days) {
      const dayId = await upsertDay(client, syncId, userId, day);
      await replaceAggregates(client, dayId, day.aggregates);
      await replaceSamples(client, dayId, day.samples);
      await replaceExercises(client, dayId, day.exercises);
      samples += day.samples.length;
      exercises += day.exercises.length;
    }
    return { days: mapped.days.length, samples, exercises };
  });
}

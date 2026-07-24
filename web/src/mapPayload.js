// Maps the payload day.activity/body/vitals/sleep/cycle/nutrition objects
// onto flat health_days columns.
const SCALAR_MAP = {
  activity: { steps: "steps", activeCalories: "active_calories", totalCalories: "total_calories", distance: "distance", floorsClimbed: "floors_climbed", elevationGained: "elevation_gained", power: "power", speed: "speed", wheelchairPushes: "wheelchair_pushes", vo2Max: "vo2_max" },
  body: { weight: "weight", bodyFat: "body_fat", boneMass: "bone_mass", height: "height", leanBodyMass: "lean_body_mass" },
  vitals: { restingHeartRate: "resting_heart_rate", bodyTemperature: "body_temperature" },
  nutrition: { hydrationMl: "hydration_ml", energyKcal: "energy_kcal" },
};

// vitals sub-objects that are MinMaxAvg aggregates
const AGG_METRICS = ["heartRate", "hrv", "spo2", "bloodGlucose", "respiratoryRate"];

// sample metric keys the receiver understands
const KNOWN_SAMPLE_METRICS = new Set([
  "steps", "distance", "activeCalories", "totalCalories", "floorsClimbed", "elevationGained",
  "power", "speed", "wheelchairPushes", "hydration", "nutrition",
  "weight", "bodyFat", "boneMass", "height", "leanBodyMass", "vo2Max",
  "heartRate", "hrv", "spo2", "bloodGlucose", "respiratoryRate", "restingHeartRate", "bodyTemperature",
  "bloodPressure", "sleepStage",
  "menstruation", "cervicalMucus", "ovulationTest", "sexualActivity",
]);

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

function mapScalars(day) {
  const out = {};
  for (const [section, cols] of Object.entries(SCALAR_MAP)) {
    const obj = day[section];
    if (!obj) continue;
    for (const [key, col] of Object.entries(cols)) {
      if (obj[key] !== undefined && obj[key] !== null) out[col] = obj[key];
    }
  }
  const sleep = day.sleep;
  if (sleep) {
    if (sleep.durationMinutes != null) out.sleep_duration_minutes = sleep.durationMinutes;
    const st = sleep.stages || {};
    if (st.deep != null) out.sleep_deep = st.deep;
    if (st.light != null) out.sleep_light = st.light;
    if (st.rem != null) out.sleep_rem = st.rem;
    if (st.awake != null) out.sleep_awake = st.awake;
  }
  const cycle = day.cycle;
  if (cycle) {
    for (const [key, col] of Object.entries({ menstruation: "menstruation", cervicalMucus: "cervical_mucus", ovulationTest: "ovulation_test", sexualActivity: "sexual_activity" })) {
      if (cycle[key] != null) out[col] = cycle[key];
    }
  }
  return out;
}

function mapAggregates(day) {
  const vitals = day.vitals || {};
  const out = [];
  for (const metric of AGG_METRICS) {
    const a = vitals[metric];
    if (a && typeof a === "object") out.push({ metric, min: num(a.min), max: num(a.max), avg: num(a.avg) });
  }
  const bp = vitals.bloodPressure;
  if (bp && typeof bp === "object") {
    if (bp.systolic) out.push({ metric: "bpSystolic", min: num(bp.systolic.min), max: num(bp.systolic.max), avg: num(bp.systolic.avg) });
    if (bp.diastolic) out.push({ metric: "bpDiastolic", min: num(bp.diastolic.min), max: num(bp.diastolic.max), avg: num(bp.diastolic.avg) });
  }
  return out;
}

function mapSamples(day) {
  const raw = Array.isArray(day.samples) ? day.samples : [];
  const samples = [];
  let skipped = 0;
  for (const r of raw) {
    if (!KNOWN_SAMPLE_METRICS.has(r.metric)) { skipped++; continue; }
    samples.push({
      metric: r.metric,
      start_at: r.start,
      end_at: r.end ?? null,
      value_num: r.value ?? null,
      value_secondary: r.value2 ?? null,
      value_text: r.text ?? null,
      source: r.source ?? null,
      hc_id: r.hcId ?? null,
      meta: r.meta ?? null,
    });
  }
  return { samples, skipped };
}

function mapExercises(day) {
  return (Array.isArray(day.exercises) ? day.exercises : []).map((e) => ({
    name: e.name ?? null,
    start_at: e.start ?? null,
    duration_minutes: e.durationMinutes ?? null,
    source: e.source ?? null,
    hc_id: e.hcId ?? null,
  }));
}

export function mapPayload(body) {
  const sync = {
    source: body.source ?? null,
    app_version: body.appVersion ?? null,
    device: body.device ?? null,
    exported_at: body.exportedAt ?? null,
    range_days: body.rangeDays ?? null,
  };
  let skipped = 0;
  const days = (Array.isArray(body.days) ? body.days : []).map((day) => {
    const s = mapSamples(day);
    skipped += s.skipped;
    return {
      day: day.date,
      scalars: mapScalars(day),
      aggregates: mapAggregates(day),
      samples: s.samples,
      exercises: mapExercises(day),
    };
  });
  return { sync, days, skipped };
}

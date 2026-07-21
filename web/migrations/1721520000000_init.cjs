exports.up = (pgm) => {
  pgm.createTable("syncs", {
    id: "bigserial",
    source: { type: "text" },
    app_version: { type: "text" },
    device: { type: "text" },
    exported_at: { type: "timestamptz" },
    range_days: { type: "integer" },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("syncs", "syncs_pkey", { primaryKey: "id" });

  pgm.createTable("health_days", {
    id: "bigserial",
    sync_id: { type: "bigint", references: "syncs", onDelete: "SET NULL" },
    day: { type: "date", notNull: true, unique: true },
    steps: { type: "integer" },
    active_calories: { type: "double precision" },
    total_calories: { type: "double precision" },
    distance: { type: "double precision" },
    floors_climbed: { type: "double precision" },
    elevation_gained: { type: "double precision" },
    power: { type: "double precision" },
    speed: { type: "double precision" },
    wheelchair_pushes: { type: "double precision" },
    vo2_max: { type: "double precision" },
    weight: { type: "double precision" },
    body_fat: { type: "double precision" },
    bone_mass: { type: "double precision" },
    height: { type: "double precision" },
    lean_body_mass: { type: "double precision" },
    resting_heart_rate: { type: "double precision" },
    body_temperature: { type: "double precision" },
    sleep_duration_minutes: { type: "integer" },
    sleep_deep: { type: "integer" },
    sleep_light: { type: "integer" },
    sleep_rem: { type: "integer" },
    sleep_awake: { type: "integer" },
    menstruation: { type: "text" },
    cervical_mucus: { type: "text" },
    ovulation_test: { type: "text" },
    sexual_activity: { type: "text" },
    hydration_ml: { type: "double precision" },
    energy_kcal: { type: "double precision" },
  });
  pgm.addConstraint("health_days", "health_days_pkey", { primaryKey: "id" });

  pgm.createTable("day_aggregates", {
    id: "bigserial",
    day_id: { type: "bigint", notNull: true, references: "health_days", onDelete: "CASCADE" },
    metric: { type: "text", notNull: true },
    min: { type: "double precision" },
    max: { type: "double precision" },
    avg: { type: "double precision" },
  });
  pgm.addConstraint("day_aggregates", "day_aggregates_pkey", { primaryKey: "id" });
  pgm.addConstraint("day_aggregates", "day_aggregates_unique", { unique: ["day_id", "metric"] });

  pgm.createTable("samples", {
    id: "bigserial",
    day_id: { type: "bigint", notNull: true, references: "health_days", onDelete: "CASCADE" },
    metric: { type: "text", notNull: true },
    start_at: { type: "timestamptz", notNull: true },
    end_at: { type: "timestamptz" },
    value_num: { type: "double precision" },
    value_secondary: { type: "double precision" },
    value_text: { type: "text" },
  });
  pgm.addConstraint("samples", "samples_pkey", { primaryKey: "id" });
  pgm.createIndex("samples", ["metric", "start_at"]);
  pgm.createIndex("samples", "day_id");

  pgm.createTable("exercises", {
    id: "bigserial",
    day_id: { type: "bigint", notNull: true, references: "health_days", onDelete: "CASCADE" },
    name: { type: "text" },
    start_at: { type: "timestamptz" },
    duration_minutes: { type: "integer" },
  });
  pgm.addConstraint("exercises", "exercises_pkey", { primaryKey: "id" });
};

exports.down = (pgm) => {
  pgm.dropTable("exercises");
  pgm.dropTable("samples");
  pgm.dropTable("day_aggregates");
  pgm.dropTable("health_days");
  pgm.dropTable("syncs");
};

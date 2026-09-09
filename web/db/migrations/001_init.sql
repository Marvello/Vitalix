-- 001_init: core sync + health tables (was 1721520000000_init.cjs)
CREATE TABLE syncs (
  id           bigserial,
  source       text,
  app_version  text,
  device       text,
  exported_at  timestamptz,
  range_days   integer,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT syncs_pkey PRIMARY KEY (id)
);

CREATE TABLE health_days (
  id                     bigserial,
  sync_id                bigint REFERENCES syncs ON DELETE SET NULL,
  day                    date NOT NULL UNIQUE,
  steps                  integer,
  active_calories        double precision,
  total_calories         double precision,
  distance               double precision,
  floors_climbed         double precision,
  elevation_gained       double precision,
  power                  double precision,
  speed                  double precision,
  wheelchair_pushes      double precision,
  vo2_max                double precision,
  weight                 double precision,
  body_fat               double precision,
  bone_mass              double precision,
  height                 double precision,
  lean_body_mass         double precision,
  resting_heart_rate     double precision,
  body_temperature       double precision,
  sleep_duration_minutes integer,
  sleep_deep             integer,
  sleep_light            integer,
  sleep_rem              integer,
  sleep_awake            integer,
  menstruation           text,
  cervical_mucus         text,
  ovulation_test         text,
  sexual_activity        text,
  hydration_ml           double precision,
  energy_kcal            double precision,
  CONSTRAINT health_days_pkey PRIMARY KEY (id)
);

CREATE TABLE day_aggregates (
  id     bigserial,
  day_id bigint NOT NULL REFERENCES health_days ON DELETE CASCADE,
  metric text NOT NULL,
  min    double precision,
  max    double precision,
  avg    double precision,
  CONSTRAINT day_aggregates_pkey PRIMARY KEY (id),
  CONSTRAINT day_aggregates_unique UNIQUE (day_id, metric)
);

CREATE TABLE samples (
  id              bigserial,
  day_id          bigint NOT NULL REFERENCES health_days ON DELETE CASCADE,
  metric          text NOT NULL,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz,
  value_num       double precision,
  value_secondary double precision,
  value_text      text,
  CONSTRAINT samples_pkey PRIMARY KEY (id)
);
CREATE INDEX samples_metric_start_at_index ON samples (metric, start_at);
CREATE INDEX samples_day_id_index ON samples (day_id);

CREATE TABLE exercises (
  id               bigserial,
  day_id           bigint NOT NULL REFERENCES health_days ON DELETE CASCADE,
  name             text,
  start_at         timestamptz,
  duration_minutes integer,
  CONSTRAINT exercises_pkey PRIMARY KEY (id)
);

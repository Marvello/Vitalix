-- 004_records: raw per-reading store keyed on HC uid (was 1721800000000_records.cjs)
CREATE TABLE records (
  id              bigserial,
  user_id         bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  type            text NOT NULL,
  hc_id           text NOT NULL,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz,
  value_num       double precision,
  value_secondary double precision,
  value_text      text,
  source          text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT records_pkey PRIMARY KEY (id),
  CONSTRAINT records_identity UNIQUE (user_id, hc_id, start_at)
);
CREATE INDEX records_user_id_type_start_at_index ON records (user_id, type, start_at);

ALTER TABLE exercises ADD COLUMN hc_id text;
ALTER TABLE exercises ADD CONSTRAINT exercises_identity UNIQUE (day_id, hc_id);

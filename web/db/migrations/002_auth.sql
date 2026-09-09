-- 002_auth: users + token tables, per-user health data (was 1721600000000_auth.cjs)
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            bigserial,
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE TABLE refresh_tokens (
  id         bigserial,
  user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id)
);
CREATE INDEX refresh_tokens_token_hash_index ON refresh_tokens (token_hash);

CREATE TABLE password_resets (
  id         bigserial,
  user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  CONSTRAINT password_resets_pkey PRIMARY KEY (id)
);
CREATE INDEX password_resets_token_hash_index ON password_resets (token_hash);

CREATE TABLE invites (
  id         bigserial,
  token_hash text NOT NULL,
  email      citext NOT NULL,
  role       text NOT NULL DEFAULT 'user',
  created_by bigint REFERENCES users ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invites_pkey PRIMARY KEY (id)
);
CREATE INDEX invites_token_hash_index ON invites (token_hash);

-- Per-user health data. Existing throwaway rows predate users -> clear them.
DELETE FROM day_aggregates; DELETE FROM samples; DELETE FROM exercises; DELETE FROM health_days; DELETE FROM syncs;

ALTER TABLE syncs       ADD COLUMN user_id bigint NOT NULL REFERENCES users ON DELETE CASCADE;
ALTER TABLE health_days ADD COLUMN user_id bigint NOT NULL REFERENCES users ON DELETE CASCADE;
ALTER TABLE health_days DROP CONSTRAINT IF EXISTS health_days_day_key;
ALTER TABLE health_days ADD CONSTRAINT health_days_user_day_key UNIQUE (user_id, day);

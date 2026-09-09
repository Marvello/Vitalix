-- 012_fcm_tokens (was 1722600000000_fcm_tokens.cjs)
CREATE TABLE fcm_tokens (
  id         serial PRIMARY KEY NOT NULL,
  user_id    integer NOT NULL REFERENCES users ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  app_id     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fcm_tokens_user_id_index ON fcm_tokens (user_id);

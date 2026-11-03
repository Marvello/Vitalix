-- 020_ai_digests: weekly (previous Mon-Sun) and monthly (previous calendar month) AI digests.
-- UNIQUE (user_id, kind, period_start) is the dedup: one digest, one push per period.
CREATE TABLE ai_digests (
  id                bigserial PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('week', 'month')),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  text              text NOT NULL,
  metrics_snapshot  jsonb,
  provider          text,
  model             text,
  prompt_tokens     integer,
  completion_tokens integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_digests_user_kind_start_key UNIQUE (user_id, kind, period_start)
);

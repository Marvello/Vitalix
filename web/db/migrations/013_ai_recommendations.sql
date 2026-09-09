-- 013_ai_recommendations (was 1722700000000_ai_recommendations.cjs)
CREATE TABLE ai_recommendations (
  id                  bigserial PRIMARY KEY,
  user_id             bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  day                 date NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  recommendation_text text NOT NULL,
  metrics_snapshot    jsonb NOT NULL,
  prompt_tokens       integer,
  completion_tokens   integer,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_recommendations_user_day_key UNIQUE (user_id, day)
);

ALTER TABLE users ADD COLUMN ai_config jsonb DEFAULT '{"enabled":false,"provider":"openai-compatible","baseUrl":"http://localhost:11434/v1","apiKey":"","model":"llama3:latest","anonymize":true}';

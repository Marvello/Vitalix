-- users.ai_config (013) was meant for per-user AI settings but nothing ever read
-- it; AI is configured server-wide via AI_* env vars.
ALTER TABLE users DROP COLUMN IF EXISTS ai_config;

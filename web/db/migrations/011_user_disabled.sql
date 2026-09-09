-- 011_user_disabled (was 1722500000000_user_disabled.cjs)
ALTER TABLE users ADD COLUMN disabled_at timestamptz;

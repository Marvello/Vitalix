-- 006_reading_meta: per-reading context enums on granular stores (was 1722000000000_reading_meta.cjs)
ALTER TABLE samples ADD COLUMN meta jsonb;
ALTER TABLE records ADD COLUMN meta jsonb;

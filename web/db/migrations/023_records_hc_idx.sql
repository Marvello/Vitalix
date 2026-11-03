-- 023_records_hc_idx: deletions from Health Connect arrive as hc_id only (no start_at).
CREATE INDEX records_user_hc_idx ON records (user_id, hc_id);

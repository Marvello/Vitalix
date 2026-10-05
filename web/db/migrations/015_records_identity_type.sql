-- One NutritionRecord fans out into `nutrition` + one `nutrition.<field>` row per
-- nutrient, all sharing the record's hc_id and start_at. The old identity
-- (user_id, hc_id, start_at) collapsed them into one row (last nutrient wins).
-- Adding `type` keeps them apart; leading with (user_id, type, start_at) lets the
-- same index serve the range query, so the old secondary index goes.
CREATE UNIQUE INDEX records_identity_v2 ON records (user_id, type, start_at, hc_id);
ALTER TABLE records DROP CONSTRAINT records_identity,
  ADD CONSTRAINT records_identity UNIQUE USING INDEX records_identity_v2;
DROP INDEX records_user_id_type_start_at_index;

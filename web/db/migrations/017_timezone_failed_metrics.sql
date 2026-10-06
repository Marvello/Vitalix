-- The app now reports its zone and which metrics Health Connect failed to return,
-- so insights run only for days that have ended locally and can say when a day's
-- data is incomplete.
ALTER TABLE users ADD COLUMN timezone text;
ALTER TABLE syncs ADD COLUMN failed_metrics text[];

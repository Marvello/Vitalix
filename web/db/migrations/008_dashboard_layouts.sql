-- 008_dashboard_layouts (was 1722200000000_dashboard_layouts.cjs)
CREATE TABLE dashboard_layouts (
  user_id integer PRIMARY KEY NOT NULL REFERENCES users ON DELETE CASCADE,
  cards   jsonb NOT NULL DEFAULT '[]'
);

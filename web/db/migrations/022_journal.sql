-- 022_journal: user-entered context (mood, symptoms, meds, caffeine, alcohol, notes).
-- day is the user's local day of logged_at, derived server-side.
CREATE TABLE journal_entries (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mood','symptom','medication','caffeine','alcohol','note')),
  value_num double precision,
  value_text text CHECK (length(value_text) <= 200),
  logged_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_user_day ON journal_entries (user_id, day);

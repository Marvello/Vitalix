import { query } from "../db.js";
import { config } from "../config.js";
import { generateCompletion } from "./llmClient.js";

export const SYSTEM_PROMPT = [
  "You write a short daily health note for one person, from their own wearable data.",
  "",
  "Rules:",
  "- Use only the numbers given. Never invent or estimate a metric.",
  '- "Calories burned" is energy expenditure, never food intake. Do not comment on diet or eating.',
  '- A value marked (not recorded) is a data gap, not behaviour. If the data is marked INCOMPLETE,',
  "  keep conclusions tentative and do not treat lower totals as a real drop.",
  "- No diagnosis. If a value is clearly outside normal adult ranges (e.g. resting heart rate",
  "  above 100 bpm, under 3 h of sleep), say it is worth discussing with a doctor.",
  "- Be neutral about weight. No praise or blame.",
  '- The day is over: write in the past tense and never call it "today".',
  "",
  "Output format, exactly:",
  '- 2 to 4 lines, each starting with "- " then a short lead, a colon, and one sentence.',
  "- First line: the most notable change against the 7-day average. Then concrete next steps.",
  "- Plain text only: no headings, bold, numbering, emoji, exclamation marks, or sign-off.",
  "- Under 120 words.",
].join("\n");

const int = (v) => Math.round(v).toLocaleString("en-US");
const hm = (min) => {
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

// Metrics the note is built from, in prompt order. `fmt` renders the day's value
// and the 7-day average with units, so the model never guesses what a number is.
const FIELDS = [
  { key: "steps", label: "Steps", fmt: int },
  { key: "distance", label: "Distance", fmt: (m) => `${(m / 1000).toFixed(1)} km` },
  { key: "active_calories", label: "Active calories burned", fmt: (v) => `${int(v)} kcal` },
  { key: "total_calories", label: "Total calories burned", fmt: (v) => `${int(v)} kcal` },
  { key: "floors_climbed", label: "Floors climbed", fmt: int },
  { key: "sleep_duration_minutes", label: "Sleep", fmt: hm },
  { key: "resting_heart_rate", label: "Resting heart rate", fmt: (v) => `${int(v)} bpm` },
  { key: "weight", label: "Weight", fmt: (v) => `${v.toFixed(1)} kg` },
  { key: "hydration_ml", label: "Water intake", fmt: (v) => `${(v / 1000).toFixed(1)} L` },
];
const STAGES = [["sleep_deep", "deep"], ["sleep_light", "light"], ["sleep_rem", "REM"], ["sleep_awake", "awake"]];

// 0 is how a missing reading arrives (no session that day, phone off), never a
// real value for any of these metrics.
const num = (v) => (typeof v === "number" && v > 0 ? v : null);

/** Sleep total, falling back to the stage sum for rows written before the app fix. */
function sleepMinutes(row) {
  const stages = STAGES.reduce((sum, [k]) => sum + (num(row[k]) ?? 0), 0);
  return num(row.sleep_duration_minutes) ?? (stages > 0 ? stages : null);
}
const valueOf = (row, key) => (key === "sleep_duration_minutes" ? sleepMinutes(row) : num(row[key]));

/** "SleepSessionRecord" → "sleep session" */
const metricName = (cls) =>
  cls.replace(/Record$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/**
 * Fixed note for a day whose data is known to be incomplete, prepended to the
 * model's text so it is always shown. Null when the data looks complete.
 * `coverage`: { partial, syncedThrough: "HH:MM", failedMetrics: [] } from the day's last sync.
 */
export function coverageNote(coverage) {
  if (!coverage) return null;
  const parts = [];
  if (coverage.partial) parts.push(`last synced at ${coverage.syncedThrough}, so the rest of the day is missing`);
  if (coverage.failedMetrics?.length) {
    parts.push(`Health Connect didn't return ${coverage.failedMetrics.map(metricName).join(", ")}`);
  }
  if (!parts.length) return null;
  return `- Data note: this day's data is incomplete (${parts.join("; ")}). Treat these suggestions as tentative.`;
}

/**
 * Pure: the day's row, the prior 7 days' rows, the day's workouts and the
 * coverage of its last sync → prompts. `hasData` false means there is nothing
 * worth sending to the model.
 */
export function buildPrompts({ day, dayData = {}, pastDays = [], workouts = [], coverage = null }) {
  const note = coverageNote(coverage);
  const lines = [`Day: ${day} (${note ? "INCOMPLETE data" : "complete"})`];
  let hasData = false;

  for (const f of FIELDS) {
    const value = valueOf(dayData, f.key);
    const past = pastDays.map((r) => valueOf(r, f.key)).filter((v) => v != null);
    if (value == null && !past.length) continue;
    hasData ||= value != null;

    let line = `${f.label}: ${value == null ? "(not recorded)" : f.fmt(value)}`;
    if (past.length) {
      const avg = past.reduce((a, b) => a + b, 0) / past.length;
      const pct = value != null && avg > 0 ? Math.round(((value - avg) / avg) * 100) : null;
      line += ` (7-day avg ${f.fmt(avg)} over ${past.length} day${past.length === 1 ? "" : "s"}`;
      line += pct == null ? ")" : `, ${pct >= 0 ? "+" : ""}${pct}%)`;
    }
    if (f.key === "sleep_duration_minutes" && value != null) {
      // Stages covering well under the night are a partial read (or rows from
      // before the app's sleep fix): the model would take "REM 6 min" as fact.
      const staged = STAGES.reduce((sum, [k]) => sum + (num(dayData[k]) ?? 0), 0);
      const stages = STAGES.filter(([k]) => num(dayData[k]) != null).map(([k, name]) => `${name} ${hm(dayData[k])}`);
      if (stages.length && staged >= value * 0.8) line += ` — ${stages.join(", ")}`;
    }
    lines.push(line);
  }

  if (workouts.length) {
    hasData = true;
    lines.push(`Workouts: ${workouts.map((w) => `${w.name ?? "Workout"} ${hm(w.duration_minutes ?? 0)}`).join(", ")}`);
  }
  if (coverage?.failedMetrics?.length) {
    lines.push(`Not returned by Health Connect: ${coverage.failedMetrics.map(metricName).join(", ")}`);
  }

  return { system: SYSTEM_PROMPT, user: lines.join("\n"), hasData, note };
}

/** Strips what the renderers can't show (headings, rules, bold, emoji) if the model ignores the format. */
export function cleanOutput(text) {
  return text
    .replace(/^\s*#+\s*/gm, "")
    .replace(/^\s*(-{3,}|\*{3,})\s*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's date (YYYY-MM-DD) in the user's zone; UTC when unknown or invalid. */
export function todayIn(tz, now = new Date()) {
  const zone = tz && validTimeZone(tz) ? tz : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
}

export const shiftDay = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export async function userTimeZone(userId) {
  const { rows } = await query("SELECT timezone FROM users WHERE id = $1", [userId]);
  const tz = rows[0]?.timezone;
  return tz && validTimeZone(tz) ? tz : "UTC";
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Generates (or regenerates) a user's AI recommendation for `day` and upserts it
 * into ai_recommendations. Shared by the on-demand route and the daily worker.
 * Throws with `code`: AI_UNCONFIGURED, DAY_INCOMPLETE (day hasn't ended in the
 * user's zone), NO_DATA (nothing recorded) — or a plain error if the LLM fails.
 */
export async function generateRecommendation(userId, day) {
  const aiConfig = config.ai;
  if (!aiConfig.baseUrl) throw fail("AI_UNCONFIGURED", "AI service not configured");

  const tz = await userTimeZone(userId);
  if (day >= todayIn(tz)) throw fail("DAY_INCOMPLETE", "Insights are generated for completed days only");

  const [{ rows: dayRows }, { rows: pastDays }, { rows: workouts }, { rows: cov }] = await Promise.all([
    query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [userId, day]),
    query("SELECT * FROM health_days WHERE user_id = $1 AND day >= $2 AND day < $3", [userId, shiftDay(day, -7), day]),
    query(
      `SELECT e.name, e.duration_minutes FROM exercises e JOIN health_days h ON h.id = e.day_id
       WHERE h.user_id = $1 AND h.day = $2 ORDER BY e.start_at`,
      [userId, day],
    ),
    // The day's last writer is the sync that read the most of it: if that read
    // happened before the day ended (in the user's zone), the rest is missing.
    query(
      `SELECT s.exported_at < ((h.day + 1)::timestamp AT TIME ZONE $3) AS partial,
              to_char(s.exported_at AT TIME ZONE $3, 'HH24:MI') AS synced_through,
              s.failed_metrics
       FROM health_days h JOIN syncs s ON s.id = h.sync_id
       WHERE h.user_id = $1 AND h.day = $2`,
      [userId, day, tz],
    ),
  ]);

  const coverage = cov[0]
    ? { partial: !!cov[0].partial, syncedThrough: cov[0].synced_through, failedMetrics: cov[0].failed_metrics ?? [] }
    : null;
  const dayData = dayRows[0] || {};
  const { system, user, hasData, note } = buildPrompts({ day, dayData, pastDays, workouts, coverage });
  if (!hasData) throw fail("NO_DATA", "No health data recorded for this day");

  const result = await generateCompletion(aiConfig, system, user);
  const body = cleanOutput(result.text || "");
  if (!body) throw new Error("LLM provider error: empty response");
  const text = note ? `${note}\n${body}` : body;

  await query(
    `INSERT INTO ai_recommendations (user_id, day, provider, model, recommendation_text, metrics_snapshot, prompt_tokens, completion_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, day) DO UPDATE SET
       recommendation_text = EXCLUDED.recommendation_text,
       metrics_snapshot = EXCLUDED.metrics_snapshot,
       prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens,
       created_at = NOW()`,
    [userId, day, aiConfig.provider, aiConfig.model, text,
      JSON.stringify({ prompt: user, coverage }), result.promptTokens, result.completionTokens],
  );

  return { text };
}

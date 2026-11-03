import { query } from "../db.js";
import { config } from "../config.js";
import { generateCompletion } from "./llmClient.js";
import { cleanOutput, shiftDay, SHARED_RULES } from "./recommendations.js";
import { BASELINE_DAYS, dailySeries } from "../baseline.js";
import { readinessSeries } from "../readiness.js";

export const DIGEST_KINDS = ["week", "month"];

const dow = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
// String/UTC math only: `localToday` is already the user's calendar date.
const firstOfPrevMonth = (day) => {
  const [y, m] = day.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
};

/** Previous full period before `localToday`: week = last Mon-Sun, month = last calendar month. */
export function periodFor(kind, localToday) {
  if (kind === "week") {
    const monday = shiftDay(localToday, -((dow(localToday) + 6) % 7));
    return { start: shiftDay(monday, -7), end: shiftDay(monday, -1) };
  }
  return { start: firstOfPrevMonth(localToday), end: shiftDay(`${localToday.slice(0, 8)}01`, -1) };
}

/** Week digests are due on Monday, month digests on the 1st (user's local date). */
export const isDue = (kind, localToday) => (kind === "week" ? dow(localToday) === 1 : localToday.endsWith("-01"));

/** The same-length period immediately before the one starting at `start`. */
export function previousPeriod(kind, start) {
  const end = shiftDay(start, -1);
  return { start: kind === "week" ? shiftDay(start, -7) : firstOfPrevMonth(start), end };
}

const int = (v) => Math.round(v).toLocaleString("en-US");
const hm = (min) => `${Math.floor(Math.round(min) / 60)}h ${Math.round(min) % 60}m`;
const METRICS = [
  { key: "restingHr", label: "Resting heart rate", fmt: (v) => `${int(v)} bpm` },
  { key: "hrv", label: "HRV", fmt: (v) => `${int(v)} ms` },
  { key: "sleepMin", label: "Sleep", fmt: hm },
  { key: "steps", label: "Steps", fmt: int },
  { key: "activeKcal", label: "Active calories burned", fmt: (v) => `${int(v)} kcal` },
  { key: "readiness", label: "Readiness", fmt: (v) => `${int(v)}/100` },
];

const values = (rows, key) => rows.map((r) => r[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
const avg = (v) => v.reduce((a, b) => a + b, 0) / v.length;

export const DIGEST_SYSTEM_PROMPT = [
  "You write a short health digest for one person, from their own wearable data.",
  "",
  "Rules:",
  SHARED_RULES.numbers,
  SHARED_RULES.calories,
  "- A day not recorded is a data gap, not behaviour. Weigh averages by the days recorded.",
  ...SHARED_RULES.diagnosis,
  SHARED_RULES.weight,
  "- The period is over: write in the past tense.",
  "",
  "Output format, exactly:",
  '- 3 to 5 lines, each starting with "- " then a short lead, a colon, and one sentence.',
  "- First line: the most notable change against the previous period. Then concrete next steps.",
  "- Plain text only: no headings, bold, numbering, emoji, exclamation marks, or sign-off.",
  "- Under 150 words.",
].join("\n");

/**
 * Pure. `days` / `prevDays`: dailySeries rows (optionally with a `readiness` number)
 * for the period and the same-length period before it; `workouts`: [{duration_minutes}].
 * `start`/`end` give the period length (defaults: 7 days / 30 days). `journal` is reserved.
 */
export function buildDigestPrompts({ kind, days = [], prevDays = [], workouts = [], start, end }) {
  const length = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1 : kind === "week" ? 7 : 30;
  const lines = [`Period: ${start ?? "?"} to ${end ?? "?"} (${kind === "week" ? "one week" : "one month"}, ${length} days)`];
  let hasData = false;

  for (const m of METRICS) {
    const cur = values(days, m.key);
    if (!cur.length) continue;
    hasData = true;
    const prev = values(prevDays, m.key);
    let line = `${m.label}: avg ${m.fmt(avg(cur))}`;
    if (prev.length) {
      const prevAvg = avg(prev);
      line += `, previous period avg ${m.fmt(prevAvg)}`;
      if (prevAvg > 0) {
        const pct = Math.round(((avg(cur) - prevAvg) / prevAvg) * 100);
        line += ` (${pct >= 0 ? "+" : ""}${pct}%)`;
      }
    }
    lines.push(`${line}; ${cur.length} of ${length} days recorded`);
  }

  const scored = days.filter((d) => typeof d.readiness === "number");
  if (scored.length) {
    const best = scored.reduce((a, b) => (b.readiness > a.readiness ? b : a));
    const worst = scored.reduce((a, b) => (b.readiness < a.readiness ? b : a));
    lines.push(`Best day by readiness: ${best.day} (${best.readiness}); worst: ${worst.day} (${worst.readiness})`);
  }
  if (workouts.length) {
    hasData = true;
    const minutes = workouts.reduce((s, w) => s + (w.duration_minutes ?? 0), 0);
    lines.push(`Workouts: ${workouts.length}, ${hm(minutes)} in total`);
  }

  return { system: DIGEST_SYSTEM_PROMPT, user: lines.join("\n"), hasData };
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Generates and stores the digest for [start, end]. Throws with `code`
 * AI_UNCONFIGURED or NO_DATA, or a plain error if the LLM fails.
 */
export async function generateDigest(userId, kind, start, end) {
  const aiConfig = config.ai;
  if (!aiConfig.baseUrl) throw fail("AI_UNCONFIGURED", "AI service not configured");

  const prev = previousPeriod(kind, start);
  // readiness for the earliest day needs its own 28-day history
  const rows = await dailySeries(userId, shiftDay(prev.start, -BASELINE_DAYS), end);
  const score = new Map(readinessSeries(rows, prev.start, end).map((r) => [r.day, r.score]));
  const within = (a, b) => rows.filter((r) => r.day >= a && r.day <= b).map((r) => ({ ...r, readiness: score.get(r.day) ?? null }));
  const { rows: workouts } = await query(
    `SELECT e.duration_minutes FROM exercises e JOIN health_days h ON h.id = e.day_id
     WHERE h.user_id = $1 AND h.day BETWEEN $2 AND $3`,
    [userId, start, end],
  );

  const { system, user, hasData } = buildDigestPrompts({
    kind, start, end, days: within(start, end), prevDays: within(prev.start, prev.end), workouts,
  });
  if (!hasData) throw fail("NO_DATA", "No health data recorded for this period");

  const result = await generateCompletion(aiConfig, system, user);
  const text = cleanOutput(result.text || "");
  if (!text) throw new Error("LLM provider error: empty response");

  await query(
    `INSERT INTO ai_digests (user_id, kind, period_start, period_end, text, metrics_snapshot, provider, model, prompt_tokens, completion_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, kind, period_start) DO NOTHING`,
    [userId, kind, start, end, text, JSON.stringify({ prompt: user }), aiConfig.provider, aiConfig.model,
      result.promptTokens, result.completionTokens],
  );
  return { text };
}

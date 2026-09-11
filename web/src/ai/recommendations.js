import { query } from "../db.js";
import { config } from "../config.js";
import { generateCompletion } from "./llmClient.js";
import { calculateDeltas, calculateBaseline } from "./metricsBuilder.js";

const METRIC_KEYS = ["steps", "active_calories", "resting_heart_rate", "sleep_duration_minutes",
  "distance_meters", "floors_climbed", "total_calories"];

export function toKey(d) {
  return d.toISOString().split("T")[0];
}

export function yesterdayKey(now = new Date()) {
  return toKey(new Date(now.getTime() - 864e5));
}

export function buildPrompts(dayData, deltas, baseline7d, day) {
  const system = [
    "You are a concise health and fitness coach.",
    "Given a user's daily health metrics, day-over-day changes, and 7-day baselines,",
    "provide 2-4 short, actionable recommendations.",
    "Focus on trends, not absolutes. Be encouraging but honest.",
    "Do not give medical advice. Keep total response under 200 words.",
  ].join(" ");

  const lines = [`Date: ${day}`];
  for (const key of METRIC_KEYS) {
    if (dayData[key] == null) continue;
    const label = key.replace(/_/g, " ");
    let line = `${label}: ${dayData[key]}`;
    if (deltas[key] != null) line += ` (${deltas[key] >= 0 ? "+" : ""}${deltas[key]} vs yesterday)`;
    if (baseline7d[key] != null) line += ` [7d avg: ${baseline7d[key]}]`;
    lines.push(line);
  }
  if (lines.length === 1) lines.push("No metric data available for this day.");

  return { system, user: lines.join("\n") };
}

/**
 * Generates (or regenerates) a user's AI recommendation for `day` and upserts it
 * into ai_recommendations. Shared by the on-demand route and the daily worker.
 * Throws if AI is unconfigured or the LLM call fails — caller decides how to
 * surface it (HTTP error vs worker skip).
 */
export async function generateRecommendation(userId, day) {
  const aiConfig = config.ai;
  if (!aiConfig.baseUrl) {
    const e = new Error("AI service not configured");
    e.code = "AI_UNCONFIGURED";
    throw e;
  }

  const yesterdayDate = toKey(new Date(new Date(day).getTime() - 864e5));
  const from7d = toKey(new Date(new Date(day).getTime() - 7 * 864e5));

  const [{ rows: todayRows }, { rows: yesterdayRows }, { rows: past7dRows }] = await Promise.all([
    query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [userId, day]),
    query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [userId, yesterdayDate]),
    query("SELECT * FROM health_days WHERE user_id = $1 AND day >= $2 AND day < $3", [userId, from7d, day]),
  ]);

  const dayData = todayRows[0] || {};
  const deltas = calculateDeltas(dayData, yesterdayRows[0] || {});
  const baseline7d = calculateBaseline(past7dRows);

  const { system, user } = buildPrompts(dayData, deltas, baseline7d, day);
  const result = await generateCompletion(aiConfig, system, user);

  await query(
    `INSERT INTO ai_recommendations (user_id, day, provider, model, recommendation_text, metrics_snapshot, prompt_tokens, completion_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, day) DO UPDATE SET
       recommendation_text = EXCLUDED.recommendation_text,
       metrics_snapshot = EXCLUDED.metrics_snapshot,
       prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens,
       created_at = NOW()`,
    [userId, day, aiConfig.provider, aiConfig.model, result.text,
      JSON.stringify({ dayData, deltas, baseline7d }), result.promptTokens, result.completionTokens],
  );

  return { text: result.text };
}

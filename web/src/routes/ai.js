import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";
import { config } from "../config.js";
import { generateCompletion } from "../ai/llmClient.js";
import { calculateDeltas, calculateBaseline } from "../ai/metricsBuilder.js";

export const aiRouter = Router();

const METRIC_KEYS = ["steps", "active_calories", "resting_heart_rate", "sleep_duration_minutes",
  "distance_meters", "floors_climbed", "total_calories"];

function toKey(d) {
  return d.toISOString().split("T")[0];
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

  if (lines.length === 1) {
    lines.push("No metric data available for this day.");
  }

  return { system, user: lines.join("\n") };
}

aiRouter.post("/api/ai/recommendations/generate", requireAuth, async (req, res) => {
  const day = req.body.day || toKey(new Date());
  const yesterdayDate = toKey(new Date(new Date(day).getTime() - 864e5));
  const from7d = toKey(new Date(new Date(day).getTime() - 7 * 864e5));

  try {
    const [{ rows: todayRows }, { rows: yesterdayRows }, { rows: past7dRows }] = await Promise.all([
      query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, day]),
      query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, yesterdayDate]),
      query("SELECT * FROM health_days WHERE user_id = $1 AND day >= $2 AND day < $3", [req.user.id, from7d, day]),
    ]);

    const dayData = todayRows[0] || {};
    const yesterdayData = yesterdayRows[0] || {};
    const deltas = calculateDeltas(dayData, yesterdayData);
    const baseline7d = calculateBaseline(past7dRows);

    const aiConfig = config.ai;
    if (!aiConfig.baseUrl) {
      return res.status(503).json({ error: "AI service not configured" });
    }

    const { system, user } = buildPrompts(dayData, deltas, baseline7d, day);
    const result = await generateCompletion(aiConfig, system, user);

    const metricsSnapshot = { dayData, deltas, baseline7d };

    await query(
      `INSERT INTO ai_recommendations (user_id, day, provider, model, recommendation_text, metrics_snapshot, prompt_tokens, completion_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, day) DO UPDATE SET
         recommendation_text = EXCLUDED.recommendation_text,
         metrics_snapshot = EXCLUDED.metrics_snapshot,
         prompt_tokens = EXCLUDED.prompt_tokens,
         completion_tokens = EXCLUDED.completion_tokens,
         created_at = NOW()`,
      [req.user.id, day, aiConfig.provider, aiConfig.model, result.text, JSON.stringify(metricsSnapshot),
        result.promptTokens, result.completionTokens],
    );

    res.json({ success: true, text: result.text });
  } catch (err) {
    console.error("AI recommendation generation failed", err);
    let message = "Failed to generate recommendation.";
    const code = err.cause?.code || err.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      message = `Cannot reach AI service at ${config.ai.baseUrl}. Is Ollama or your LLM provider running?`;
    } else if (err.message?.includes("LLM provider error")) {
      message = "AI service returned an error. Check your AI configuration.";
    }
    res.status(500).json({ error: message });
  }
});

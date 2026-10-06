import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";
import { config } from "../config.js";
import { generateRecommendation, todayIn, shiftDay, userTimeZone } from "../ai/recommendations.js";
import { rateLimit } from "../rateLimit.js";

export const aiRouter = Router();

// Each call is a paid/slow LLM completion: cap per user.
const generateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, key: (req) => req.user.id });

aiRouter.post("/api/ai/recommendations/generate", requireAuth, generateLimit, async (req, res) => {
  const day = req.body?.day;
  if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "day must be YYYY-MM-DD" });
  try {
    const target = day ?? shiftDay(todayIn(await userTimeZone(req.user.id)), -1);
    const { text } = await generateRecommendation(req.user.id, target);
    res.json({ success: true, text });
  } catch (err) {
    if (err.code === "AI_UNCONFIGURED") return res.status(503).json({ error: "AI service not configured" });
    if (err.code === "DAY_INCOMPLETE" || err.code === "NO_DATA") return res.status(422).json({ error: err.message });
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

// Latest stored recommendation for the user.
aiRouter.get("/api/ai/recommendations", requireAuth, async (req, res) => {
  const { rows } = await query(
    "SELECT day, recommendation_text, created_at FROM ai_recommendations WHERE user_id = $1 ORDER BY day DESC LIMIT 1",
    [req.user.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: "no recommendation yet" });
  res.json({ day: rows[0].day, text: rows[0].recommendation_text, created_at: rows[0].created_at });
});

// Stored recommendation for a specific day (used by the app's insight screen).
aiRouter.get("/api/ai/recommendations/:day", requireAuth, async (req, res) => {
  const { rows } = await query(
    "SELECT day, recommendation_text, created_at FROM ai_recommendations WHERE user_id = $1 AND day = $2",
    [req.user.id, req.params.day],
  );
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json({ day: rows[0].day, text: rows[0].recommendation_text, created_at: rows[0].created_at });
});

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";
import { config } from "../config.js";
import { generateRecommendation, buildPrompts, toKey } from "../ai/recommendations.js";

export const aiRouter = Router();

// re-exported for existing tests that import buildPrompts from this module
export { buildPrompts };

aiRouter.post("/api/ai/recommendations/generate", requireAuth, async (req, res) => {
  const day = req.body.day || toKey(new Date());
  try {
    const { text } = await generateRecommendation(req.user.id, day);
    res.json({ success: true, text });
  } catch (err) {
    if (err.code === "AI_UNCONFIGURED") return res.status(503).json({ error: "AI service not configured" });
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

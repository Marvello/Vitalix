import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";

export const aiRouter = Router();

aiRouter.get("/api/daily-review", requireAuth, async (req, res) => {
  const day = req.query.day || new Date().toISOString().split("T")[0];
  res.json({ day, metrics: {}, deltas: {}, baseline7d: {} });
});

aiRouter.post("/api/ai/recommendations/generate", requireAuth, async (req, res) => {
  res.json({ success: true, text: "Keep up the good sleep routine!" });
});

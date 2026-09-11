import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";

export const fcmRouter = Router();

// The app registers its FCM token here after login / on app open. Idempotent:
// a token is globally unique, so re-registering just re-points it at the
// current user (handles device hand-off / account switch).
fcmRouter.post("/api/fcm/register", requireAuth, async (req, res) => {
  const { token, app_id } = req.body || {};
  if (!token || !app_id) return res.status(400).json({ error: "token and app_id required" });
  await query(
    `INSERT INTO fcm_tokens (user_id, token, app_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id, app_id = EXCLUDED.app_id, updated_at = now()`,
    [req.user.id, token, app_id],
  );
  res.status(204).end();
});

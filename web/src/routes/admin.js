import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import * as store from "../auth/store.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";

export const adminRouter = Router();

adminRouter.post("/api/admin/invites", requireAuth, requireAdmin, async (req, res) => {
  const { email, role } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const raw = await store.createInvite(email, role === "admin" ? "admin" : "user", req.user.id);
  const link = `${config.appBaseUrl}/signup?token=${raw}`;
  await sendMail(
    email,
    "You're invited to Vitalix",
    `Your Vitalix invite code is:\n\n    ${raw}\n\nEnter it in the app's sign-up screen, or use this link on the web: ${link}\nExpires in 7 days.`
  );
  res.status(201).json({ ok: true });
});

import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import * as store from "../auth/store.js";
import { sendMail } from "../auth/mailer.js";
import { inviteEmail } from "../auth/emailTemplates.js";
import { config } from "../config.js";
import { getInstallUrl } from "../zealot.js";

export const adminRouter = Router();

adminRouter.post("/api/admin/invites", requireAuth, requireAdmin, async (req, res) => {
  const { email, role } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const raw = await store.createInvite(email, role === "admin" ? "admin" : "user", req.user.id);
  const link = `${config.appBaseUrl}/signup?token=${raw}`;
  const downloadUrl = await getInstallUrl();
  await sendMail(email, "You're invited to Vitalix", await inviteEmail({ code: raw, link, downloadUrl }));
  res.status(201).json({ ok: true });
});

adminRouter.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await store.listUsers();
  res.json(users);
});

adminRouter.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  const { role, disabled } = req.body || {};

  if (role !== undefined) {
    if (role !== "admin" && role !== "user") return res.status(400).json({ error: "role must be admin or user" });
    if (targetId === req.user.id && role !== "admin") return res.status(400).json({ error: "Cannot demote yourself" });
    if (role === "user") {
      const count = await store.countAdmins();
      const target = (await store.listUsers()).find((u) => u.id === targetId);
      if (target?.role === "admin" && count <= 1) return res.status(400).json({ error: "Cannot remove last admin" });
    }
    await store.updateUserRole(targetId, role);
  }

  if (disabled !== undefined) {
    if (targetId === req.user.id) return res.status(400).json({ error: "Cannot disable yourself" });
    await store.setUserDisabled(targetId, !!disabled);
    if (disabled) await store.revokeAllRefresh(targetId);
  }

  res.json({ ok: true });
});

adminRouter.get("/api/admin/invites", requireAuth, requireAdmin, async (req, res) => {
  const invites = await store.listInvites();
  const now = new Date();
  const result = invites.map((inv) => ({
    ...inv,
    status: inv.used_at ? "used" : new Date(inv.expires_at) < now ? "expired" : "pending",
  }));
  res.json(result);
});

adminRouter.delete("/api/admin/invites/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const deleted = await store.deleteInvite(id);
  if (!deleted) return res.status(404).json({ error: "Invite not found or already used" });
  res.json({ ok: true });
});

adminRouter.post("/api/admin/invites/:id/resend", requireAuth, requireAdmin, async (req, res) => {
  const invite = await store.findInviteById(Number(req.params.id));
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.used_at) return res.status(400).json({ error: "Invite already used" });
  await store.deleteInvite(invite.id);
  const raw = await store.createInvite(invite.email, invite.role, req.user.id);
  const link = `${config.appBaseUrl}/signup?token=${raw}`;
  const downloadUrl = await getInstallUrl();
  await sendMail(invite.email, "You're invited to Vitalix", await inviteEmail({ code: raw, link, downloadUrl }));
  res.json({ ok: true });
});

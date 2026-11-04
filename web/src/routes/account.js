import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { verify, DUMMY_HASH } from "../auth/passwords.js";
import { clearAuthCookies } from "./auth.js";
import { query, withTransaction } from "../db.js";
import { rateLimit } from "../rateLimit.js";
import { todayIn } from "../ai/recommendations.js";
import { streamExport, healthDaysCsv } from "../exportData.js";

export const accountRouter = Router();

const HOUR = 60 * 60 * 1000;
const byUser = (req) => req.user.id;
const exportLimit = rateLimit({ windowMs: HOUR, max: 3, key: byUser });
const deleteLimit = rateLimit({ windowMs: HOUR, max: 5, key: byUser });

const LAST_ADMIN = "You are the only enabled admin. Promote another admin before deleting this account.";

/**
 * Verifies the password and deletes the user in one transaction. Returns
 * { status: 204 | 403 | 409, error? }. users -> every other table is ON DELETE
 * CASCADE (refresh tokens included), so there is nothing left to revoke afterwards.
 */
async function deleteAccount(userId, password, typedEmail) {
  const { rows } = await query("SELECT email, role, password_hash FROM users WHERE id = $1", [userId]);
  const user = rows[0];
  // Always run one bcrypt comparison, even if the row vanished or has no hash.
  const ok = await verify(typeof password === "string" ? password : "", user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) return { status: 403, error: "Wrong password" };
  if (typedEmail !== undefined && String(typedEmail).trim().toLowerCase() !== user.email.toLowerCase())
    return { status: 400, error: "Typed email does not match your account email." };
  return withTransaction(async (client) => {
    // Lock the enabled admins so two admins deleting themselves concurrently can't both pass.
    const admins = (await client.query("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL FOR UPDATE")).rows;
    if (admins.length === 1 && Number(admins[0].id) === userId) return { status: 409, error: LAST_ADMIN };
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    return { status: 204 };
  });
}

accountRouter.delete("/api/account", requireAuth, deleteLimit, async (req, res) => {
  const r = await deleteAccount(req.user.id, req.body?.password);
  if (r.status !== 204) return res.status(r.status).json({ error: r.error });
  clearAuthCookies(res);
  res.sendStatus(204);
});

accountRouter.get("/account", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT email, role FROM users WHERE id = $1", [req.user.id]);
  res.render("account", { email: rows[0].email, userRole: rows[0].role, error: null });
});

accountRouter.post("/account/delete", requireAuth, deleteLimit, async (req, res) => {
  const { password, email: typed } = req.body || {};
  const r = await deleteAccount(req.user.id, password, typeof typed === "string" ? typed : "");
  if (r.status !== 204) {
    const { rows } = await query("SELECT email, role FROM users WHERE id = $1", [req.user.id]);
    return res.status(r.status).render("account", { email: rows[0].email, userRole: rows[0].role, error: r.error });
  }
  clearAuthCookies(res);
  res.redirect("/login?deleted=1");
});

async function attachment(req, res, ext, type) {
  const day = todayIn(req.user.timezone);
  res.set({ "Content-Type": type, "Content-Disposition": `attachment; filename="vitalix-export-${day}.${ext}"`, "Cache-Control": "no-store" });
}

accountRouter.get("/account/export.json", requireAuth, exportLimit, async (req, res, next) => {
  try {
    await attachment(req, res, "json", "application/json; charset=utf-8");
    const finished = await streamExport(res, req.user.id);
    if (finished) res.end(); else res.destroy();
  } catch (err) {
    // Headers/body may already be on the wire: a truncated file must not look complete.
    if (res.headersSent) { console.error("[export] failed mid-stream:", err.message); return res.destroy(); }
    next(err);
  }
});

accountRouter.get("/account/export-days.csv", requireAuth, exportLimit, async (req, res) => {
  await attachment(req, res, "csv", "text/csv; charset=utf-8");
  res.send(await healthDaysCsv(req.user.id));
});

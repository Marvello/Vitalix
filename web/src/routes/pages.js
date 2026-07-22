import { Router } from "express";
import { hash, verify } from "../auth/passwords.js";
import { signAccess } from "../auth/tokens.js";
import * as store from "../auth/store.js";
import { setAuthCookies } from "./auth.js";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";

export const pagesRouter = Router();
const show = (res, view, extra = {}) => res.render(view, { error: null, ...extra });

pagesRouter.get("/login", (req, res) => show(res, "login"));
pagesRouter.get("/signup", (req, res) => show(res, "signup", { token: req.query.token || "" }));
pagesRouter.get("/forgot", (req, res) => show(res, "forgot", { sent: false }));
pagesRouter.get("/reset", (req, res) => show(res, "reset", { token: req.query.token || "" }));

pagesRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = email ? await store.findUserByEmail(email) : null;
  if (!user || !(await verify(password || "", user.password_hash))) return show(res, "login", { error: "Invalid email or password." });
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});

pagesRouter.post("/signup", async (req, res) => {
  const { token, email, password } = req.body;
  const invite = token ? await store.consumeInvite(token) : null;
  if (!invite || invite.email.toLowerCase() !== String(email || "").toLowerCase()) return show(res, "signup", { token, error: "Invite invalid, expired, or email mismatch." });
  if (await store.findUserByEmail(email)) return show(res, "signup", { token, error: "Account already exists." });
  const user = await store.createUser(email, await hash(password), invite.role);
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});

pagesRouter.post("/forgot", async (req, res) => {
  const user = req.body.email ? await store.findUserByEmail(req.body.email) : null;
  if (user) {
    const raw = await store.createReset(user.id);
    await sendMail(user.email, "Reset your Vitalix password", `${config.appBaseUrl}/reset?token=${raw}`);
  }
  show(res, "forgot", { sent: true });
});

pagesRouter.post("/reset", async (req, res) => {
  const { token, password } = req.body;
  const userId = token ? await store.consumeReset(token) : null;
  if (!userId) return show(res, "reset", { token: "", error: "Reset link invalid or expired." });
  await store.updatePassword(userId, await hash(password));
  await store.revokeAllRefresh(userId);
  res.redirect("/login");
});

pagesRouter.post("/logout", async (req, res) => {
  if (req.cookies?.refresh) await store.revokeRefresh(req.cookies.refresh);
  res.clearCookie("access");
  res.clearCookie("refresh");
  res.redirect("/login");
});

pagesRouter.get("/dashboard", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT day, steps, sleep_duration_minutes FROM health_days WHERE user_id = $1 ORDER BY day DESC LIMIT 30", [req.user.id]);
  res.render("dashboard", { days: rows, email: (await store.findUserById(req.user.id))?.email });
});

pagesRouter.get("/dashboard/:date", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, req.params.date]);
  if (rows.length === 0) return res.status(404).render("day", { day: null, samples: [], aggregates: [], exercises: [], date: req.params.date });
  const d = rows[0];
  const [aggs, samples, ex] = await Promise.all([
    query("SELECT metric,min,max,avg FROM day_aggregates WHERE day_id=$1", [d.id]),
    query("SELECT metric,start_at,end_at,value_num,value_secondary,value_text FROM samples WHERE day_id=$1 ORDER BY start_at LIMIT 500", [d.id]),
    query("SELECT name,start_at,duration_minutes FROM exercises WHERE day_id=$1", [d.id]),
  ]);
  res.render("day", { day: d, aggregates: aggs.rows, samples: samples.rows, exercises: ex.rows, date: req.params.date });
});

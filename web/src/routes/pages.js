import { Router } from "express";
import { hash, verify, DUMMY_HASH } from "../auth/passwords.js";
import { signAccess } from "../auth/tokens.js";
import * as store from "../auth/store.js";
import { setAuthCookies } from "./auth.js";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";
import * as stats from "../stats.js";
import {
  bandSeries, fillDays, metricLabel, rollingAverage, sleepStages, summaryTiles, toKey,
} from "../chartData.js";
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
  const ok = await verify(String(password || ""), user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) return show(res, "login", { error: "Invalid email or password." });
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});

pagesRouter.post("/signup", async (req, res) => {
  const { token, email, password } = req.body;
  if (typeof token !== "string" || typeof email !== "string" || typeof password !== "string" || !token || !email || !password)
    return show(res, "signup", { token: typeof token === "string" ? token : "", error: "All fields are required." });
  const invite = await store.findValidInvite(token);
  if (!invite || invite.email.toLowerCase() !== email.toLowerCase())
    return show(res, "signup", { token, error: "Invite invalid, expired, or email mismatch." });
  if (await store.findUserByEmail(email)) return show(res, "signup", { token, error: "Account already exists." });
  const consumed = await store.consumeInvite(token);
  if (!consumed) return show(res, "signup", { token, error: "Invite invalid or expired." });
  const user = await store.createUser(email, await hash(password), invite.role);
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});

pagesRouter.post("/forgot", async (req, res) => {
  const { email } = req.body;
  const user = typeof email === "string" && email ? await store.findUserByEmail(email) : null;
  if (user) {
    const raw = await store.createReset(user.id);
    await sendMail(user.email, "Reset your Vitalix password", `${config.appBaseUrl}/reset?token=${raw}`);
  }
  show(res, "forgot", { sent: true });
});

pagesRouter.post("/reset", async (req, res) => {
  const { token, password } = req.body;
  if (typeof token !== "string" || typeof password !== "string" || !token || !password)
    return show(res, "reset", { token: typeof token === "string" ? token : "", error: "A new password is required." });
  const userId = await store.consumeReset(token);
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

const RANGES = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

pagesRouter.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const days = RANGES[req.query.range] ? Number(req.query.range) : 30;
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 864e5);
    const fromKey = toKey(from);
    const toKeyStr = toKey(to);

    const [rows, aggs, totals, metrics, recent, user] = await Promise.all([
      stats.dailyRows(req.user.id, fromKey, toKeyStr),
      stats.aggregateRows(req.user.id, fromKey, toKeyStr),
      stats.summary(req.user.id, fromKey, toKeyStr),
      stats.availableMetrics(req.user.id, fromKey, toKeyStr),
      stats.recentDays(req.user.id, 14),
      store.findUserById(req.user.id),
    ]);

    const steps = fillDays(rows, fromKey, toKeyStr, "steps");
    const charts = {
      steps,
      stepsTrend: rollingAverage(steps, 7),
      distance: fillDays(rows, fromKey, toKeyStr, "distance"),
      activeCalories: fillDays(rows, fromKey, toKeyStr, "active_calories"),
      restingHr: fillDays(rows, fromKey, toKeyStr, "resting_heart_rate"),
      sleep: sleepStages(rows, fromKey, toKeyStr),
      bands: stats.BAND_METRICS.filter((m) => metrics.includes(m)).map((metric) => ({
        metric,
        label: metricLabel(metric),
        points: bandSeries(aggs, fromKey, toKeyStr, metric),
      })),
    };

    res.render("dashboard", {
      email: user?.email,
      range: days,
      ranges: RANGES,
      tiles: summaryTiles(totals),
      totals,
      charts,
      recent,
      toKey,
    });
  } catch (err) {
    console.error("GET /dashboard failed", err);
    res.status(500).render("dashboard", {
      email: null, range: 30, ranges: RANGES, tiles: [], totals: {},
      charts: { steps: [], stepsTrend: [], distance: [], activeCalories: [], restingHr: [], sleep: [], bands: [] },
      recent: [], toKey,
    });
  }
});

pagesRouter.get("/dashboard/:date", requireAuth, async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, req.params.date]);
    if (rows.length === 0) return res.status(404).render("day", { day: null, samples: [], aggregates: [], exercises: [], date: req.params.date });
    const d = rows[0];
    const [aggs, samples, ex] = await Promise.all([
      query("SELECT metric,min,max,avg FROM day_aggregates WHERE day_id=$1", [d.id]),
      query("SELECT metric,start_at,end_at,value_num,value_secondary,value_text FROM samples WHERE day_id=$1 ORDER BY start_at LIMIT 500", [d.id]),
      query("SELECT name,start_at,duration_minutes FROM exercises WHERE day_id=$1", [d.id]),
    ]);
    res.render("day", { day: d, aggregates: aggs.rows, samples: samples.rows, exercises: ex.rows, date: req.params.date });
  } catch (err) {
    console.error("GET /dashboard/:date failed", err);
    res.status(500).render("day", { day: null, samples: [], aggregates: [], exercises: [], date: req.params.date });
  }
});

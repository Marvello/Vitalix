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
  splitSeries, visibleMetrics, visibleTiles, assignSourceColors, sourceLines, sourceDisplayName,
} from "../chartData.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";

const buildInfo = { version: config.buildVersion, date: config.buildDate };

export const pagesRouter = Router();
const show = (res, view, extra = {}) => res.render(view, { error: null, ...extra });

pagesRouter.get("/", (_req, res) => res.redirect("/dashboard"));

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

const EMPTY_CHARTS = { series: [], sleep: [], bands: [], hrSplit: [] };

pagesRouter.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const days = RANGES[req.query.range] ? Number(req.query.range) : 30;
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 864e5);
    const fromKey = toKey(from);
    const toKeyStr = toKey(to);

    const [rows, aggs, totals, metrics, cover, workouts, hrRows, recent, user] = await Promise.all([
      stats.dailyRows(req.user.id, fromKey, toKeyStr),
      stats.aggregateRows(req.user.id, fromKey, toKeyStr),
      stats.summary(req.user.id, fromKey, toKeyStr),
      stats.availableMetrics(req.user.id, fromKey, toKeyStr),
      stats.coverage(req.user.id, fromKey, toKeyStr),
      stats.exerciseBreakdown(req.user.id, fromKey, toKeyStr),
      stats.heartRateSplit(req.user.id, fromKey, toKeyStr),
      stats.recentDays(req.user.id, 14),
      store.findUserById(req.user.id),
    ]);

    // Source filter: absent param = "All" (show combined); "none"/empty = nothing;
    // comma list = only those sources.
    const allSources = await stats.availableSources(req.user.id, fromKey, toKeyStr);
    const sourceCounts = await stats.sourceCounts(req.user.id, fromKey, toKeyStr);
    const sourcesParam = req.query.sources;
    const allActive = sourcesParam === undefined;
    const selectedSources = allActive ? []
      : (sourcesParam === "none" || !sourcesParam ? []
        : sourcesParam.split(",").filter((s) => allSources.includes(s)));
    const filterActive = !allActive;
    const sourceColors = assignSourceColors(allSources);
    const sourceNames = Object.fromEntries(allSources.map((s) => [s, sourceDisplayName(s)]));

    const shownDayMetrics = visibleMetrics(stats.DAY_METRICS, cover);
    const bandKeys = stats.BAND_METRICS.filter((m) => metrics.includes(m));
    const srcRows = selectedSources.length
      ? await stats.sourceRows(
          req.user.id, fromKey, toKeyStr,
          [...shownDayMetrics.map((m) => m.sourceKey), ...bandKeys],
          selectedSources,
        )
      : [];

    const nullPoints = (pts) => pts.map((p) => ({ ...p, value: null }));
    const nullBand = (pts) => pts.map((p) => ({ ...p, min: null, max: null, avg: null }));

    const series = shownDayMetrics.map((m) => {
      const points = fillDays(rows, fromKey, toKeyStr, m.column);
      const srcLines = sourceLines(srcRows, fromKey, toKeyStr, m.sourceKey, sourceColors);
      return {
        key: m.column,
        label: m.label,
        unit: m.unit ?? null,
        chart: m.chart,
        days: cover[m.column],
        points: filterActive ? nullPoints(points) : points,
        trend: m.trend && !filterActive ? rollingAverage(points, 7) : null,
        sources: srcLines,
        filtered: filterActive,
      };
    });

    const charts = {
      series,
      sleep: filterActive ? []
        : rows.some((r) => r.sleep_duration_minutes != null)
          ? sleepStages(rows, fromKey, toKeyStr) : [],
      hrSplit: filterActive ? []
        : hrRows.some((r) => r.scope === "active")
          ? splitSeries(hrRows, fromKey, toKeyStr) : [],
      bands: bandKeys.map((metric) => ({
        metric,
        label: metricLabel(metric),
        points: filterActive ? nullBand(bandSeries(aggs, fromKey, toKeyStr, metric))
          : bandSeries(aggs, fromKey, toKeyStr, metric),
        sources: sourceLines(srcRows, fromKey, toKeyStr, metric, sourceColors),
        filtered: filterActive,
      })),
    };

    res.render("dashboard", {
      email: user?.email,
      range: days,
      ranges: RANGES,
      tiles: filterActive ? [] : visibleTiles(summaryTiles(totals)),
      totals: filterActive && !selectedSources.length ? {} : totals,
      charts,
      workouts: filterActive ? [] : workouts,
      recent,
      toKey,
      allActive,
      availableSources: allSources,
      selectedSources,
      sourceColors,
      sourceNames,
      sourceCounts,
      buildInfo,
    });
  } catch (err) {
    console.error("GET /dashboard failed", err);
    res.status(500).render("dashboard", {
      email: null, range: 30, ranges: RANGES, tiles: [], totals: {},
      charts: EMPTY_CHARTS, workouts: [], recent: [], toKey,
      allActive: true, availableSources: [], selectedSources: [], sourceColors: {}, sourceNames: {}, sourceCounts: {},
      buildInfo,
    });
  }
});

// --- Dashboard layout management ---

pagesRouter.put("/dashboard/layout", requireAuth, async (req, res) => {
  try {
    let { cards } = req.body;
    if (!Array.isArray(cards)) return res.status(400).json({ error: "cards must be an array" });
    cards = [...new Set(cards)].filter(stats.isValidCardKey);
    if (cards.length > 25) cards = cards.slice(0, 25);
    await stats.saveLayout(req.user.id, cards);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /dashboard/layout failed", err);
    res.status(500).json({ error: "save failed" });
  }
});

pagesRouter.post("/dashboard/layout/add", requireAuth, async (req, res) => {
  try {
    const { card } = req.body;
    if (!card || !stats.isValidCardKey(card)) {
      return res.status(400).json({ error: "invalid card key" });
    }
    const existing = await stats.getLayout(req.user.id);
    const cards = existing || stats.CARD_CATALOG.map((c) => c.key);
    if (!cards.includes(card)) cards.push(card);
    await stats.saveLayout(req.user.id, cards);
    res.redirect(`/dashboard?range=${req.query.range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/add failed", err);
    res.status(500).json({ error: "add failed" });
  }
});

pagesRouter.delete("/dashboard/layout", requireAuth, async (req, res) => {
  try {
    await stats.deleteLayout(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /dashboard/layout failed", err);
    res.status(500).json({ error: "reset failed" });
  }
});

pagesRouter.get("/dashboard/:date", requireAuth, async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, req.params.date]);
    if (rows.length === 0) return res.status(404).render("day", { day: null, samples: [], aggregates: [], exercises: [], date: req.params.date });
    const d = rows[0];
    const [aggs, samples, ex] = await Promise.all([
      query("SELECT metric,min,max,avg FROM day_aggregates WHERE day_id=$1", [d.id]),
      query("SELECT metric,start_at,end_at,value_num,value_secondary,value_text,source,meta FROM samples WHERE day_id=$1 ORDER BY start_at LIMIT 500", [d.id]),
      query("SELECT name,start_at,duration_minutes,source,detail FROM exercises WHERE day_id=$1", [d.id]),
    ]);
    res.render("day", { day: d, aggregates: aggs.rows, samples: samples.rows, exercises: ex.rows, date: req.params.date });
  } catch (err) {
    console.error("GET /dashboard/:date failed", err);
    res.status(500).render("day", { day: null, samples: [], aggregates: [], exercises: [], date: req.params.date });
  }
});

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
  splitSeries, visibleMetrics, visibleTiles, assignSourceColors, sourceLines, sourceDisplayName, groupSources,
  bmiFromWeightHeight, bmiCategory, fillForward,
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
  if (user.disabled_at) return show(res, "login", { error: "Account disabled." });
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

    const [rows, aggs, totals, metrics, cover, workouts, hrRows, recent, user, savedLayout, bmiRows, bmiScale] = await Promise.all([
      stats.dailyRows(req.user.id, fromKey, toKeyStr),
      stats.aggregateRows(req.user.id, fromKey, toKeyStr),
      stats.summary(req.user.id, fromKey, toKeyStr),
      stats.availableMetrics(req.user.id, fromKey, toKeyStr),
      stats.coverage(req.user.id, fromKey, toKeyStr),
      stats.exerciseBreakdown(req.user.id, fromKey, toKeyStr),
      stats.heartRateSplit(req.user.id, fromKey, toKeyStr),
      stats.recentDays(req.user.id, 14),
      store.findUserById(req.user.id),
      stats.getLayout(req.user.id),
      stats.bmiSeries(req.user.id, fromKey, toKeyStr).catch(() => []),
      stats.userBmiScale(req.user.id).catch(() => "standard"),
    ]);

    // Source filter: absent param = "All" (show combined); "none"/empty = nothing;
    // comma list = only those sources.
    const allSources = await stats.availableSources(req.user.id, fromKey, toKeyStr);
    const sourceCounts = await stats.sourceCounts(req.user.id, fromKey, toKeyStr);
    const sourceGroups = groupSources(allSources);
    const slugToPackages = Object.fromEntries(sourceGroups.map((g) => [g.slug, g.packages]));
    const sourcesParam = req.query.sources;
    const allActive = sourcesParam === undefined;
    const selectedSlugs = allActive ? []
      : (sourcesParam === "none" || !sourcesParam ? []
        : sourcesParam.split(",").filter((s) => slugToPackages[s]));
    const selectedSources = selectedSlugs.flatMap((s) => slugToPackages[s] || []);
    const filterActive = !allActive;
    const sourceColors = assignSourceColors(allSources);
    const sourceNames = Object.fromEntries(allSources.map((s) => [s, sourceDisplayName(s)]));
    const groupCounts = Object.fromEntries(sourceGroups.map((g) => [
      g.slug, g.packages.reduce((sum, pkg) => sum + (sourceCounts[pkg] || 0), 0),
    ]));
    const groupColors = Object.fromEntries(sourceGroups.map((g) => [g.slug, sourceColors[g.packages[0]]]));


    const layoutMode = savedLayout ? "custom" : "default";

    // Determine which special cards have data
    const hasSleep = !filterActive && rows.some((r) => r.sleep_duration_minutes != null);
    const hasHrSplit = !filterActive && hrRows.some((r) => r.scope === "active");
    const hasWorkouts = !filterActive && workouts.length > 0;
    const hasBmi = bmiRows.length > 0;
    let hasBmiCard = hasBmi;
    if (!hasBmi) {
      const hasWeight = (cover.weight ?? 0) > 0;
      const hasHeight = (cover.height ?? 0) > 0;
      const { rows: userRows } = await query("SELECT profile_height_m FROM users WHERE id = $1", [req.user.id]);
      const hasProfileHeight = userRows[0]?.profile_height_m != null;
      if (hasWeight && !hasHeight && !hasProfileHeight) {
        chartData.bmi = {
          key: "bmi", label: "BMI", hasData: false,
          message: "Set your height in the app to see BMI",
        };
        hasBmiCard = true;
      }
    }

    // Map of card key → whether it has data in this range
    const shownDayMetrics = visibleMetrics(stats.DAY_METRICS, cover);
    const bandKeys = stats.BAND_METRICS.filter((m) => metrics.includes(m));
    const dayKeysWithData = new Set(shownDayMetrics.map((m) => m.column));
    const bandKeysWithData = new Set(bandKeys.map((k) => `band:${k}`));

    function cardHasData(key) {
      if (dayKeysWithData.has(key)) return true;
      if (bandKeysWithData.has(key)) return true;
      if (key === "sleep") return hasSleep;
      if (key === "hr_split") return hasHrSplit;
      if (key === "workouts") return hasWorkouts;
      if (key === "recent") return recent.length > 0;
      if (key === "bmi") return hasBmiCard;
      return false;
    }

    // Ordered list of card keys to render
    let cardKeys;
    if (savedLayout) {
      // Custom: use saved order, filter to cards that have data
      cardKeys = savedLayout.filter((k) => stats.isValidCardKey(k) && cardHasData(k));
    } else {
      // Default: all DAY_METRICS with data, then sleep, hr_split, bands, workouts, recent
      cardKeys = [
        ...shownDayMetrics.map((m) => m.column),
        ...(hasSleep ? ["sleep"] : []),
        ...(hasHrSplit ? ["hr_split"] : []),
        ...bandKeys.map((k) => `band:${k}`),
        ...(hasBmiCard ? ["bmi"] : []),
        ...(hasWorkouts ? ["workouts"] : []),
        ...((recent.length > 0) ? ["recent"] : []),
      ];
    }

    // Build card descriptors for the template
    const catalogByKey = Object.fromEntries(stats.CARD_CATALOG.map((c) => [c.key, c]));
    const cardList = cardKeys.map((key) => ({ key, ...catalogByKey[key] }));

    // Available cards for the "add chart" picker (have data but not in layout)
    const cardKeySet = new Set(cardKeys);
    const availableCards = stats.CARD_CATALOG
      .filter((c) => !cardKeySet.has(c.key) && cardHasData(c.key))
      .map((c) => ({ ...c }));

    const srcRows = selectedSources.length
      ? await stats.sourceRows(
          req.user.id, fromKey, toKeyStr,
          [...shownDayMetrics.map((m) => m.sourceKey), ...bandKeys],
          selectedSources,
        )
      : [];

    const nullPoints = (pts) => pts.map((p) => ({ ...p, value: null }));
    const nullBand = (pts) => pts.map((p) => ({ ...p, min: null, max: null, avg: null }));

    // Build per-key chart data
    const chartData = {};

    // DAY_METRICS
    for (const m of shownDayMetrics) {
      const points = fillDays(rows, fromKey, toKeyStr, m.column);
      const srcLines = sourceLines(srcRows, fromKey, toKeyStr, m.sourceKey, sourceColors);
      chartData[m.column] = {
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
    }

    // BAND_METRICS
    for (const metric of bandKeys) {
      chartData[`band:${metric}`] = {
        key: `band:${metric}`,
        metric,
        label: metricLabel(metric),
        points: filterActive ? nullBand(bandSeries(aggs, fromKey, toKeyStr, metric))
          : bandSeries(aggs, fromKey, toKeyStr, metric),
        sources: sourceLines(srcRows, fromKey, toKeyStr, metric, sourceColors),
        filtered: filterActive,
      };
    }

    // Special charts
    if (hasSleep) {
      chartData.sleep = { points: sleepStages(rows, fromKey, toKeyStr) };
    }
    if (hasHrSplit) {
      chartData.hr_split = { points: splitSeries(hrRows, fromKey, toKeyStr) };
    }
    if (hasWorkouts) {
      chartData.workouts = { rows: workouts };
    }
    chartData.recent = { rows: recent };

    if (hasBmi) {
      const latestBmi = Number(bmiRows[bmiRows.length - 1].bmi);
      const latestWeight = Number(bmiRows[bmiRows.length - 1].weight);
      const latestHeight = Number(bmiRows[bmiRows.length - 1].height);
      const category = bmiCategory(latestBmi, bmiScale);

      // Trend: compare latest BMI to the value at start of range
      const firstBmi = Number(bmiRows[0].bmi);
      const trendDelta = Math.round((latestBmi - firstBmi) * 10) / 10;
      const trendDir = trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "stable";

      const bmiPoints = fillForward(bmiRows, fromKey, toKeyStr, "bmi");

      chartData.bmi = {
        key: "bmi",
        label: "BMI",
        current: latestBmi,
        category,
        scale: bmiScale,
        trendDelta,
        trendDir,
        weight: latestWeight,
        height: latestHeight,
        points: bmiPoints,
        hasData: true,
      };
    }
    res.render("dashboard", {
      email: user?.email,
      range: days,
      ranges: RANGES,
      tiles: filterActive ? [] : visibleTiles(summaryTiles(totals)),
      totals: filterActive && !selectedSources.length ? {} : totals,
      chartData,
      cardList,
      layoutMode,
      availableCards,
      workouts: filterActive ? [] : workouts,
      recent,
      toKey,
      allActive,
      availableSources: allSources,
      selectedSources,
      selectedSlugs,
      sourceColors,
      sourceNames,
      sourceCounts,
      sourceGroups,
      groupCounts,
      groupColors,
      bmiScale,
      buildInfo,
    });
  } catch (err) {
    console.error("GET /dashboard failed", err);
    res.status(500).render("dashboard", {
      email: null, range: 30, ranges: RANGES, tiles: [], totals: {},
      chartData: {}, cardList: [], layoutMode: "default", availableCards: [],
      workouts: [], recent: [], toKey,
      allActive: true, availableSources: [], selectedSources: [], selectedSlugs: [], sourceColors: {}, sourceNames: {}, sourceCounts: {},
      sourceGroups: [], groupCounts: {}, groupColors: {},
      bmiScale: "standard",
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
    let cards = existing || stats.CARD_CATALOG.map((c) => c.key);
    if (!cards.includes(card)) cards.push(card);
    if (cards.length > 25) cards = cards.slice(0, 25);
    await stats.saveLayout(req.user.id, cards);
    res.redirect(`/dashboard?range=${req.query.range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/add failed", err);
    res.status(500).json({ error: "add failed" });
  }
});

pagesRouter.post("/dashboard/layout/customize", requireAuth, async (req, res) => {
  try {
    const existing = await stats.getLayout(req.user.id);
    if (!existing) {
      // Snapshot current visible cards as the starting layout
      // We need to compute what the default view shows — use all catalog keys
      // and let the render filter by data availability
      const defaultKeys = stats.CARD_CATALOG.map((c) => c.key);
      await stats.saveLayout(req.user.id, defaultKeys);
    }
    res.redirect(`/dashboard?range=${req.query.range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/customize failed", err);
    res.redirect("/dashboard");
  }
});

pagesRouter.post("/dashboard/layout/reorder", requireAuth, async (req, res) => {
  try {
    const { card, dir, range } = req.body;
    if (dir !== "up" && dir !== "down") return res.redirect(`/dashboard?range=${range || 30}`);
    const existing = await stats.getLayout(req.user.id);
    if (!existing) return res.redirect(`/dashboard?range=${range || 30}`);
    const idx = existing.indexOf(card);
    if (idx === -1) return res.redirect(`/dashboard?range=${range || 30}`);
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= existing.length) return res.redirect(`/dashboard?range=${range || 30}`);
    [existing[idx], existing[swap]] = [existing[swap], existing[idx]];
    await stats.saveLayout(req.user.id, existing);
    res.redirect(`/dashboard?range=${range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/reorder failed", err);
    res.redirect("/dashboard");
  }
});

pagesRouter.post("/dashboard/layout/remove", requireAuth, async (req, res) => {
  try {
    const { card, range } = req.body;
    const existing = await stats.getLayout(req.user.id);
    if (!existing) return res.redirect(`/dashboard?range=${range || 30}`);
    const cards = existing.filter((k) => k !== card);
    await stats.saveLayout(req.user.id, cards);
    res.redirect(`/dashboard?range=${range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/remove failed", err);
    res.redirect("/dashboard");
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

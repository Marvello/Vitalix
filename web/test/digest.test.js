import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { periodFor, isDue, previousPeriod, buildDigestPrompts } = await import("../src/ai/digest.js");
const { runDigests, PENDING_DIGEST_USERS_SQL } = await import("../src/digests.js");
const { todayIn } = await import("../src/ai/recommendations.js");

describe("periodFor / isDue", () => {
  test("week = previous Mon-Sun", () => {
    assert.deepEqual(periodFor("week", "2026-11-09"), { start: "2026-11-02", end: "2026-11-08" });
    // mid-week still maps to the last full week
    assert.deepEqual(periodFor("week", "2026-11-11"), { start: "2026-11-02", end: "2026-11-08" });
    assert.deepEqual(periodFor("week", "2026-11-08"), { start: "2026-10-26", end: "2026-11-01" });
  });
  test("month = previous calendar month, across year and leap boundaries", () => {
    assert.deepEqual(periodFor("month", "2026-12-01"), { start: "2026-11-01", end: "2026-11-30" });
    assert.deepEqual(periodFor("month", "2027-01-01"), { start: "2026-12-01", end: "2026-12-31" });
    assert.deepEqual(periodFor("month", "2028-03-01"), { start: "2028-02-01", end: "2028-02-29" });
  });
  test("previousPeriod is the same-length period before", () => {
    assert.deepEqual(previousPeriod("week", "2026-11-02"), { start: "2026-10-26", end: "2026-11-01" });
    assert.deepEqual(previousPeriod("month", "2026-11-01"), { start: "2026-10-01", end: "2026-10-31" });
    assert.deepEqual(previousPeriod("month", "2026-01-01"), { start: "2025-12-01", end: "2025-12-31" });
  });
  test("isDue: Monday for week, the 1st for month", () => {
    assert.equal(isDue("week", "2026-11-09"), true);
    assert.equal(isDue("week", "2026-11-10"), false);
    assert.equal(isDue("week", "2026-11-08"), false);
    assert.equal(isDue("month", "2026-12-01"), true);
    assert.equal(isDue("month", "2026-12-02"), false);
    assert.equal(isDue("month", "2026-11-11"), false);
  });
  test("Asia/Jakarta Monday while UTC is still Sunday", () => {
    const now = new Date("2026-11-08T20:00:00Z"); // Sun 20:00 UTC = Mon 03:00 Jakarta
    assert.equal(todayIn("UTC", now), "2026-11-08");
    const local = todayIn("Asia/Jakarta", now);
    assert.equal(local, "2026-11-09");
    assert.equal(isDue("week", local), true);
    assert.equal(isDue("week", todayIn("UTC", now)), false);
    assert.deepEqual(periodFor("week", local), { start: "2026-11-02", end: "2026-11-08" });
  });
});

describe("buildDigestPrompts", () => {
  const d = (day, o) => ({ day, restingHr: 60, sleepMin: 432, steps: 8000, ...o });
  test("3 recorded days → 'N of 7 days recorded', averages and % change", () => {
    const days = [d("2026-11-02", { readiness: 70 }), d("2026-11-03", { steps: 10000, readiness: 80 }), d("2026-11-04", { readiness: 60 })];
    const prevDays = [d("2026-10-26", { steps: 6000 })];
    const { user, system, hasData } = buildDigestPrompts({ kind: "week", days, prevDays, workouts: [], start: "2026-11-02", end: "2026-11-08" });
    assert.equal(hasData, true);
    assert.match(user, /Steps: avg 8,667, previous period avg 6,000 \(\+44%\); 3 of 7 days recorded/);
    assert.match(user, /Sleep: avg 7h 12m/);
    assert.match(user, /Best day by readiness: 2026-11-03 \(80\); worst: 2026-11-04 \(60\)/);
    assert.match(system, /No diagnosis/);
    assert.match(system, /3 to 5 lines/);
  });
  test("percent omitted when previous avg is missing or 0", () => {
    const none = buildDigestPrompts({ kind: "week", days: [d("a")], prevDays: [] }).user;
    assert.doesNotMatch(none, /previous period|%/);
    const zero = buildDigestPrompts({ kind: "week", days: [d("a")], prevDays: [d("b", { steps: 0 })] }).user;
    assert.match(zero, /Steps: avg 8,000, previous period avg 0; /);
  });
  test("workouts counted; month length from start/end; no data → hasData false", () => {
    const w = buildDigestPrompts({ kind: "month", days: [d("a")], workouts: [{ duration_minutes: 30 }, { duration_minutes: 45 }], start: "2026-11-01", end: "2026-11-30" });
    assert.match(w.user, /Workouts: 2, 1h 15m in total/);
    assert.match(w.user, /1 of 30 days recorded/);
    const empty = buildDigestPrompts({ kind: "week", days: [], prevDays: [d("a")], workouts: [] });
    assert.equal(empty.hasData, false);
  });
  test("journal is accepted and ignored", () => {
    const a = buildDigestPrompts({ kind: "week", days: [d("a")], journal: [{ note: "x" }] });
    assert.equal(a.user, buildDigestPrompts({ kind: "week", days: [d("a")] }).user);
  });
});

describe("runDigests", () => {
  // Monday 2026-11-09 (also the first Monday-and-not-1st); user 3 is on a Tuesday.
  function setup({ existing = [], generate } = {}) {
    const calls = { generated: [], pushed: [], inserts: [] };
    const query = async (text, params) => {
      if (text === PENDING_DIGEST_USERS_SQL) return { rows: [{ id: 1, today: "2026-11-09" }, { id: 2, today: "2026-11-09" }, { id: 3, today: "2026-11-10" }] };
      if (text.includes("FROM ai_digests")) return { rows: existing.includes(`${params[0]}:${params[1]}:${params[2]}`) ? [{}] : [] };
      if (text.includes("array_agg(token)")) return { rows: [{ tokens: ["t" + params[0]] }] };
      return { rows: [] };
    };
    const messaging = {
      sendEachForMulticast: async (m) => { calls.pushed.push(m); return { successCount: 1, responses: [{ success: true }] }; },
    };
    const gen = generate ?? (async (...a) => { calls.generated.push(a); });
    return { calls, deps: { query, messaging, generate: gen } };
  }

  test("generates for due users only and pushes digest_ready { kind, start }", async () => {
    const { calls, deps } = setup();
    const r = await runDigests(deps);
    assert.deepEqual(r, { candidates: 2, generated: 2, pushed: 2, failed: 0 });
    assert.deepEqual(calls.generated[0], [1, "week", "2026-11-02", "2026-11-08"]);
    assert.deepEqual(calls.pushed[0].data, { type: "digest_ready", kind: "week", start: "2026-11-02" });
    assert.deepEqual(calls.pushed[1].tokens, ["t2"]);
  });
  test("skips a user whose period already has a row", async () => {
    const { calls, deps } = setup({ existing: ["1:week:2026-11-02"] });
    const r = await runDigests(deps);
    assert.equal(r.candidates, 1);
    assert.deepEqual(calls.generated.map((g) => g[0]), [2]);
    assert.equal(calls.pushed.length, 1);
  });
  test("AI_UNCONFIGURED breaks the loop, NO_DATA skips quietly, other errors don't push", async () => {
    const un = setup({ generate: async () => { throw Object.assign(new Error("x"), { code: "AI_UNCONFIGURED" }); } });
    assert.deepEqual(await runDigests(un.deps), { candidates: 1, generated: 0, pushed: 0, failed: 1 });
    const nd = setup({ generate: async () => { throw Object.assign(new Error("x"), { code: "NO_DATA" }); } });
    assert.deepEqual(await runDigests(nd.deps), { candidates: 2, generated: 0, pushed: 0, failed: 0 });
    assert.equal(nd.calls.pushed.length, 0);
    const boom = setup({ generate: async (id) => { if (id === 1) throw new Error("llm"); } });
    const r = await runDigests(boom.deps);
    assert.deepEqual([r.generated, r.failed, r.pushed], [1, 1, 1]);
  });
  test("both kinds due on Monday the 1st", async () => {
    const calls = [];
    const query = async (t) => (t === PENDING_DIGEST_USERS_SQL ? { rows: [{ id: 1, today: "2027-02-01" }] } : { rows: [] });
    const r = await runDigests({ query, messaging: null, generate: async (...a) => { calls.push(a); } });
    assert.deepEqual(calls.map((c) => c[1]), ["week", "month"]);
    assert.equal(r.generated, 2);
  });
});

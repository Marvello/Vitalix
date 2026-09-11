import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { runDailyInsights, PENDING_USERS_SQL } = await import("../src/dailyInsights.js");

describe("PENDING_USERS_SQL", () => {
  test("wants the day's users lacking a recommendation", () => {
    assert.match(PENDING_USERS_SQL, /FROM health_days/);
    assert.match(PENDING_USERS_SQL, /NOT EXISTS/);
    assert.match(PENDING_USERS_SQL, /ai_recommendations/);
  });
});

function makeDeps(overrides = {}) {
  const calls = { generated: [], pushed: [] };
  const query = async (text, params) => {
    if (text === PENDING_USERS_SQL) return { rows: [{ id: 1 }, { id: 2 }] };
    if (text.includes("array_agg(token)")) return { rows: [{ tokens: ["t-" + params[0]] }] };
    return { rows: [] };
  };
  const generate = async (id, day) => { calls.generated.push([id, day]); };
  const messaging = {
    sendEachForMulticast: async ({ tokens, data }) => {
      calls.pushed.push({ tokens, data });
      return { successCount: tokens.length, responses: tokens.map(() => ({ success: true })) };
    },
  };
  return { deps: { query, generate, messaging, day: "2026-09-10", ...overrides }, calls };
}

describe("runDailyInsights", () => {
  test("generates for each pending user and pushes insight_ready", async () => {
    const { deps, calls } = makeDeps();
    const r = await runDailyInsights(deps);
    assert.deepEqual(r, { day: "2026-09-10", candidates: 2, generated: 2, pushed: 2, failed: 0 });
    assert.deepEqual(calls.generated, [[1, "2026-09-10"], [2, "2026-09-10"]]);
    assert.equal(calls.pushed[0].data.type, "insight_ready");
    assert.equal(calls.pushed[0].data.day, "2026-09-10");
  });

  test("does not push for a user whose generation failed", async () => {
    const { deps, calls } = makeDeps({
      generate: async (id) => { if (id === 1) throw new Error("llm boom"); },
    });
    const r = await runDailyInsights(deps);
    assert.equal(r.generated, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.pushed, 1); // only user 2 pushed
    assert.deepEqual(calls.pushed.map((p) => p.tokens), [["t-2"]]);
  });

  test("stops early when AI is unconfigured", async () => {
    const { deps, calls } = makeDeps({
      generate: async () => { const e = new Error("no ai"); e.code = "AI_UNCONFIGURED"; throw e; },
    });
    const r = await runDailyInsights(deps);
    assert.equal(r.generated, 0);
    assert.equal(r.failed, 1);     // broke after the first failure
    assert.equal(calls.pushed.length, 0);
  });
});

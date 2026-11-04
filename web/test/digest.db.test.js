import { test, describe, before, after } from "node:test";
import { createTestDb } from "./helpers/testDb.js";
import assert from "node:assert/strict";
import express from "express";

const testDb = await createTestDb(import.meta.url);
process.env.JWT_SECRET ??= "test-secret";
process.env.CRON_SECRET = "cron-s";

describe("digests against Postgres", { skip: !testDb }, () => {
  let db, userId, server, base, token;
  const realFetch = globalThis.fetch;
  before(async () => {
    db = await import("../src/db.js");
    userId = (await db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'x') RETURNING id")).rows[0].id;
    const { persist } = await import("../src/persist.js");
    const sync = { source: "test", app_version: "1", device: "d", exported_at: new Date().toISOString(), range_days: 2 };
    await persist(userId, { sync, days: ["2026-11-02", "2026-11-03", "2026-10-27"].map((day, i) => (
      { day, scalars: { steps: [8000, 10000, 6000][i], sleep_duration_minutes: 432 }, aggregates: [], samples: [], exercises: [] })) });
    const { aiRouter } = await import("../src/routes/ai.js");
    const { signAccess } = await import("../src/auth/tokens.js");
    token = signAccess({ id: userId, role: "user" });
    const app = express().use(aiRouter);
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { globalThis.fetch = realFetch; server?.close(); });

  test("DIGEST_DUE_SQL needs a recorded day in the period and no stored digest", async () => {
    const { DIGEST_DUE_SQL } = await import("../src/digests.js");
    const due = async (kind, s, e) => (await db.query(DIGEST_DUE_SQL, [userId, kind, s, e])).rows.length;
    assert.equal(await due("week", "2026-12-07", "2026-12-13"), 0); // no health_days in range
    assert.equal(await due("week", "2026-11-09", "2026-11-15"), 0); // ditto
    assert.equal(await due("week", "2026-11-02", "2026-11-08"), 1); // data, no digest yet
    await db.query(`INSERT INTO ai_digests (user_id, kind, period_start, period_end, text) VALUES ($1, 'week', '2026-11-02', '2026-11-08', 'x')`, [userId]);
    assert.equal(await due("week", "2026-11-02", "2026-11-08"), 0); // stored
    await db.query("DELETE FROM ai_digests");
  });

  test("generateDigest stores one row, sends the period stats, ignores a repeat; route serves it", async () => {
    const { config } = await import("../src/config.js");
    const { generateDigest } = await import("../src/ai/digest.js");
    config.ai.baseUrl = "";
    await assert.rejects(() => generateDigest(userId, "week", "2026-11-02", "2026-11-08"), { code: "AI_UNCONFIGURED" });
    config.ai.baseUrl = "http://llm.test/v1";
    let prompt;
    globalThis.fetch = async (u, init) => {
      if (!String(u).startsWith("http://llm.test")) return realFetch(u, init);
      prompt = JSON.parse(init.body).messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: "- Steps: up." } }], usage: {} }), { status: 200 });
    };
    await assert.rejects(() => generateDigest(userId, "week", "2026-12-07", "2026-12-13"), { code: "NO_DATA" });
    assert.equal((await generateDigest(userId, "week", "2026-11-02", "2026-11-08")).inserted, true);
    assert.equal((await generateDigest(userId, "week", "2026-11-02", "2026-11-08")).inserted, false);
    assert.match(prompt, /Steps: avg 9,000, previous period avg 6,000 \(\+50%\); 2 of 7 days recorded/);
    const { rows } = await db.query("SELECT kind, period_start::text AS s, period_end::text AS e, text FROM ai_digests");
    assert.deepEqual(rows, [{ kind: "week", s: "2026-11-02", e: "2026-11-08", text: "- Steps: up." }]);

    const get = (q, h = { Authorization: `Bearer ${token}` }) => realFetch(`${base}/api/ai/digests/latest${q}`, { headers: h });
    assert.deepEqual(await (await get("?kind=week")).json(),
      { kind: "week", period_start: "2026-11-02", period_end: "2026-11-08", text: "- Steps: up." });
    assert.equal((await get("?kind=month")).status, 404);
    assert.equal((await get("?kind=year")).status, 400);
    assert.equal((await get("")).status, 400);
    assert.equal((await get("?kind=week", {})).status, 401);
  });
});

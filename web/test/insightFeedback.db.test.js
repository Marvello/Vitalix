import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const url = process.env.TEST_DATABASE_URL;

describe("insight feedback against Postgres", { skip: !url }, () => {
  let db, userId, server, base, token;
  before(async () => {
    db = await import("../src/db.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/migrate.js")).runPendingMigrations();
    userId = (await db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'x') RETURNING id")).rows[0].id;
    await db.query(
      "INSERT INTO ai_recommendations (user_id, day, provider, model, recommendation_text, metrics_snapshot) VALUES ($1, '2026-11-02', 'p', 'm', 't', '{}')",
      [userId],
    );
    const { aiRouter } = await import("../src/routes/ai.js");
    const { signAccess } = await import("../src/auth/tokens.js");
    token = signAccess({ id: userId, role: "user" });
    server = await new Promise((r) => { const s = express().use(express.json()).use(aiRouter).listen(0, () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); await db?.pool.end(); });

  const post = (day, value) => fetch(`${base}/api/ai/recommendations/${day}/feedback`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  const get = async () => (await fetch(`${base}/api/ai/recommendations/2026-11-02`, { headers: { Authorization: `Bearer ${token}` } })).json();

  test("bad value or malformed day is 400", async () => {
    for (const value of [2, "1", null, undefined]) assert.equal((await post("2026-11-02", value)).status, 400, String(value));
    assert.equal((await post("nope", 1)).status, 400);
  });

  test("missing row is 404", async () => {
    assert.equal((await post("2026-11-03", 1)).status, 404);
  });

  test("down, up, clear are stored and returned by GET", async () => {
    assert.equal((await post("2026-11-02", -1)).status, 204);
    assert.equal((await get()).feedback, -1);
    assert.equal((await post("2026-11-02", 1)).status, 204);
    assert.equal((await get()).feedback, 1);
    assert.equal((await post("2026-11-02", 0)).status, 204);
    const { feedback } = await get();
    assert.equal(feedback, null);
    const { rows } = await db.query("SELECT feedback_at FROM ai_recommendations WHERE user_id = $1", [userId]);
    assert.equal(rows[0].feedback_at, null);
  });
});

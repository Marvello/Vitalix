// Integration checks against a real, throwaway Postgres. Skipped unless
// TEST_DATABASE_URL is set, e.g.:
//   docker run -d --rm -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t -p 55432:5432 postgres:18-alpine
//   TEST_DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node --test test/persist.db.test.js
// The database is wiped (public schema dropped) before the run.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const url = process.env.TEST_DATABASE_URL;

describe("persist + auth against Postgres", { skip: !url }, () => {
  let db, persist, requireAuth, signAccess, userId, server, baseUrl;

  before(async () => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= "test-secret";
    db = await import("../src/db.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/migrate.js")).runPendingMigrations();
    ({ persist } = await import("../src/persist.js"));
    ({ requireAuth } = await import("../src/auth/middleware.js"));
    ({ signAccess } = await import("../src/auth/tokens.js"));
    const { rows } = await db.query(
      "INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'x') RETURNING id");
    userId = rows[0].id;

    const app = express();
    app.get("/api/me", requireAuth, (req, res) => res.json(req.user));
    await new Promise((r) => { server = app.listen(0, r); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await db?.pool.end();
  });

  const sync = { source: "test", app_version: "1", device: "d", exported_at: new Date().toISOString(), range_days: 1 };
  const sample = (metric, hc_id, value, start = "2026-10-01T08:00:00Z") => ({
    metric, hc_id, start_at: start, end_at: start, value_num: value,
    value_secondary: null, value_text: null, source: "pkg", meta: null,
  });
  const day = (samples, aggregates = []) => ({ day: "2026-10-01", scalars: {}, aggregates, samples, exercises: [] });

  test("a metric absent from a later payload keeps its samples and aggregates", async () => {
    await persist(userId, { sync, days: [day(
      [sample("heart_rate", "hr1", 60), sample("steps", "st1", 100)],
      [{ metric: "heart_rate", min: 50, max: 70, avg: 60 }],
    )] });
    await persist(userId, { sync, days: [day([sample("steps", "st1", 120)])] });

    const { rows: s } = await db.query("SELECT metric, value_num FROM samples ORDER BY metric");
    assert.deepEqual(s.map((r) => [r.metric, r.value_num]), [["heart_rate", 60], ["steps", 120]]);
    const { rows: a } = await db.query("SELECT metric FROM day_aggregates");
    assert.deepEqual(a.map((r) => r.metric), ["heart_rate"]);
  });

  test("nutrients of one NutritionRecord are stored as separate records", async () => {
    await persist(userId, { sync, days: [day([
      sample("nutrition", "n1", 500),
      sample("nutrition.protein", "n1", 30),
      sample("nutrition.fat", "n1", 20),
    ])] });
    const { rows } = await db.query("SELECT type FROM records WHERE hc_id = 'n1' ORDER BY type");
    assert.deepEqual(rows.map((r) => r.type), ["nutrition", "nutrition.fat", "nutrition.protein"]);
  });

  test("requireAuth rejects a disabled user and takes role from the DB", async () => {
    const token = signAccess({ id: userId, role: "admin" }); // stale/forged role claim
    let res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).role, "user");

    await db.query("UPDATE users SET disabled_at = now() WHERE id = $1", [userId]);
    res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
  });
});

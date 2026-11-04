import { test, describe, before, after } from "node:test";
import { createTestDb } from "./helpers/testDb.js";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import { errorHandler } from "../src/errorHandler.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDb = await createTestDb(import.meta.url);

describe("GET /insights/correlations", { skip: !testDb }, () => {
  let db, server, base, tok;
  before(async () => {
    db = await import("../src/db.js");
    const { rows } = await db.query("INSERT INTO users (email, password_hash, timezone) VALUES ('c@b.c', 'x', 'UTC') RETURNING id");
    const id = rows[0].id;
    await db.query(`INSERT INTO health_days (user_id, day, sleep_duration_minutes, resting_heart_rate)
      SELECT $1, d::date, 360 + (d::date - '2026-10-01'::date) * 5, 40 + (d::date - '2026-10-01'::date) % 7
      FROM generate_series('2026-10-01'::date, '2026-11-03', '1 day') d`, [id]);
    tok = (await import("../src/auth/tokens.js")).signAccess({ id, role: "user" });
    const { pagesRouter } = await import("../src/routes/pages.js");
    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(path.dirname(fileURLToPath(import.meta.url)), "../views"));
    app.use(cookieParser()).use(pagesRouter);
    app.get("/api/boom", (req, res, next) => next(new Error("boom")));
    app.use(errorHandler);
    server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); });
  const get = (qs) => fetch(`${base}/insights/correlations${qs}`, { headers: { Authorization: `Bearer ${tok}` } });

  test("renders presets, a scatter circle and the journal note", async () => {
    const r = await get("?x=sleepMin&y=restingHr&lag=1");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Sleep → next-day HRV/);
    assert.match(html, /Alcohol → next-day HRV/);
    assert.match(html, /<circle /);
    assert.match(html, /Journal metrics use days with an entry\./);
  });

  test("an /api route that throws gets 500 JSON without the message or stack", async () => {
    const r = await fetch(`${base}/api/boom`);
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "Internal error" });
  });

  test("a failing query renders a 500 page, not a redirect", async () => {
    const orig = db.pool.query;
    db.pool.query = (sql, ...a) => (/health_days/.test(sql) ? Promise.reject(new Error("boom")) : orig.call(db.pool, sql, ...a));
    try {
      const r = await fetch(`${base}/insights/correlations`, { headers: { Authorization: `Bearer ${tok}` }, redirect: "manual" });
      assert.equal(r.status, 500);
      assert.equal(r.headers.get("location"), null);
      assert.match(r.headers.get("content-type"), /text\/html/);
      const body = await r.text();
      assert.doesNotMatch(body, /boom|at .*\.js|Error:/);
      assert.match(body, /Something went wrong/);
    } finally { db.pool.query = orig; }
  });
});

import { test, describe, before, after } from "node:test";
import { createTestDb } from "./helpers/testDb.js";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDb = await createTestDb(import.meta.url);
process.env.JWT_SECRET ??= "test-secret";

describe("day page with journal entries", { skip: !testDb }, () => {
  let db, server, base, tok;
  before(async () => {
    db = await import("../src/db.js");
    const { rows } = await db.query("INSERT INTO users (email, password_hash, timezone) VALUES ('d@b.c', 'x', 'Asia/Jakarta') RETURNING id");
    const id = rows[0].id;
    await db.query("INSERT INTO health_days (user_id, day, steps) VALUES ($1, '2026-11-04', 1000)", [id]);
    // 12 earlier days of resting HR + sleep (+ today 11-04 below) so readiness can score yesterday and today
    await db.query(`INSERT INTO health_days (user_id, day, resting_heart_rate, sleep_duration_minutes)
      SELECT $1, d::date, 55 + (d::date - '2026-10-20'::date) % 3, 420 FROM generate_series('2026-10-20'::date, '2026-11-03', '1 day') d`, [id]);
    await db.query("UPDATE health_days SET resting_heart_rate = 60, sleep_duration_minutes = 400 WHERE user_id = $1 AND day = '2026-11-04'", [id]);
    // 18:30Z = 01:30 next day in Jakarta
    await db.query("INSERT INTO journal_entries (user_id, day, kind, value_num, logged_at) VALUES ($1, '2026-11-04', 'mood', 4, '2026-11-03T18:30:00Z')", [id]);
    tok = (await import("../src/auth/tokens.js")).signAccess({ id, role: "user" });
    const { pagesRouter } = await import("../src/routes/pages.js");
    const app = express();
    app.locals.now = () => new Date("2026-11-03T18:30:00Z");
    app.set("view engine", "ejs");
    app.set("views", path.join(path.dirname(fileURLToPath(import.meta.url)), "../views"));
    app.use(express.json()).use(cookieParser()).use(pagesRouter);
    server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); });

  test("/dashboard/:date renders the journal time in the user's zone (was a 500)", async () => {
    const r = await fetch(`${base}/dashboard/2026-11-04`, { headers: { Authorization: `Bearer ${tok}` } });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<td>01:30<\/td><td>mood<\/td>/);
  });

  test("/dashboard range ends on the user's local today, not UTC today", async () => {
    // 18:30Z on 11-03 is 01:30 on 11-04 in Jakarta, while UTC is still 11-03.
    const r = await fetch(`${base}/dashboard?range=7`, { headers: { Authorization: `Bearer ${tok}` } });
    assert.equal(r.status, 200);
    const pts = JSON.parse((await r.text()).match(/const CHART_DATA = (.*);/)[1]).readiness.points;
    assert.equal(pts[0].date, "2026-10-29");
    assert.equal(pts.at(-1).date, "2026-11-04"); // UTC today would be 11-03
  });

  test("D4: readiness card shows finished days only (latest = local yesterday, no point for local today)", async () => {
    const r = await fetch(`${base}/dashboard?range=7`, { headers: { Authorization: `Bearer ${tok}` } });
    const cd = JSON.parse((await r.text()).match(/const CHART_DATA = (.*);/)[1]).readiness;
    assert.equal(cd.latest.day, "2026-11-03"); // local today is 11-04 (has data) but is unfinished
    const byDate = Object.fromEntries(cd.points.map((p) => [p.date, p.value]));
    assert.equal(typeof byDate["2026-11-03"], "number");
    assert.equal(byDate["2026-11-04"], null);
  });
});

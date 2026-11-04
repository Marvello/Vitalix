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
    const html = await r.text();
    const days = [...new Set(html.match(/\b2026-1[01]-\d\d\b/g))].sort();
    assert.equal(days.at(-1), "2026-11-04");
    assert.ok(days.includes("2026-10-29") && !days.includes("2026-10-28"), days.join(","));
  });
});

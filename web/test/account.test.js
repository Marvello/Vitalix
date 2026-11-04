import { test, describe, before, after } from "node:test";
import { createTestDb } from "./helpers/testDb.js";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDb = await createTestDb(import.meta.url);
process.env.JWT_SECRET ??= "test-secret";
const { csvField, write, streamExport } = await import("../src/exportData.js");
const { sameOrigin } = await import("../src/sameOrigin.js");
const http = await import("node:http");
const { EventEmitter } = await import("node:events");

test("write: a client that never drains is dropped after the timeout (response destroyed)", async () => {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    write: () => false,
    destroy() { this.destroyed = true; this.emit("close"); },
  });
  assert.equal(await write(res, "x", 20), false);
  assert.equal(res.destroyed, true);
  assert.equal(res.listenerCount("drain") + res.listenerCount("close"), 0, "listeners cleaned up");
});

test("write: drain before the timeout continues", async () => {
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, write: () => false, destroy() {} });
  setTimeout(() => res.emit("drain"), 5);
  assert.equal(await write(res, "x", 1000), true);
});

test("csvField quotes per RFC 4180 and neutralises formulas", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField(12.5), "12.5");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("x\ny"), '"x\ny"');
  for (const s of ["=1+1", "+1", "-1", "@SUM(A1)"]) assert.equal(csvField(s), `'${s}`);
  assert.equal(csvField(-5), "-5", "numbers are not text cells");
  assert.equal(csvField("=a,b"), `"'=a,b"`);
});

describe("account export + deletion against Postgres", { skip: !testDb }, () => {
  let db, server, base, passwordHash, clock = null;
  let seq = 0;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const json = (t) => ({ ...auth(t), "Content-Type": "application/json" });
  const APP = "https://vitalix.example";

  /** A fresh user with one row in every exported table (+ `bulk` extra records). Each test makes its own. */
  async function mkUser({ role = "user", bulk = 0, password = "correct horse" } = {}) {
    const { signAccess } = await import("../src/auth/tokens.js");
    const { issueRefresh } = await import("../src/auth/store.js");
    const email = `u${++seq}@x.io`;
    const ph = password === "correct horse" ? passwordHash : await (await import("../src/auth/passwords.js")).hash(password);
    const u = (await db.query("INSERT INTO users (email, password_hash, role, timezone) VALUES ($1,$2,$3,'Asia/Jakarta') RETURNING id", [email, ph, role])).rows[0].id * 1;
    const tag = `u${u}`;
    const sync = (await db.query("INSERT INTO syncs (user_id) VALUES ($1) RETURNING id", [u])).rows[0].id;
    const day = (await db.query("INSERT INTO health_days (user_id, sync_id, day, steps) VALUES ($1,$2,'2026-11-01',$3) RETURNING id", [u, sync, u * 1000])).rows[0].id;
    await db.query("INSERT INTO day_aggregates (day_id, metric, avg) VALUES ($1,'heartRate',$2)", [day, u]);
    await db.query("INSERT INTO exercises (day_id, name, hc_id) VALUES ($1,$2,$3)", [day, `run-${tag}`, tag]);
    await db.query("INSERT INTO records (user_id, type, hc_id, start_at, value_num, source) VALUES ($1,'steps',$2,'2026-11-01T01:00:00Z',5,$3)", [u, tag, tag]);
    await db.query("INSERT INTO journal_entries (user_id, day, kind, value_text, logged_at) VALUES ($1,'2026-11-01','note',$2,'2026-11-01T01:00:00Z')", [u, `note-${tag}`]);
    await db.query("INSERT INTO ai_recommendations (user_id, day, provider, model, recommendation_text, metrics_snapshot) VALUES ($1,'2026-11-01','p','m',$2,'{}')", [u, `rec-${tag}`]);
    await db.query("INSERT INTO ai_digests (user_id, kind, period_start, period_end, text) VALUES ($1,'week','2026-10-26','2026-11-01',$2)", [u, `dig-${tag}`]);
    await db.query("INSERT INTO anomaly_alerts (user_id, day, rule) VALUES ($1,'2026-11-01',$2)", [u, `rule-${tag}`]);
    await db.query("INSERT INTO fcm_tokens (user_id, token, app_id) VALUES ($1,$2,'app')", [u, `secret-fcm-${tag}`]);
    await issueRefresh(u);
    if (bulk) await db.query(
      `INSERT INTO records (user_id, type, hc_id, start_at, value_num)
       SELECT $1, 'heartRate', 'bulk-' || g, '2026-11-01T00:00:00Z'::timestamptz + g * interval '1 second', g FROM generate_series(1, $2) g`, [u, bulk]);
    return { id: u, email, tag, tok: signAccess({ id: u, role }) };
  }

  before(async () => {
    db = await import("../src/db.js");
    passwordHash = await (await import("../src/auth/passwords.js")).hash("correct horse");
    const { accountRouter } = await import("../src/routes/account.js");
    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(path.dirname(fileURLToPath(import.meta.url)), "../views"));
    app.locals.now = () => clock ?? new Date();
    app.use(cookieParser()).use(sameOrigin({ baseUrl: () => APP }))
      .use(express.json()).use(express.urlencoded({ extended: false })).use(accountRouter);
    server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); });

  const del = (t, password) => fetch(`${base}/api/account`, { method: "DELETE", headers: json(t), body: JSON.stringify({ password }) });
  const exists = async (id) => (await db.query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount === 1;

  test("unauthenticated: 401 for API/export, redirect for pages", async () => {
    assert.equal((await fetch(`${base}/api/account`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/account/export.json`, { headers: { Accept: "application/json" } })).status, 401);
    assert.equal((await fetch(`${base}/account/export-days.csv`, { headers: { Accept: "application/json" } })).status, 401);
    const page = await fetch(`${base}/account`, { redirect: "manual", headers: { Accept: "text/html" } });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login");
  });

  test("export JSON: all keys, attachment name, streamed pages, no secrets", async () => {
    const A = await mkUser({ bulk: 12000 });
    const r = await fetch(`${base}/account/export.json`, { headers: auth(A.tok) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /^attachment; filename="vitalix-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await r.text();
    const d = JSON.parse(text);
    assert.deepEqual(Object.keys(d), ["exportedAt", "user", "health_days", "day_aggregates", "records", "exercises", "journal", "ai_recommendations", "ai_digests", "anomaly_alerts"]);
    assert.deepEqual(d.user, { email: A.email, timezone: "Asia/Jakarta", profile: { height_m: null, bmi_scale: "standard" } });
    assert.equal(d.records.length, 12001);
    assert.equal(new Set(d.records.map((x) => x.id)).size, 12001, "no duplicate or skipped rows across pages");
    for (const k of ["health_days", "day_aggregates", "exercises", "journal", "ai_recommendations", "ai_digests", "anomaly_alerts"]) assert.equal(d[k].length, 1, k);
    assert.equal(d.health_days[0].day, "2026-11-01");
    for (const secret of ["password", "token_hash", "secret-fcm", "user_id"]) assert.ok(!text.includes(secret), secret);
  });

  test("export of A contains none of B's rows in any table", async () => {
    const [A, B] = [await mkUser(), await mkUser()];
    const text = await (await fetch(`${base}/account/export.json`, { headers: auth(A.tok) })).text();
    const d = JSON.parse(text);
    assert.ok(!text.includes(B.tag) && !text.includes(B.email));
    assert.deepEqual(d.health_days.map((x) => x.steps), [A.id * 1000]);
    assert.deepEqual(d.day_aggregates.map((x) => x.avg), [A.id]);
    assert.deepEqual(d.exercises.map((x) => x.name), [`run-${A.tag}`]);
    assert.deepEqual(d.records.map((x) => x.hc_id), [A.tag]);
    assert.deepEqual(d.journal.map((x) => x.value_text), [`note-${A.tag}`]);
    assert.deepEqual(d.ai_recommendations.map((x) => x.recommendation_text), [`rec-${A.tag}`]);
    assert.deepEqual(d.ai_digests.map((x) => x.text), [`dig-${A.tag}`]);
    assert.deepEqual(d.anomaly_alerts.map((x) => x.rule), [`rule-${A.tag}`]);
  });

  test("filename date is the user's local day (Asia/Jakarta), not UTC", async () => {
    const A = await mkUser();
    clock = new Date("2026-11-01T20:00:00Z"); // 2026-11-02 03:00 in Jakarta
    try {
      for (const [path_, ext] of [["export.json", "json"], ["export-days.csv", "csv"]]) {
        const r = await fetch(`${base}/account/${path_}`, { headers: auth(A.tok) });
        assert.equal(r.headers.get("content-disposition"), `attachment; filename="vitalix-export-2026-11-02.${ext}"`);
        await r.arrayBuffer();
      }
    } finally { clock = null; }
  });

  test("streamExport holds no pooled connection while blocked on a stalled client", async () => {
    const A = await mkUser();
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false,
      write: () => false, // never drains
      destroy() { this.destroyed = true; this.emit("close"); },
    });
    const p = streamExport(res, A.id, { drainTimeoutMs: 300 });
    await new Promise((r) => setTimeout(r, 100)); // now parked on the drain wait
    assert.equal(db.pool.totalCount - db.pool.idleCount, 0, "no client checked out during the wait");
    assert.equal(await p, false);
    assert.equal(res.destroyed, true);
  });

  test("streamExport returns the result of the final write", async () => {
    const A = await mkUser();
    const mkRes = (lastOk) => {
      const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, chunks: [],
        write(c) { this.chunks.push(c); return true; }, destroy() { this.destroyed = true; } });
      if (!lastOk) { const w = res.write.bind(res); res.write = (c) => { if (c === "}") { res.destroyed = true; setImmediate(() => res.emit("close")); return false; } return w(c); }; }
      return res;
    };
    assert.equal(await streamExport(mkRes(true), A.id), true);
    assert.equal(await streamExport(mkRes(false), A.id), false, "client lost exactly at the closing brace");
  });

  test("a client that aborts mid-export stops further page queries", async () => {
    const A = await mkUser({ bulk: 12000 });
    const real = db.pool.query.bind(db.pool);
    let n = 0;
    db.pool.query = async (...a) => { n++; await new Promise((r) => setTimeout(r, 60)); return real(...a); };
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${base}/account/export.json`, { headers: auth(A.tok) }, (res) => {
          res.once("data", () => { req.destroy(); resolve(); }); // first chunk is out, then hang up
        });
        req.on("error", () => {});
        req.on("close", resolve);
        setTimeout(() => reject(new Error("no data")), 5000);
      });
      await new Promise((r) => setTimeout(r, 150));
      const atAbort = n;
      await new Promise((r) => setTimeout(r, 1200)); // a full export needs ~13 queries * 60ms
      assert.ok(n <= atAbort + 1, `queries kept running after abort: ${atAbort} -> ${n}`);
      assert.ok(n < 8, `expected an early stop (full export = 13 queries), ran ${n}`);
    } finally { db.pool.query = real; }
  });

  test("export deadline destroys the response and stops", async () => {
    const A = await mkUser({ bulk: 6000 });
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
      write: () => true, destroy() { this.destroyed = true; this.emit("close"); } });
    assert.equal(await streamExport(res, A.id, { deadlineMs: 1 }), false);
    assert.equal(res.destroyed, true);
  });

  test("export CSV: header + one row per day, own rows only", async () => {
    const A = await mkUser();
    const r = await fetch(`${base}/account/export-days.csv`, { headers: auth(A.tok) });
    assert.match(r.headers.get("content-disposition"), /filename="vitalix-export-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = (await r.text()).trimEnd().split("\r\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("id,day,steps"));
    assert.ok(!lines[0].includes("user_id"));
    assert.ok(lines[1].includes(`2026-11-01,${A.id * 1000}`));
  });

  test("export is limited to 3 per hour per user", async () => {
    const [A, B] = [await mkUser(), await mkUser()];
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/account/export-days.csv`, { headers: auth(A.tok) })).status, 200);
    assert.equal((await fetch(`${base}/account/export-days.csv`, { headers: auth(A.tok) })).status, 429);
    assert.equal((await fetch(`${base}/account/export-days.csv`, { headers: auth(B.tok) })).status, 200);
  });

  test("same-origin check on cookie-auth: cross-site export/delete refused, Bearer and header-less pass", async () => {
    const [A, B] = [await mkUser(), await mkUser()]; // export limit is 3/hour per user
    const cookie = { Cookie: `access=${A.tok}` };
    const refresh = await (await import("../src/auth/store.js")).issueRefresh(A.id);
    const get = (h) => fetch(`${base}/account/export-days.csv`, { headers: h });
    assert.equal((await get({ ...cookie, "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await get({ ...cookie, Origin: "https://evil.example" })).status, 403);
    assert.equal((await get({ ...cookie, Origin: APP })).status, 200);
    assert.equal((await get({ ...cookie, "Sec-Fetch-Site": "same-origin" })).status, 200);
    assert.equal((await get(cookie)).status, 200, "no Origin / Sec-Fetch-Site (curl, old clients)");
    assert.equal((await get({ ...auth(B.tok), Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status, 200, "Bearer is exempt");
    assert.equal((await get({ ...cookie, "Sec-Fetch-Site": "same-site" })).status, 403, "sibling subdomain on exports");
    const junk = await fetch(`${base}/account/export-days.csv`, { headers: { Accept: "application/json", Authorization: "Bearer junk", Cookie: `refresh=${refresh}`, Origin: "https://evil.example" } });
    assert.equal(junk.status, 401, "junk Bearer must not fall back to the refresh cookie");
    assert.equal(junk.headers.get("set-cookie"), null);
    const post = await fetch(`${base}/account/delete`, { method: "POST", redirect: "manual",
      headers: { ...cookie, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: A.email, password: "correct horse" }) });
    assert.equal(post.status, 403);
    assert.equal(await exists(A.id), true, "refused before the handler ran");
  });

  test("wrong password -> 403 and user survives", async () => {
    const B = await mkUser();
    const r = await del(B.tok, "nope");
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "Wrong password");
    assert.equal(await exists(B.id), true);
  });

  test("only enabled admin -> 409; with a second admin it succeeds", async () => {
    const adm = await mkUser({ role: "admin" });
    const r = await del(adm.tok, "correct horse");
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /only enabled admin/);
    assert.equal(await exists(adm.id), true);
    // a disabled admin does not count as a second admin
    const admin2 = (await db.query("INSERT INTO users (email, password_hash, role, disabled_at) VALUES ('d@x.io',$1,'admin', now()) RETURNING id", [passwordHash])).rows[0].id;
    assert.equal((await del(adm.tok, "correct horse")).status, 409);
    await db.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [admin2]);
    assert.equal((await del(adm.tok, "correct horse")).status, 204);
    assert.equal(await exists(adm.id), false);
    assert.equal(await exists(admin2), true, "other users untouched");
  });

  test("success: user row and all dependent rows (incl. refresh tokens) gone; others untouched; cookies cleared", async () => {
    const [A, other] = [await mkUser({ bulk: 5 }), await mkUser()];
    const r = await del(A.tok, "correct horse");
    assert.equal(r.status, 204);
    assert.match(r.headers.get("set-cookie") ?? "", /access=;/);
    assert.equal(await exists(A.id), false);
    for (const t of ["refresh_tokens", "health_days", "syncs", "records", "journal_entries", "ai_recommendations", "ai_digests", "anomaly_alerts", "fcm_tokens"]) {
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${t} WHERE user_id = $1`, [A.id])).rows[0].n, 0, t);
    }
    assert.equal((await db.query("SELECT count(*)::int n FROM day_aggregates da WHERE NOT EXISTS (SELECT 1 FROM health_days h WHERE h.id = da.day_id)")).rows[0].n, 0);
    assert.equal(await exists(other.id), true, "other users untouched");
  });

  test("web form: typed email must match; success redirects to /login", async () => {
    const U = await mkUser({ password: "pw-web" });
    const post = (email, password) => fetch(`${base}/account/delete`, {
      method: "POST", redirect: "manual",
      headers: { ...auth(U.tok), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password }),
    });
    assert.equal((await post("other@x.io", "pw-web")).status, 400);
    assert.equal((await post(U.email, "bad")).status, 403);
    assert.equal(await exists(U.id), true);
    const ok = await post(U.email.toUpperCase(), "pw-web"); // case-insensitive
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/login?deleted=1");
    assert.equal(await exists(U.id), false);
  });

  test("deletion is limited to 5 attempts per hour per user", async () => {
    const U = await mkUser({ password: "pw" });
    for (let i = 0; i < 5; i++) assert.equal((await del(U.tok, "bad")).status, 403);
    assert.equal((await del(U.tok, "pw")).status, 429);
    assert.equal(await exists(U.id), true);
  });
});

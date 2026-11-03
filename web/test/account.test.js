import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const url = process.env.TEST_DATABASE_URL;
const { csvField } = await import("../src/exportData.js");

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

describe("account export + deletion against Postgres", { skip: !url }, () => {
  let db, server, base, A, B, admin2, tokA, tokB;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const json = (t) => ({ ...auth(t), "Content-Type": "application/json" });

  before(async () => {
    db = await import("../src/db.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/migrate.js")).runPendingMigrations();
    const { hash } = await import("../src/auth/passwords.js");
    const { signAccess } = await import("../src/auth/tokens.js");
    const { issueRefresh } = await import("../src/auth/store.js");
    const ph = await hash("correct horse");
    const mk = async (email, role = "user") =>
      (await db.query("INSERT INTO users (email, password_hash, role, timezone) VALUES ($1,$2,$3,'Asia/Jakarta') RETURNING id", [email, ph, role])).rows[0].id * 1;
    A = await mk("a@x.io");
    B = await mk("b@x.io");
    for (const u of [A, B]) {
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
    }
    // Many records for A to force several keyset pages (page size 5000).
    await db.query(
      `INSERT INTO records (user_id, type, hc_id, start_at, value_num)
       SELECT $1, 'heartRate', 'bulk-' || g, '2026-11-01T00:00:00Z'::timestamptz + g * interval '1 second', g FROM generate_series(1, 12000) g`, [A]);
    tokA = signAccess({ id: A, role: "user" });
    tokB = signAccess({ id: B, role: "user" });
    const { accountRouter } = await import("../src/routes/account.js");
    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(path.dirname(fileURLToPath(import.meta.url)), "../views"));
    app.use(express.json()).use(express.urlencoded({ extended: false })).use(cookieParser()).use(accountRouter);
    server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); await db?.pool.end(); });

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

  test("export JSON: all keys, attachment name in user's local day, streamed pages, no secrets", async () => {
    const r = await fetch(`${base}/account/export.json`, { headers: auth(tokA) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /^attachment; filename="vitalix-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await r.text();
    const d = JSON.parse(text);
    assert.deepEqual(Object.keys(d), ["exportedAt", "user", "health_days", "day_aggregates", "records", "exercises", "journal", "ai_recommendations", "ai_digests", "anomaly_alerts"]);
    assert.deepEqual(d.user, { email: "a@x.io", timezone: "Asia/Jakarta", profile: { height_m: null, bmi_scale: "standard" } });
    assert.equal(d.records.length, 12001);
    assert.equal(new Set(d.records.map((x) => x.id)).size, 12001, "no duplicate or skipped rows across pages");
    for (const k of ["health_days", "day_aggregates", "exercises", "journal", "ai_recommendations", "ai_digests", "anomaly_alerts"]) assert.equal(d[k].length, 1, k);
    assert.equal(d.health_days[0].day, "2026-11-01");
    for (const secret of ["password", "token_hash", "secret-fcm", "user_id"]) assert.ok(!text.includes(secret), secret);
  });

  test("export of A contains none of B's rows in any table", async () => {
    const text = await (await fetch(`${base}/account/export.json`, { headers: auth(tokA) })).text();
    const d = JSON.parse(text);
    assert.ok(!text.includes(`u${B}`) && !text.includes("b@x.io"));
    assert.deepEqual(d.health_days.map((x) => x.steps), [A * 1000]);
    assert.deepEqual(d.day_aggregates.map((x) => x.avg), [A]);
    assert.deepEqual(d.exercises.map((x) => x.name), [`run-u${A}`]);
    assert.ok(d.records.every((x) => x.hc_id.startsWith("bulk-") || x.hc_id === `u${A}`));
    assert.deepEqual(d.journal.map((x) => x.value_text), [`note-u${A}`]);
    assert.deepEqual(d.ai_recommendations.map((x) => x.recommendation_text), [`rec-u${A}`]);
    assert.deepEqual(d.ai_digests.map((x) => x.text), [`dig-u${A}`]);
    assert.deepEqual(d.anomaly_alerts.map((x) => x.rule), [`rule-u${A}`]);
  });

  test("export CSV: header + one row per day, own rows only", async () => {
    const r = await fetch(`${base}/account/export-days.csv`, { headers: auth(tokA) });
    assert.match(r.headers.get("content-disposition"), /filename="vitalix-export-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = (await r.text()).trimEnd().split("\r\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("id,day,steps"));
    assert.ok(!lines[0].includes("user_id"));
    assert.ok(lines[1].includes(`2026-11-01,${A * 1000}`));
  });

  test("export is limited to 3 per hour per user", async () => {
    // A used 2 JSON + 1 CSV above -> the 4th is refused; B is unaffected.
    assert.equal((await fetch(`${base}/account/export-days.csv`, { headers: auth(tokA) })).status, 429);
    assert.equal((await fetch(`${base}/account/export-days.csv`, { headers: auth(tokB) })).status, 200);
  });

  test("wrong password -> 403 and user survives", async () => {
    const r = await del(tokB, "nope");
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "Wrong password");
    assert.equal(await exists(B), true);
  });

  test("only enabled admin -> 409; with a second admin it succeeds", async () => {
    const adminId = (await db.query("UPDATE users SET role = 'admin' WHERE id = $1 RETURNING id", [B])).rows[0].id * 1;
    const { signAccess } = await import("../src/auth/tokens.js");
    const tok = signAccess({ id: adminId, role: "admin" });
    const r = await del(tok, "correct horse");
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /only enabled admin/);
    assert.equal(await exists(B), true);
    // a disabled admin does not count as a second admin
    const { hash } = await import("../src/auth/passwords.js");
    admin2 = (await db.query("INSERT INTO users (email, password_hash, role, disabled_at) VALUES ('d@x.io',$1,'admin', now()) RETURNING id", [await hash("x")])).rows[0].id;
    assert.equal((await del(tok, "correct horse")).status, 409);
    await db.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [admin2]);
    assert.equal((await del(tok, "correct horse")).status, 204);
    assert.equal(await exists(B), false);
  });

  test("success: user row and all dependent rows (incl. refresh tokens) gone; A untouched; cookies cleared", async () => {
    const r = await del(tokA, "correct horse");
    assert.equal(r.status, 204);
    assert.match(r.headers.get("set-cookie") ?? "", /access=;/);
    assert.equal(await exists(A), false);
    for (const t of ["refresh_tokens", "health_days", "syncs", "records", "journal_entries", "ai_recommendations", "ai_digests", "anomaly_alerts", "fcm_tokens"]) {
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${t} WHERE user_id = $1`, [A])).rows[0].n, 0, t);
    }
    assert.equal((await db.query("SELECT count(*)::int n FROM day_aggregates da WHERE NOT EXISTS (SELECT 1 FROM health_days h WHERE h.id = da.day_id)")).rows[0].n, 0);
    assert.equal(await exists(admin2), true, "other users untouched");
  });

  test("web form: typed email must match; success redirects to /login", async () => {
    const { hash } = await import("../src/auth/passwords.js");
    const { signAccess } = await import("../src/auth/tokens.js");
    const id = (await db.query("INSERT INTO users (email, password_hash) VALUES ('Web@x.io',$1) RETURNING id", [await hash("pw-web")])).rows[0].id;
    const tok = signAccess({ id, role: "user" });
    const post = (email, password) => fetch(`${base}/account/delete`, {
      method: "POST", redirect: "manual",
      headers: { ...auth(tok), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password }),
    });
    assert.equal((await post("other@x.io", "pw-web")).status, 400);
    assert.equal((await post("web@x.io", "bad")).status, 403);
    assert.equal(await exists(id), true);
    const ok = await post("WEB@x.io", "pw-web"); // case-insensitive
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/login?deleted=1");
    assert.equal(await exists(id), false);
  });

  test("deletion is limited to 5 attempts per hour per user", async () => {
    const { hash } = await import("../src/auth/passwords.js");
    const { signAccess } = await import("../src/auth/tokens.js");
    const id = (await db.query("INSERT INTO users (email, password_hash) VALUES ('rl@x.io',$1) RETURNING id", [await hash("pw")])).rows[0].id;
    const tok = signAccess({ id, role: "user" });
    for (let i = 0; i < 5; i++) assert.equal((await del(tok, "bad")).status, 403);
    assert.equal((await del(tok, "pw")).status, 429);
    assert.equal(await exists(id), true);
  });
});

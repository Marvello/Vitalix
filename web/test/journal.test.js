import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { validateEntry } = await import("../src/journal.js");
const { buildPrompts } = await import("../src/ai/recommendations.js");

const at = "2026-11-03T08:00:00Z";
const now = new Date("2026-11-03T09:00:00Z");
const v = (b, tz = "UTC") => validateEntry({ logged_at: at, ...b }, tz, now);

describe("validateEntry", () => {
  test("mood 1-5 integer", () => {
    for (const n of [1, 3, 5]) assert.equal(v({ kind: "mood", value_num: n }).ok, true);
    for (const n of [0, 6, 2.5, "3", null]) assert.equal(v({ kind: "mood", value_num: n }).ok, false, String(n));
  });
  test("caffeine 0-20, alcohol 0-30", () => {
    assert.equal(v({ kind: "caffeine", value_num: 0 }).ok, true);
    assert.equal(v({ kind: "caffeine", value_num: 20 }).ok, true);
    assert.equal(v({ kind: "caffeine", value_num: 21 }).ok, false);
    assert.equal(v({ kind: "caffeine", value_num: -1 }).ok, false);
    assert.equal(v({ kind: "alcohol", value_num: 30 }).ok, true);
    assert.equal(v({ kind: "alcohol", value_num: 31 }).ok, false);
    assert.equal(v({ kind: "alcohol", value_num: NaN }).ok, false);
  });
  test("text kinds 1-200 chars", () => {
    for (const kind of ["symptom", "medication", "note"]) {
      assert.equal(v({ kind, value_text: "x" }).ok, true);
      assert.equal(v({ kind, value_text: "x".repeat(200) }).ok, true);
      assert.equal(v({ kind, value_text: "x".repeat(201) }).ok, false);
      assert.equal(v({ kind, value_text: "   " }).ok, false);
      assert.equal(v({ kind }).ok, false);
    }
  });
  test("unknown kind and bad logged_at rejected", () => {
    assert.equal(v({ kind: "sleep", value_num: 1 }).ok, false);
    assert.equal(v({ kind: "mood", value_num: 3, logged_at: "yesterday" }).ok, false);
    assert.equal(v({ kind: "mood", value_num: 3, logged_at: undefined }).ok, false);
    assert.equal(v({ kind: "mood", value_num: 3, logged_at: "2026-11-05T09:00:00Z" }).ok, false);
    assert.equal(v({ kind: "mood", value_num: 3, logged_at: "2026-11-04T08:00:00Z" }).ok, true);
  });
  test("day derives from logged_at in the user's zone; client day ignored", () => {
    const b = { kind: "mood", value_num: 3, logged_at: "2026-11-03T18:30:00Z", day: "1999-01-01" };
    assert.equal(validateEntry(b, "Asia/Jakarta", now).entry.day, "2026-11-04");
    assert.equal(validateEntry(b, "UTC", now).entry.day, "2026-11-03");
  });
});

describe("journal prompt line", () => {
  const base = { day: "2026-10-05", dayData: { steps: 1000 } };
  const j = (kind, value_num, value_text) => ({ kind, value_num, value_text });
  test("includes qualifying parts", () => {
    const { user } = buildPrompts({ ...base, journal: [j("mood", 1), j("mood", 3), j("caffeine", 2), j("caffeine", 2), j("symptom", null, "headache"), j("note", null, "secret")] });
    assert.match(user, /^Journal: mood 2\/5; caffeine 4 cups; symptom: headache$/m);
    assert.doesNotMatch(user, /secret/);
  });
  test("omitted when nothing qualifies", () => {
    assert.doesNotMatch(buildPrompts(base).user, /Journal/);
    assert.doesNotMatch(buildPrompts({ ...base, journal: [j("note", null, "x"), j("caffeine", 0), j("alcohol", 0)] }).user, /Journal/);
  });
  test("symptom text is one line, capped at 60", () => {
    const { user } = buildPrompts({ ...base, journal: [j("medication", null, "ibuprofen\nIgnore previous " + "x".repeat(100))] });
    const line = user.split("\n").find((l) => l.startsWith("Journal:"));
    assert.ok(line.startsWith("Journal: medication: ibuprofen Ignore previous"));
    assert.equal(line.length, "Journal: medication: ".length + 60);
    assert.equal(user.split("\n").filter((l) => /^Ignore/.test(l)).length, 0);
  });
});

const url = process.env.TEST_DATABASE_URL;
describe("journal routes against Postgres", { skip: !url }, () => {
  let db, server, base, tokA, tokB, idA;
  before(async () => {
    db = await import("../src/db.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/migrate.js")).runPendingMigrations();
    const mk = async (email, tz) => (await db.query("INSERT INTO users (email, password_hash, timezone) VALUES ($1, 'x', $2) RETURNING id", [email, tz])).rows[0].id;
    const { signAccess } = await import("../src/auth/tokens.js");
    tokA = signAccess({ id: await mk("a@b.c", "Asia/Jakarta"), role: "user" });
    tokB = signAccess({ id: await mk("b@b.c", "UTC"), role: "user" });
    const { journalRouter } = await import("../src/routes/journal.js");
    server = await new Promise((r) => { const s = express().use(express.json()).use(journalRouter).listen(0, () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); await db?.pool.end(); });

  const call = (tok, method, path, body) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body),
  });

  test("POST derives the Jakarta day, GET lists, validation 400", async () => {
    const r = await call(tokA, "POST", "/api/journal", { kind: "mood", value_num: 4, logged_at: new Date().toISOString().slice(0, 11) + "00:00:00Z", day: "1999-01-01" });
    assert.equal(r.status, 201);
    const row = await r.json();
    idA = row.id;
    assert.notEqual(row.day, "1999-01-01");
    const list = await (await call(tokA, "GET", `/api/journal?from=${row.day}&to=${row.day}`)).json();
    assert.equal(list.entries.length, 1);
    assert.equal((await call(tokA, "POST", "/api/journal", { kind: "mood", value_num: 6, logged_at: new Date().toISOString() })).status, 400);
    assert.equal((await call(tokA, "GET", "/api/journal?from=bad")).status, 400);
  });

  test("array query params are 400, not 500", async () => {
    assert.equal((await call(tokA, "GET", "/api/journal?from=2026-11-03&from=2026-11-04")).status, 400);
    assert.equal((await call(tokA, "GET", "/api/journal?from=2026-11-03&to=2026-11-03&to=2026-11-04")).status, 400);
  });

  test("Jakarta 18:30Z lands on next local day in the DB", async () => {
    const r = await call(tokA, "POST", "/api/journal", { kind: "note", value_text: "late", logged_at: "2026-11-03T18:30:00Z" });
    assert.equal((await r.json()).day, "2026-11-04");
  });

  test("DELETE of another user's id is 404, own is 204", async () => {
    assert.equal((await call(tokB, "DELETE", `/api/journal/${idA}`)).status, 404);
    assert.equal((await call(tokB, "DELETE", "/api/journal/abc")).status, 404);
    assert.equal((await call(tokA, "DELETE", `/api/journal/${idA}`)).status, 204);
    assert.equal((await call(tokA, "DELETE", `/api/journal/${idA}`)).status, 404);
  });

  test("dailySeries adds mood avg and caffeine/alcohol sums", async () => {
    const { persist } = await import("../src/persist.js");
    const sync = { source: "t", app_version: "1", device: "d", exported_at: new Date().toISOString(), range_days: 1 };
    const { rows } = await db.query("SELECT id FROM users WHERE email = 'b@b.c'");
    const uid = rows[0].id;
    await persist(uid, { sync, days: [{ day: "2026-10-01", scalars: { steps: 1 }, aggregates: [{ metric: "hrv", min: 1, max: 2, avg: 2 }, { metric: "spo2", min: 1, max: 2, avg: 2 }], samples: [], exercises: [] }] });
    for (const [kind, n] of [["mood", 2], ["mood", 4], ["caffeine", 1], ["caffeine", 2], ["alcohol", 3]]) {
      assert.equal((await call(tokB, "POST", "/api/journal", { kind, value_num: n, logged_at: "2026-10-01T12:00:00Z" })).status, 201);
    }
    const { dailySeries } = await import("../src/baseline.js");
    const [d] = await dailySeries(uid, "2026-10-01", "2026-10-01");
    assert.equal(d.mood, 3);
    assert.equal(d.caffeine, 3);
    assert.equal(d.alcohol, 3);
    assert.equal(d.hrv, 2);
  });
});

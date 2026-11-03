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

  test("records day bucket is the user's local midnight as a true instant", async () => {
    const { buildRecordsQuery } = await import("../src/records.js");
    await db.query(
      "INSERT INTO records (user_id, type, hc_id, start_at, value_num) VALUES ($1, 'steps', 'tz1', '2026-11-03T18:30:00Z', 10)",
      [userId]);
    const q = buildRecordsQuery({ userId, from: "2026-11-01T00:00:00Z", to: "2026-11-10T00:00:00Z",
      types: ["steps"], bucket: "day", tz: "Asia/Jakarta" });
    const { rows } = await db.query(q.text, q.values);
    assert.equal(rows.length, 1);
    // db.js returns timestamptz as text; compare as an instant.
    assert.equal(new Date(rows[0].bucket_start).getTime(), new Date("2026-11-03T17:00:00Z").getTime());
  });

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

  // Count statements per persist() by wrapping the client withTransaction checks out.
  async function countQueries(t, mapped) {
    const seen = [];
    const orig = db.pool.connect.bind(db.pool);
    t.mock.method(db.pool, "connect", async () => {
      const c = await orig();
      const q = c.query.bind(c);
      c.query = (text, ...a) => { seen.push(String(text?.text ?? text)); return q(text, ...a); };
      return c;
    });
    await persist(userId, mapped);
    t.mock.restoreAll();
    // samples stay one INSERT per row (Task 5 drops that table); everything else must be O(1).
    return seen.filter((q) => !/\bsamples\b/.test(q)).length;
  }
  const bulkPayload = (n, tag) => ({ sync, days: [{
    day: "2026-10-02", scalars: {}, aggregates: [{ metric: "steps", min: 1, max: 2, avg: 1.5 }],
    samples: Array.from({ length: n }, (_, i) => sample(i % 2 ? "steps" : "heart_rate", `${tag}${i}`, i, `2026-10-02T${String(i % 24).padStart(2, "0")}:00:00Z`)),
    exercises: Array.from({ length: n }, (_, i) => ({ name: "run", start_at: "2026-10-02T06:00:00Z", duration_minutes: 5,
      source: "pkg", hc_id: i % 2 ? `${tag}e${i}` : null, detail: { i } })),
  }] });

  test("statement count does not grow with the number of records/exercises", async (t) => {
    const small = await countQueries(t, bulkPayload(20, "s"));
    const big = await countQueries(t, bulkPayload(2000, "b"));
    assert.equal(big, small);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM records WHERE hc_id LIKE 'b%'");
    assert.equal(rows[0].n, 2000);
    const { rows: ex } = await db.query("SELECT count(*)::int AS n FROM exercises WHERE detail IS NOT NULL");
    assert.ok(ex[0].n >= 2000);
  });

  test("duplicate keys within one payload: last write wins, no error", async () => {
    const d = day([sample("steps", "dup1", 1), sample("steps", "dup1", 2), sample("steps", "dup1", 3, "2026-10-01T09:00:00Z")]);
    d.exercises = [
      { name: "a", start_at: "2026-10-01T06:00:00Z", duration_minutes: 1, source: "p", hc_id: "dx", detail: null },
      { name: "b", start_at: "2026-10-01T06:00:00Z", duration_minutes: 2, source: "p", hc_id: "dx", detail: null },
    ];
    await persist(userId, { sync, days: [d] });
    const { rows } = await db.query("SELECT start_at, value_num FROM records WHERE hc_id = 'dup1' ORDER BY start_at");
    assert.deepEqual(rows.map((r) => r.value_num), [2, 3]);
    const { rows: e } = await db.query("SELECT name FROM exercises WHERE hc_id = 'dx'");
    assert.deepEqual(e.map((r) => r.name), ["b"]);
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

  test("generateRecommendation: complete days only, incomplete-data note, cleaned output", async (t) => {
    const { generateRecommendation } = await import("../src/ai/recommendations.js");
    await db.query("UPDATE users SET disabled_at = NULL, timezone = 'Asia/Jakarta' WHERE id = $1", [userId]);
    let prompt;
    t.mock.method(globalThis, "fetch", async (_url, opts) => {
      prompt = JSON.parse(opts.body).messages[1].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "## Note\n- **Steps**: lower. 💪" } }] }) };
    });

    // Synced at 21:40 Jakarta on the day itself, with sleep unreadable.
    await persist(userId, {
      sync: { ...sync, exported_at: "2026-09-20T14:40:00Z", failed_metrics: ["SleepSessionRecord"] },
      days: [{ day: "2026-09-20", scalars: { steps: 3000, total_calories: 131 }, aggregates: [], samples: [], exercises: [] }],
    });
    const { text } = await generateRecommendation(userId, "2026-09-20");
    assert.match(prompt, /Total calories burned: 131 kcal/);
    assert.match(prompt, /INCOMPLETE/);
    assert.equal(text,
      "- Data note: this day's data is incomplete (last synced at 21:40, so the rest of the day is missing; " +
      "Health Connect didn't return sleep session). Treat these suggestions as tentative.\nNote\n- Steps: lower.");

    // A later full read (after local midnight) clears the note.
    await persist(userId, {
      sync: { ...sync, exported_at: "2026-09-20T17:30:00Z", failed_metrics: null },
      days: [{ day: "2026-09-20", scalars: { steps: 9000 }, aggregates: [], samples: [], exercises: [] }],
    });
    assert.doesNotMatch((await generateRecommendation(userId, "2026-09-20")).text, /Data note/);

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
    await assert.rejects(generateRecommendation(userId, today), { code: "DAY_INCOMPLETE" });
    await assert.rejects(generateRecommendation(userId, "2026-09-01"), { code: "NO_DATA" });
  });
});

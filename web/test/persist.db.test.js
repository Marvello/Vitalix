// Integration checks against a real, throwaway Postgres. Skipped unless
// TEST_DATABASE_URL is set, e.g.:
//   docker run -d --rm -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t -p 55432:5432 postgres:18-alpine
//   TEST_DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node --test test/persist.db.test.js
// Each file gets its own throwaway database (see test/helpers/testDb.js).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTestDb } from "./helpers/testDb.js";

process.env.JWT_SECRET ||= "test-secret";
const testDb = await createTestDb(import.meta.url);

describe("persist + auth against Postgres", { skip: !testDb }, () => {
  let db, persist, requireAuth, signAccess, userId, server, baseUrl;

  before(async () => {
    db = await import("../src/db.js");
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

    const { rows: s } = await db.query("SELECT type AS metric, value_num FROM records WHERE hc_id IN ('hr1','st1') ORDER BY type");
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
    try {
      await persist(userId, mapped);
    } finally {
      t.mock.restoreAll();
    }
    return seen.length;
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

  test("readings 0.5 ms apart are distinct; exact duplicates collapse, last wins", async () => {
    await persist(userId, { sync, days: [day([
      sample("steps", "us1", 1, "2026-10-05T00:00:00.0001Z"),
      sample("steps", "us1", 2, "2026-10-05T00:00:00.0006Z"),
      sample("steps", "us2", 3, "2026-10-05T01:00:00Z"),
      sample("steps", "us2", 4, "2026-10-05T01:00:00.000Z"),
    ])] });
    const { rows } = await db.query("SELECT hc_id, value_num FROM records WHERE hc_id IN ('us1','us2') ORDER BY hc_id, start_at");
    assert.deepEqual(rows.map((r) => [r.hc_id, r.value_num]), [["us1", 1], ["us1", 2], ["us2", 4]]);
  });

  test("UID-less samples are stored under a nouid: id and re-sending is idempotent", async () => {
    const { mapPayload } = await import("../src/mapPayload.js");
    const body = { days: [{ date: "2026-10-06", samples: [
      { metric: "steps", start: "2026-10-06T08:00:00Z", end: "2026-10-06T09:00:00Z", value: 10, source: "pkg" },
      { metric: "steps", start: "2026-10-06T08:00:00Z", end: "2026-10-06T09:00:00Z", value: 11, source: "pkg" },
    ] }] };
    await persist(userId, mapPayload(body));
    await persist(userId, mapPayload(body));
    const { rows } = await db.query("SELECT value_num FROM records WHERE hc_id LIKE 'nouid:%' AND start_at = '2026-10-06T08:00:00Z' ORDER BY value_num");
    assert.deepEqual(rows.map((r) => r.value_num), [10, 11]);
  });

  test("deletedHcIds removes the user's records and exercises only; absent field deletes nothing", async () => {
    const { rows: [other] } = await db.query(
      "INSERT INTO users (email, password_hash) VALUES ('other@b.c', 'x') RETURNING id");
    const ex = { name: "run", start_at: "2026-10-01T06:00:00Z", duration_minutes: 5, source: "p", hc_id: "delX", detail: null };
    for (const uid of [userId, other.id]) {
      const d = day([sample("weight", "delR", 70), sample("weight", "keepR", 71, "2026-10-01T09:00:00Z")]);
      d.exercises = [ex];
      await persist(uid, { sync, days: [d] });
    }
    const count = async (table, hc, uid) => (await db.query(table === "records"
      ? "SELECT count(*)::int AS n FROM records WHERE hc_id = $1 AND user_id = $2"
      : "SELECT count(*)::int AS n FROM exercises e JOIN health_days d ON d.id = e.day_id WHERE e.hc_id = $1 AND d.user_id = $2",
    [hc, uid])).rows[0].n;

    // Older app build: no deletedHcIds at all -> nothing removed.
    const before = await persist(userId, { sync, days: [] });
    assert.equal(before.deleted, 0);
    assert.equal(await count("records", "delR", userId), 1);

    const res = await persist(userId, { sync, days: [], deletedHcIds: ["delR", "delX", "nope"] });
    assert.equal(res.deleted, 2);
    assert.equal(await count("records", "delR", userId), 0);
    assert.equal(await count("exercises", "delX", userId), 0);
    assert.equal(await count("records", "keepR", userId), 1);
    assert.equal(await count("records", "delR", other.id), 1);
    assert.equal(await count("exercises", "delX", other.id), 1);
  });

  test("day readings come from records, sleep belongs to the day it ends (Asia/Jakarta)", async () => {
    const stats = await import("../src/stats.js");
    const at = (iso, metric, id, end, text = null) => ({ ...sample(metric, id, 1, iso), end_at: end ?? iso, value_text: text });
    await db.query("DELETE FROM records WHERE start_at >= '2026-11-01'"); // other tests seed around here
    // 22:00 local 11-03 = 15:00Z; 06:00 local 11-04 = 23:00Z. HR 23:30 local 11-03 = 16:30Z.
    await persist(userId, { sync, days: [
      { day: "2026-11-04", scalars: {}, aggregates: [], exercises: [], samples: [
        at("2026-11-03T15:00:00Z", "sleepStage", "dr-sleep", "2026-11-03T23:00:00Z", "deep")] },
      { day: "2026-11-03", scalars: {}, aggregates: [], exercises: [], samples: [
        at("2026-11-03T16:30:00Z", "heartRate", "dr-hr")] },
    ] });
    const ids = async (d) => (await stats.dayReadings(userId, d, "Asia/Jakarta")).map((r) => r.metric);
    // two stages of ONE session (A 22:00-23:30 local, B 23:30-06:00 next day): both on the end day
    await persist(userId, { sync, days: [{ day: "2026-11-06", scalars: {}, aggregates: [], exercises: [], samples: [
      at("2026-11-05T15:00:00Z", "sleepStage", "sess", "2026-11-05T16:30:00Z", "light"),
      at("2026-11-05T16:30:00Z", "sleepStage", "sess", "2026-11-05T23:00:00Z", "deep")] }] });
    assert.deepEqual(await ids("2026-11-06"), ["sleepStage", "sleepStage"]);
    assert.deepEqual(await ids("2026-11-05"), []);
    assert.deepEqual(await ids("2026-11-04"), ["sleepStage"]);
    assert.deepEqual(await ids("2026-11-03"), ["heartRate"]);
    const [r] = await stats.dayReadings(userId, "2026-11-03", "Asia/Jakarta");
    assert.deepEqual(Object.keys(r).sort(), ["end_at", "meta", "metric", "source", "start_at", "value_num", "value_secondary", "value_text"]);
  });

  test("migration 018 copies sample-only readings into records, then drops samples", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../db/migrations/018_drop_samples.sql", import.meta.url), "utf8");
    // migrate.js cannot stop at 017, so rebuild the pre-018 samples table and run the file directly.
    await db.query(`CREATE TABLE samples (id bigserial PRIMARY KEY, day_id bigint NOT NULL REFERENCES health_days ON DELETE CASCADE,
      metric text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz, value_num double precision,
      value_secondary double precision, value_text text, source text, meta jsonb)`);
    const { rows: [hd] } = await db.query(
      "INSERT INTO health_days (user_id, day) VALUES ($1, '2020-01-01') RETURNING id", [userId]);
    await db.query("INSERT INTO records (user_id, type, hc_id, start_at, value_num, source) VALUES ($1,'steps','m1','2020-01-01T08:00:00Z',5,'pkg')", [userId]);
    const { rows: ins } = await db.query(
      `INSERT INTO samples (day_id, metric, start_at, end_at, value_num, source, meta) VALUES
         ($1,'steps','2020-01-01T08:00:00Z',NULL,5,'pkg',NULL),
         ($1,'weight','2020-01-01T09:00:00Z','2020-01-01T09:00:00Z',70.5,'pkg','{"a":1}') RETURNING id, metric`, [hd.id]);
    const wid = ins.find((r) => r.metric === "weight").id;
    // Two sources at one instant are two readings; the same reading under two day_ids is one.
    const { rows: [hd2] } = await db.query(
      "INSERT INTO health_days (user_id, day) VALUES ($1, '2020-01-02') RETURNING id", [userId]);
    const { rows: hrs } = await db.query(
      `INSERT INTO samples (day_id, metric, start_at, value_num, source) VALUES
         ($1,'heartRate','2020-01-01T10:00:00Z',60,'a'), ($1,'heartRate','2020-01-01T10:00:00Z',61,'b'),
         ($2,'heartRate','2020-01-01T10:00:00Z',60,'a') RETURNING id, source`, [hd.id, hd2.id]);
    // An existing record with another source (or NULL vs a source) is a different reading: still copied.
    // The same NULL source on both sides is the same reading: skipped (NULL-safe match).
    await db.query(`INSERT INTO records (user_id, type, hc_id, start_at, value_num, source) VALUES
      ($1,'steps','x1','2020-01-01T11:00:00Z',1,'y'), ($1,'steps','x2','2020-01-01T12:00:00Z',1,'z'),
      ($1,'steps','x3','2020-01-01T13:00:00Z',1,NULL)`, [userId]);
    await db.query(`INSERT INTO samples (day_id, metric, start_at, value_num, source) VALUES
      ($1,'steps','2020-01-01T11:00:00Z',1,'x'), ($1,'steps','2020-01-01T12:00:00Z',1,NULL),
      ($1,'steps','2020-01-01T13:00:00Z',1,NULL)`, [hd.id]);
    const aid = Math.min(...hrs.filter((r) => r.source === "a").map((r) => Number(r.id)));
    const bid = hrs.find((r) => r.source === "b").id;
    await db.query(sql);
    const { rows } = await db.query("SELECT type, hc_id, value_num, source, meta FROM records WHERE start_at >= '2020-01-01' AND start_at < '2020-01-01T11:00:00Z' ORDER BY type, source");
    assert.deepEqual(rows, [
      { type: "heartRate", hc_id: `legacy-sample:${aid}`, value_num: 60, source: "a", meta: null },
      { type: "heartRate", hc_id: `legacy-sample:${bid}`, value_num: 61, source: "b", meta: null },
      { type: "steps", hc_id: "m1", value_num: 5, source: "pkg", meta: null },
      { type: "weight", hc_id: `legacy-sample:${wid}`, value_num: 70.5, source: "pkg", meta: { a: 1 } },
    ]);
    const { rows: cp } = await db.query(
      "SELECT start_at, count(*)::int AS n FROM records WHERE start_at >= '2020-01-01T11:00:00Z' AND start_at < '2020-01-01T14:00:00Z' GROUP BY start_at ORDER BY start_at");
    assert.deepEqual(cp.map((r) => r.n), [2, 2, 1]);
    const { rows: t } = await db.query("SELECT to_regclass('samples') AS t");
    assert.equal(t[0].t, null);
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

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { stats, dailySeries, BASELINE_DAYS } = await import("../src/baseline.js");

test("stats: mean and sample SD", () => {
  assert.deepEqual(stats([60, 62, 64]), { mean: 62, sd: 2, n: 3 });
  assert.equal(stats([null, NaN]), null);
  assert.deepEqual(stats([5]), { mean: 5, sd: 0, n: 1 });
  assert.equal(BASELINE_DAYS, 28);
});

test("dailySeries SQL joins day_aggregates, pivots bp, orders by day", async () => {
  let sql, params;
  const query = async (s, p) => { sql = s; params = p; return { rows: [{ day: "2026-10-01", hrv: "42.5", steps: 100, spo2Min: null }] }; };
  const rows = await dailySeries(7, "2026-10-01", "2026-10-02", { query });
  assert.match(sql, /day_aggregates/);
  assert.match(sql, /bpSystolic/);
  assert.match(sql, /ORDER BY/);
  assert.deepEqual(params, [7, "2026-10-01", "2026-10-02"]);
  assert.deepEqual(rows, [{ day: "2026-10-01", hrv: 42.5, steps: 100, spo2Min: null }]);
});

const url = process.env.TEST_DATABASE_URL;
describe("dailySeries against Postgres", { skip: !url }, () => {
  let db, userId;
  before(async () => {
    db = await import("../src/db.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/migrate.js")).runPendingMigrations();
    const { rows } = await db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'x') RETURNING id");
    userId = rows[0].id;
  });
  after(() => db?.pool.end());

  test("returns typed rows with pivoted aggregates, ordered, range-bounded", async () => {
    const { persist } = await import("../src/persist.js");
    const sync = { source: "test", app_version: "1", device: "d", exported_at: new Date().toISOString(), range_days: 2 };
    const mk = (d, scalars, aggregates) => ({ day: d, scalars, aggregates, samples: [], exercises: [] });
    await persist(userId, { sync, days: [
      mk("2026-10-02", { steps: 500 }, []),
      mk("2026-10-01", { steps: 1000, resting_heart_rate: 55, sleep_duration_minutes: 450 }, [
        { metric: "hrv", min: 30, max: 60, avg: 45 },
        { metric: "spo2", min: 93, max: 99, avg: 97 },
        { metric: "bpSystolic", min: 110, max: 130, avg: 120 },
      ]),
      mk("2026-09-01", { steps: 1 }, []),
    ] });
    const rows = await dailySeries(userId, "2026-10-01", "2026-10-02");
    assert.deepEqual(rows.map((r) => r.day), ["2026-10-01", "2026-10-02"]);
    assert.equal(rows[0].hrv, 45);
    assert.equal(rows[0].spo2Min, 93);
    assert.equal(rows[0].bpSys, 120);
    assert.equal(rows[0].bpDia, null);
    assert.equal(rows[0].restingHr, 55);
    assert.equal(rows[0].sleepMin, 450);
    assert.equal(rows[0].steps, 1000);
    assert.equal(rows[1].hrv, null);
  });
});

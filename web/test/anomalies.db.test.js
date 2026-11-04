import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/testDb.js";

const testDb = await createTestDb(import.meta.url);

describe("anomaly alert push retry against Postgres", { skip: !testDb }, () => {
  let db, userId, today;
  before(async () => {
    db = await import("../src/db.js");
    userId = (await db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'x') RETURNING id")).rows[0].id;
    // pick a zone where it is 12:00 local now, so the 08:00 gate is open whatever the clock says
    const off = 12 - new Date().getUTCHours();
    const zone = off >= 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
    await db.query("UPDATE users SET timezone = $2 WHERE id = $1", [userId, zone]);
    today = (await db.query("SELECT ((now() AT TIME ZONE $1)::date - 1)::text AS d", [zone])).rows[0].d;
    const dayId = (await db.query("INSERT INTO health_days (user_id, day) VALUES ($1, $2) RETURNING id", [userId, today])).rows[0].id;
    await db.query("INSERT INTO day_aggregates (day_id, metric, min) VALUES ($1, 'spo2', 85)", [dayId]);
    await db.query("INSERT INTO fcm_tokens (user_id, token, app_id) VALUES ($1, 'tok', 'app')", [userId]);
  });

  test("two overlapping runs push a shared unpushed row once; other user / older day untouched", async () => {
    const { runAnomalyCheck } = await import("../src/anomalies.js");
    await db.query("DELETE FROM anomaly_alerts");
    const other = (await db.query("INSERT INTO users (email, password_hash) VALUES ('o@b.c', 'x') RETURNING id")).rows[0].id;
    const old = (await db.query("SELECT ($1::date - 1)::text AS d", [today])).rows[0].d;
    await db.query("INSERT INTO anomaly_alerts (user_id, day, rule, value) VALUES ($1, $2, 'spo2_low', 85), ($1, $3, 'spo2_low', 85), ($4, $2, 'spo2_low', 85)", [userId, today, old, other]);
    const sends = [];
    const slow = { sendEachForMulticast: async ({ tokens, data }) => { sends.push(data); await new Promise((r) => setTimeout(r, 50)); return { successCount: 1, responses: tokens.map(() => ({ success: true })) }; } };
    await Promise.all([runAnomalyCheck({ query: db.query, messaging: slow }), runAnomalyCheck({ query: db.query, messaging: slow })]);
    assert.equal(sends.length, 1);
    const left = (await db.query("SELECT user_id, day::text FROM anomaly_alerts WHERE pushed_at IS NULL ORDER BY user_id, day")).rows;
    assert.deepEqual(left, [{ user_id: userId, day: old }, { user_id: other, day: today }]);
    await db.query("DELETE FROM anomaly_alerts");
    await db.query("DELETE FROM users WHERE id = $1", [other]);
  });

  test("failed push -> pushed_at NULL -> next run pushes once -> third run pushes nothing", async () => {
    const { runAnomalyCheck } = await import("../src/anomalies.js");
    const sends = [];
    const ok = { sendEachForMulticast: async ({ tokens, data }) => { sends.push(data); return { successCount: 1, responses: tokens.map(() => ({ success: true })) }; } };
    const bad = { sendEachForMulticast: async ({ tokens }) => ({ successCount: 0, responses: tokens.map(() => ({ success: false, error: { code: "messaging/internal-error" } })) }) };
    const pushedAt = async () => (await db.query("SELECT pushed_at FROM anomaly_alerts WHERE user_id = $1", [userId])).rows.map((r) => r.pushed_at);

    const r1 = await runAnomalyCheck({ query: db.query, messaging: bad });
    assert.ok(r1.alerts >= 1 && r1.pushed === 0);
    assert.ok((await pushedAt()).every((p) => p === null));
    const r2 = await runAnomalyCheck({ query: db.query, messaging: ok });
    assert.equal(r2.alerts, 0);
    assert.ok(r2.pushed >= 1);
    assert.ok((await pushedAt()).every((p) => p !== null));
    const n = sends.length;
    assert.deepEqual(await runAnomalyCheck({ query: db.query, messaging: ok }), { candidates: 1, alerts: 0, pushed: 0 });
    assert.equal(sends.length, n);
  });
});

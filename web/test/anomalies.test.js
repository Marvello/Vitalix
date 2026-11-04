import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { detectAnomalies, runAnomalyCheck, PENDING_ANOMALY_USERS_SQL } = await import("../src/anomalies.js");

// 28 history days alternating 58/62 => mean 60, sample sd ~2.0 (< 3, so the RHR margin is 3).
const hist = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const rhrHist = (n = 28) => hist(n, (i) => ({ restingHr: i % 2 ? 62 : 58, hrv: 50 + (i % 2 ? 5 : -5) }));
const day = (o = {}) => ({ restingHr: 60, hrv: 50, spo2Min: 96, bpSys: 120, bpDia: 80, ...o });
const rules = (r) => r.map((a) => a.rule);
const run = (today, recent, history) => detectAnomalies({ today, recent: recent ?? [day(), day(), today], history });

describe("detectAnomalies", () => {
  test("rhr_up fires at mean + max(sd,3) on all 3 days, not just below", () => {
    const h = rhrHist();
    const fire = (v) => rules(run(day({ restingHr: v }), [day({ restingHr: 63 }), day({ restingHr: 63 }), day({ restingHr: v })], h));
    assert.ok(fire(63).includes("rhr_up"));
    assert.ok(!fire(62.9).includes("rhr_up"));
  });
  test("rhr_up uses sd when larger than 3", () => {
    const h = hist(28, (i) => ({ restingHr: i % 2 ? 70 : 50 })); // mean 60, sd ~20.4
    const r = [day({ restingHr: 80 }), day({ restingHr: 81 }), day({ restingHr: 81 })];
    assert.ok(rules(run(r[2], r, h)).includes("rhr_up"));
    const r2 = r.map((d) => ({ ...d, restingHr: 70 }));
    assert.ok(!rules(run(r2[2], r2, h)).includes("rhr_up"));
  });
  test("rhr_up needs all 3 days and a value on each", () => {
    const h = rhrHist();
    const hi = day({ restingHr: 70 });
    assert.ok(!rules(run(hi, [day(), hi, hi], h)).includes("rhr_up"));
    assert.ok(!rules(run(hi, [hi, day({ restingHr: null }), hi], h)).includes("rhr_up"));
    assert.ok(!rules(run(hi, [hi, hi], h)).includes("rhr_up"));
    const a = run(hi, [hi, hi, hi], h).find((x) => x.rule === "rhr_up");
    assert.equal(a.value, 70);
    assert.equal(a.baseline, 60);
  });
  test("hrv_drop at mean - 2sd, needs sd > 0", () => {
    const h = rhrHist(); // hrv mean 50, sd s
    const sd = Math.sqrt(25 * 28 / 27);
    const lim = 50 - 2 * sd;
    assert.ok(rules(run(day({ hrv: lim }), null, h)).includes("hrv_drop"));
    assert.ok(!rules(run(day({ hrv: lim + 0.01 }), null, h)).includes("hrv_drop"));
    assert.ok(!rules(run(day({ hrv: 0 }), null, hist(28, () => ({ hrv: 50 })))).includes("hrv_drop"));
  });
  test("spo2_low below 90 only; bp_high at 140 sys or 90 dia", () => {
    assert.ok(rules(run(day({ spo2Min: 89.9 }), null, [])).includes("spo2_low"));
    assert.ok(!rules(run(day({ spo2Min: 90 }), null, [])).includes("spo2_low"));
    assert.ok(rules(run(day({ bpSys: 140, bpDia: 70 }), null, [])).includes("bp_high"));
    assert.ok(rules(run(day({ bpSys: 120, bpDia: 90 }), null, [])).includes("bp_high"));
    assert.ok(!rules(run(day({ bpSys: 139, bpDia: 89 }), null, [])).includes("bp_high"));
    const a = run(day({ bpSys: 142, bpDia: 91 }), null, []).find((x) => x.rule === "bp_high");
    assert.deepEqual([a.value, a.baseline, a.text], [142, null, "142/91"]);
    assert.equal(run(day({ bpSys: 142, bpDia: null }), null, []).find((x) => x.rule === "bp_high").text, "142");
  });
  test("13 history days: no statistical rule, spo2_low still fires", () => {
    const h = rhrHist(13);
    const t = day({ restingHr: 90, hrv: 1, spo2Min: 85 });
    assert.deepEqual(rules(run(t, [t, t, t], h)), ["spo2_low"]);
    assert.ok(rules(run(t, [t, t, t], rhrHist(14))).includes("rhr_up"));
  });
  test("null metrics never fire", () => {
    const n = { restingHr: null, hrv: null, spo2Min: null, bpSys: null, bpDia: null };
    assert.deepEqual(run(n, [n, n, n], rhrHist()), []);
  });
});

describe("PENDING_ANOMALY_USERS_SQL", () => {
  test("local yesterday, enabled, past 08:00, has data", () => {
    assert.match(PENDING_ANOMALY_USERS_SQL, /AT TIME ZONE COALESCE\(u\.timezone, 'UTC'\)/);
    assert.match(PENDING_ANOMALY_USERS_SQL, /disabled_at IS NULL/);
    assert.match(PENDING_ANOMALY_USERS_SQL, /EXTRACT\(HOUR FROM n\.local_now\) >= 8/);
    assert.match(PENDING_ANOMALY_USERS_SQL, /FROM health_days/);
  });
});

describe("runAnomalyCheck", () => {
  function deps({ messaging = true } = {}) {
    const seen = new Set();
    const table = []; // anomaly_alerts rows: { id, rule, value, baseline, pushed }
    const calls = { inserts: [], pushed: [], series: [] };
    const query = async (text, params) => {
      if (text === PENDING_ANOMALY_USERS_SQL) return { rows: [{ id: 7, day: "2026-09-10" }] };
      if (text.includes("FROM health_days h")) {
        calls.series.push(params);
        const rows = [
          // real ISO days: 2026-08-11 .. 2026-09-07 (the 28-day history) so statistical rules run
          ...rhrHist(28).map((r, i) => ({ day: new Date(Date.UTC(2026, 7, 11 + i)).toISOString().slice(0, 10), ...r })),
          { day: "2026-09-08", restingHr: 70, hrv: 50 },
          { day: "2026-09-09", restingHr: 70, hrv: 50 },
          { day: "2026-09-10", restingHr: 70, hrv: 50, spo2Min: 85, bpSys: 150, bpDia: 95 },
        ];
        return { rows };
      }
      if (text.includes("INSERT INTO anomaly_alerts")) {
        assert.match(text, /ON CONFLICT \(user_id, day, rule\) DO NOTHING RETURNING id/);
        calls.inserts.push(params);
        const k = params.slice(0, 3).join("|");
        if (seen.has(k)) return { rows: [] };
        seen.add(k);
        table.push({ id: seen.size, rule: params[2], value: params[3], baseline: params[4], pushed: false });
        return { rows: [{ id: seen.size }] };
      }
      if (text.includes("FROM anomaly_alerts")) {
        assert.match(text, /pushed_at IS NULL/);
        return { rows: table.filter((r) => !r.pushed) };
      }
      if (text.includes("UPDATE anomaly_alerts SET pushed_at")) {
        table.find((r) => r.id === params[0]).pushed = true;
        return { rows: [] };
      }
      if (text.includes("array_agg(token)")) return { rows: [{ tokens: ["tok"] }] };
      return { rows: [] };
    };
    const m = {
      sendEachForMulticast: async ({ tokens, data }) => {
        calls.pushed.push(data);
        return { successCount: tokens.length, responses: tokens.map(() => ({ success: true })) };
      },
    };
    return { calls, table, deps: { query, messaging: messaging ? m : null } };
  }

  test("stores alerts, pushes string data once; second run pushes nothing", async () => {
    const { deps: d, calls } = deps();
    const r1 = await runAnomalyCheck(d);
    assert.deepEqual(r1, { candidates: 1, alerts: 3, pushed: 3 });
    const bp = calls.pushed.find((p) => p.rule === "bp_high");
    assert.deepEqual(bp, { type: "anomaly", day: "2026-09-10", rule: "bp_high", value: "150/95", baseline: "" });
    const rhr = calls.pushed.find((p) => p.rule === "rhr_up");
    assert.deepEqual(rhr, { type: "anomaly", day: "2026-09-10", rule: "rhr_up", value: "70", baseline: "60" });
    const sp = calls.pushed.find((p) => p.rule === "spo2_low");
    assert.equal(sp.value, "85");
    for (const p of calls.pushed) for (const v of Object.values(p)) assert.equal(typeof v, "string");
    const r2 = await runAnomalyCheck(d);
    assert.deepEqual(r2, { candidates: 1, alerts: 0, pushed: 0 });
    assert.equal(calls.pushed.length, 3);
  });

  test("a failed push stays unpushed, is retried once next run, then never again", async () => {
    const { deps: d, calls, table } = deps();
    const real = d.messaging;
    d.messaging = { sendEachForMulticast: async () => ({ successCount: 0, responses: [{ success: false, error: { code: "messaging/internal-error" } }] }) };
    assert.deepEqual(await runAnomalyCheck(d), { candidates: 1, alerts: 3, pushed: 0 });
    assert.ok(table.every((r) => !r.pushed));
    d.messaging = real;
    assert.deepEqual(await runAnomalyCheck(d), { candidates: 1, alerts: 0, pushed: 3 });
    assert.equal(calls.pushed.find((p) => p.rule === "bp_high").value, "150/95"); // text recomputed on retry
    assert.deepEqual(await runAnomalyCheck(d), { candidates: 1, alerts: 0, pushed: 0 });
    assert.equal(calls.pushed.length, 3);
  });

  test("history window is the 28 days before the 3 recent days", async () => {
    const { deps: d, calls } = deps();
    await runAnomalyCheck(d);
    assert.deepEqual(calls.series[0].slice(1), ["2026-08-11", "2026-09-10"]);
  });

  test("null messaging still stores alerts", async () => {
    const { deps: d, calls } = deps({ messaging: false });
    const r = await runAnomalyCheck(d);
    assert.deepEqual(r, { candidates: 1, alerts: 3, pushed: 0 });
    assert.equal(calls.inserts.length, 3);
  });

  test("an FCM throw is logged and does not abort the run", async () => {
    const { deps: d } = deps();
    d.messaging = { sendEachForMulticast: async () => { throw new Error("fcm down"); } };
    const log = console.error; console.error = () => {};
    try {
      assert.deepEqual(await runAnomalyCheck(d), { candidates: 1, alerts: 3, pushed: 0 });
    } finally { console.error = log; }
  });
});

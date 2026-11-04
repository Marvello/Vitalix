import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://x"; // pure logic, no DB
process.env.JWT_SECRET ??= "test-secret";
const { readinessScore, readinessSeries } = await import("../src/readiness.js");

// 28 days: hrv alternates 40/60 (mean 50), restingHr alternates 58/62 (mean 60).
const sdOf = (a, b, n) => Math.sqrt((n * ((a - (a + b) / 2) ** 2 + (b - (a + b) / 2) ** 2) / 2) / (n - 1));
const history = (n = 28) => Array.from({ length: n }, (_, i) => ({
  day: `2026-09-${String(i + 1).padStart(2, "0")}`,
  hrv: i % 2 ? 60 : 40, restingHr: i % 2 ? 62 : 58, sleepMin: 450,
}));

test("all at mean + 8 h sleep -> 65", () => {
  const r = readinessScore({ today: { hrv: 50, restingHr: 60, sleepMin: 480 }, history: history() });
  assert.deepEqual(r, { score: 65, parts: { hrv: 50, restingHr: 50, sleep: 100 } });
});

test("HRV +1 sd, RHR -1 sd, 8 h -> 76", () => {
  const sd = sdOf(40, 60, 28), rsd = sdOf(58, 62, 28);
  const r = readinessScore({ today: { hrv: 50 + sd, restingHr: 60 - rsd, sleepMin: 480 }, history: history() });
  assert.equal(r.score, 76);
  assert.deepEqual(r.parts, { hrv: 65, restingHr: 65, sleep: 100 });
});

test("only sleep -> null; 6 history days -> null; <2 parts never scores", () => {
  assert.equal(readinessScore({ today: { sleepMin: 480 }, history: history() }), null);
  assert.equal(readinessScore({ today: { hrv: 50, restingHr: 60, sleepMin: 480 }, history: history(6) }), null);
});

test("a metric with under 7 history days is dropped; the other statistical part still pairs with sleep", () => {
  const h = history(10).map((r, i) => (i < 5 ? { ...r, restingHr: null } : r)); // restingHr n=5
  const r = readinessScore({ today: { hrv: 50, restingHr: 60, sleepMin: 240 }, history: h });
  assert.deepEqual(r.parts, { hrv: 50, sleep: 50 });
  assert.equal(r.score, Math.round((0.4 * 50 + 0.3 * 50) / 0.7));
});

test("sd 0 -> parts 50; clamps to 0..100", () => {
  const flat = history().map((r) => ({ ...r, hrv: 50, restingHr: 60 }));
  assert.deepEqual(readinessScore({ today: { hrv: 99, restingHr: 10, sleepMin: 480 }, history: flat }).parts, { hrv: 50, restingHr: 50, sleep: 100 });
  const r = readinessScore({ today: { hrv: 500, restingHr: 500, sleepMin: 960 }, history: history() });
  assert.deepEqual(r.parts, { hrv: 100, restingHr: 0, sleep: 100 });
});

test("readinessSeries picks history by date (gaps), not array index", () => {
  const rows = history(28).filter((_, i) => i % 4 !== 3); // 21 rows, gaps
  rows.push({ day: "2026-09-29", hrv: 50, restingHr: 60, sleepMin: 480 });
  rows.push({ day: "2026-10-30", hrv: 50, restingHr: 60, sleepMin: 480 }); // 31 days after: no history in window
  const s = readinessSeries(rows, "2026-09-29", "2026-10-30");
  assert.deepEqual(s.map((x) => x.day), ["2026-09-29"]); // 09-29 uses the 21 gapped rows; 10-30 has none in its window
});

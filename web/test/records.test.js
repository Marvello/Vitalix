import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregationFor, BUCKETS, buildRecordsQuery, shapeBucketRow, RAW_LIMIT, rollupSourceMetrics } from "../src/records.js";

test("new metrics map to the right aggregation", () => {
  assert.equal(aggregationFor("mindfulness"), "sum");
  assert.equal(aggregationFor("intermenstrualBleeding"), "sum");
  assert.equal(aggregationFor("basalMetabolicRate"), "last");
  assert.equal(aggregationFor("bodyWaterMass"), "last");
  assert.equal(aggregationFor("basalBodyTemperature"), "last");
  assert.equal(aggregationFor("menstruationPeriod"), "last");
  assert.equal(aggregationFor("activityIntensity"), "text");
  assert.equal(aggregationFor("skinTemperature"), "minmaxavg");
});

test("all nutrition.* nutrients aggregate as sum", () => {
  assert.equal(aggregationFor("nutrition.protein"), "sum");
  assert.equal(aggregationFor("nutrition.vitaminB12"), "sum");
});

test("catalog maps types to aggregation rules", () => {
  assert.equal(aggregationFor("steps"), "sum");
  assert.equal(aggregationFor("heartRate"), "minmaxavg");
  assert.equal(aggregationFor("weight"), "last");
  assert.equal(aggregationFor("menstruation"), "text");
  assert.equal(aggregationFor("somethingNew"), "minmaxavg"); // safe default
});

test("bucket allowlist", () => {
  assert.ok(BUCKETS.has("hour"));
  assert.ok(!BUCKETS.has("year"));
});

test("rejects an unknown bucket (no SQL injection surface)", () => {
  assert.throws(() => buildRecordsQuery({ userId: 1, from: "a", to: "b", bucket: "day; DROP TABLE records" }),
    /invalid bucket/);
});

test("raw bucket selects rows without grouping", () => {
  const q = buildRecordsQuery({ userId: 1, from: "2026-07-01", to: "2026-07-31", bucket: "raw" });
  assert.match(q.text, /FROM records/);
  assert.doesNotMatch(q.text, /date_trunc/);
  assert.deepEqual(q.values.slice(0, 3), [1, "2026-07-01", "2026-07-31"]);
});

test("hour bucket groups with date_trunc and aggregates", () => {
  const q = buildRecordsQuery({ userId: 1, from: "2026-07-01", to: "2026-07-31", bucket: "hour" });
  assert.match(q.text, /date_trunc\('hour'/);
  assert.match(q.text, /GROUP BY/);
});

test("types filter is parameterized when provided", () => {
  const q = buildRecordsQuery({ userId: 1, from: "a", to: "b", bucket: "day", types: ["steps", "heartRate"] });
  assert.match(q.text, /type = ANY/);
  assert.deepEqual(q.values.at(-1), ["steps", "heartRate"]);
});

test("bucketed query also aggregates value_secondary (bloodPressure diastolic)", () => {
  const q = buildRecordsQuery({ userId: 1, from: "2026-07-01", to: "2026-07-31", bucket: "day" });
  assert.match(q.text, /min\(value_secondary\)/);
  assert.match(q.text, /max\(value_secondary\)/);
  assert.match(q.text, /avg\(value_secondary\)/);
});

test("shapeBucketRow includes min2/max2/avg2 for distribution rows when populated", () => {
  const row = { type: "bloodPressure", bucket_start: "2026-07-01", count: 3,
    min: 110, max: 130, avg: 120, min2: 70, max2: 90, avg2: 80 };
  const shaped = shapeBucketRow(row);
  assert.equal(shaped.min2, 70);
  assert.equal(shaped.max2, 90);
  assert.equal(shaped.avg2, 80);
});

test("shapeBucketRow omits min2 key for single-value distributions", () => {
  const row = { type: "heartRate", bucket_start: "2026-07-01", count: 3,
    min: 60, max: 100, avg: 80, min2: null, max2: null, avg2: null };
  const shaped = shapeBucketRow(row);
  assert.ok(!("min2" in shaped));
});

test("RAW_LIMIT is exported and numeric", () => {
  assert.equal(typeof RAW_LIMIT, "number");
  assert.ok(RAW_LIMIT > 0);
});

test("rollupSourceMetrics sums sum-rule metrics per source", () => {
  const rows = rollupSourceMetrics([
    { metric: "steps", source: "fit", value_num: 100, start_at: "2026-07-01T08:00:00Z" },
    { metric: "steps", source: "fit", value_num: 50, start_at: "2026-07-01T09:00:00Z" },
    { metric: "steps", source: "samsung", value_num: 200, start_at: "2026-07-01T08:00:00Z" },
  ]);
  const fit = rows.find((r) => r.source === "fit");
  const sam = rows.find((r) => r.source === "samsung");
  assert.equal(fit.value_num, 150);
  assert.equal(fit.count, 2);
  assert.equal(sam.value_num, 200);
});

test("rollupSourceMetrics takes latest reading for last-rule metrics", () => {
  const rows = rollupSourceMetrics([
    { metric: "weight", source: "scale", value_num: 80, start_at: "2026-07-01T06:00:00Z" },
    { metric: "weight", source: "scale", value_num: 81, start_at: "2026-07-01T20:00:00Z" },
  ]);
  assert.equal(rows[0].value_num, 81);
});

test("rollupSourceMetrics gives min/max/avg for distribution metrics, value_num = avg", () => {
  const rows = rollupSourceMetrics([
    { metric: "heartRate", source: "watch", value_num: 60, start_at: "2026-07-01T06:00:00Z" },
    { metric: "heartRate", source: "watch", value_num: 100, start_at: "2026-07-01T07:00:00Z" },
  ]);
  const r = rows[0];
  assert.equal(r.min, 60);
  assert.equal(r.max, 100);
  assert.equal(r.avg, 80);
  assert.equal(r.value_num, 80);
});

test("rollupSourceMetrics skips text metrics and null values, coalesces null source", () => {
  const rows = rollupSourceMetrics([
    { metric: "menstruation", source: "app", value_num: null, start_at: "2026-07-01T00:00:00Z", value_text: "light" },
    { metric: "steps", source: null, value_num: 10, start_at: "2026-07-01T08:00:00Z" },
    { metric: "steps", source: null, value_num: null, start_at: "2026-07-01T09:00:00Z" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "(unknown)");
  assert.equal(rows[0].value_num, 10);
});

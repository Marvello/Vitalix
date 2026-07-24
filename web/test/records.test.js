import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregationFor, BUCKETS, buildRecordsQuery } from "../src/records.js";

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

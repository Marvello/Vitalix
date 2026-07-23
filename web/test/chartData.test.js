import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandSeries, dateRange, fillDays, metricLabel, rollingAverage, sleepStages, summaryTiles, toKey,
  visibleMetrics, visibleTiles,
} from "../src/chartData.js";

test("toKey accepts Dates and strings, and keeps the local calendar day", () => {
  assert.equal(toKey("2026-07-20"), "2026-07-20");
  assert.equal(toKey("2026-07-20T00:00:00.000Z"), "2026-07-20");
  assert.equal(toKey(new Date(2026, 6, 20, 23, 30)), "2026-07-20");
  // A late-evening local time must not roll forward via UTC.
  assert.equal(toKey(new Date(2026, 0, 1, 23, 59)), "2026-01-01");
});

test("dateRange is inclusive on both ends", () => {
  assert.deepEqual(dateRange("2026-07-18", "2026-07-21"),
    ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"]);
  assert.deepEqual(dateRange("2026-07-20", "2026-07-20"), ["2026-07-20"]);
});

test("dateRange crosses month and year boundaries", () => {
  assert.deepEqual(dateRange("2026-01-30", "2026-02-02"),
    ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  assert.deepEqual(dateRange("2025-12-31", "2026-01-01"), ["2025-12-31", "2026-01-01"]);
});

test("fillDays leaves missing days null rather than zero", () => {
  const rows = [{ day: "2026-07-18", steps: 100 }, { day: "2026-07-20", steps: 0 }];
  assert.deepEqual(fillDays(rows, "2026-07-18", "2026-07-20", "steps"), [
    { date: "2026-07-18", value: 100 },
    { date: "2026-07-19", value: null },  // no data
    { date: "2026-07-20", value: 0 },     // recorded zero — distinct from above
  ]);
});

test("fillDays coerces numeric strings from pg", () => {
  const rows = [{ day: "2026-07-18", distance: "1015.5" }];
  assert.deepEqual(fillDays(rows, "2026-07-18", "2026-07-18", "distance"),
    [{ date: "2026-07-18", value: 1015.5 }]);
});

test("rollingAverage ignores nulls and never averages a gap to zero", () => {
  const points = [
    { date: "d1", value: 10 }, { date: "d2", value: null }, { date: "d3", value: 20 },
  ];
  assert.deepEqual(rollingAverage(points, 3), [
    { date: "d1", value: 10 },
    { date: "d2", value: 10 },
    { date: "d3", value: 15 },
  ]);
});

test("rollingAverage stays null until the first real value", () => {
  const points = [{ date: "d1", value: null }, { date: "d2", value: 8 }];
  assert.deepEqual(rollingAverage(points, 7),
    [{ date: "d1", value: null }, { date: "d2", value: 8 }]);
});

test("rollingAverage window only looks backwards", () => {
  const points = [1, 2, 3, 40].map((v, i) => ({ date: `d${i}`, value: v }));
  const avg = rollingAverage(points, 2).map((p) => p.value);
  assert.deepEqual(avg, [1, 1.5, 2.5, 21.5]);
});

test("bandSeries selects one metric and aligns it to the axis", () => {
  const rows = [
    { day: "2026-07-18", metric: "heartRate", min: 52, max: 120, avg: 68.4 },
    { day: "2026-07-18", metric: "spo2", min: 95, max: 95, avg: 95 },
  ];
  assert.deepEqual(bandSeries(rows, "2026-07-18", "2026-07-19", "heartRate"), [
    { date: "2026-07-18", min: 52, max: 120, avg: 68.4 },
    { date: "2026-07-19", min: null, max: null, avg: null },
  ]);
});

test("sleepStages keeps the total when stages are absent", () => {
  const rows = [{ day: "2026-07-18", sleep_duration_minutes: 412 }];
  assert.deepEqual(sleepStages(rows, "2026-07-18", "2026-07-18"), [
    { date: "2026-07-18", deep: null, light: null, rem: null, awake: null, total: 412 },
  ]);
});

test("summaryTiles renders nulls as null, not NaN or zero", () => {
  const tiles = summaryTiles({ days: 3, total_steps: "1234", avg_steps: null,
    total_distance: null, total_active_calories: null, avg_sleep_minutes: null,
    avg_resting_hr: null, workouts: 0 });
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t.value]));
  assert.equal(byLabel["Days recorded"], 3);
  assert.equal(byLabel["Total steps"], 1234);
  assert.equal(byLabel["Avg steps / day"], null);
  assert.equal(byLabel["Avg sleep"], null);
  // A zero total now reads as "never recorded", so the tile is dropped upstream.
  assert.equal(byLabel["Workouts"], null);
});

test("summaryTiles converts distance to km and sleep to h/m", () => {
  const tiles = summaryTiles({ days: 1, total_distance: 5432, avg_sleep_minutes: 412 });
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t.value]));
  assert.equal(byLabel["Distance"], 5.43);
  assert.equal(byLabel["Avg sleep"], "6h 52m");
});

test("metricLabel humanises camelCase and known metrics", () => {
  assert.equal(metricLabel("heartRate"), "Heart rate");
  assert.equal(metricLabel("spo2"), "Blood oxygen");
  assert.equal(metricLabel("totalCalories"), "Total calories");
  assert.equal(metricLabel("sleepStage"), "Sleep stage");
});

test("visibleMetrics keeps only metrics with at least one recorded day", () => {
  const catalog = [{ column: "steps" }, { column: "weight" }, { column: "floors_climbed" }];
  const kept = visibleMetrics(catalog, { steps: 821, weight: 35, floors_climbed: 0 });
  assert.deepEqual(kept.map((m) => m.column), ["steps", "weight"]);
});

test("visibleMetrics tolerates a metric missing from coverage entirely", () => {
  assert.deepEqual(visibleMetrics([{ column: "steps" }], {}), []);
  assert.deepEqual(visibleMetrics([{ column: "steps" }], undefined), []);
});

test("visibleTiles drops tiles with no value but keeps real zeros", () => {
  const tiles = [
    { label: "Days", value: 3 },
    { label: "Avg sleep", value: null },
    { label: "Steps", value: 0 },
  ];
  assert.deepEqual(visibleTiles(tiles).map((t) => t.label), ["Days", "Steps"]);
});

test("summaryTiles omits a calorie variant the device never records", () => {
  const tiles = summaryTiles({
    days: 30, total_active_calories: 0, total_total_calories: 4200, workouts: 12,
  });
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t.value]));
  assert.equal(byLabel["Active calories"], null);
  assert.equal(byLabel["Total calories"], 4200);
  assert.equal(byLabel["Workouts"], 12);
});

test("summaryTiles treats a zero total as not recorded", () => {
  const byLabel = Object.fromEntries(
    summaryTiles({ days: 5, total_distance: 0, workouts: 0 }).map((t) => [t.label, t.value])
  );
  assert.equal(byLabel["Distance"], null);
  assert.equal(byLabel["Workouts"], null);
  // Days recorded is a count of rows, not a sum, so zero stays meaningful.
  assert.equal(byLabel["Days recorded"], 5);
});

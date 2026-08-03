import { test } from "node:test";
import assert from "node:assert/strict";
import { fillForward, bmiFromWeightHeight, bmiCategory } from "../src/chartData.js";

test("fillForward carries last known value across gaps", () => {
  const rows = [
    { day: "2026-08-01", weight: 80 },
    { day: "2026-08-03", weight: 78 },
  ];
  const result = fillForward(rows, "2026-08-01", "2026-08-04", "weight");
  assert.deepEqual(result, [
    { date: "2026-08-01", value: 80 },
    { date: "2026-08-02", value: 80 },
    { date: "2026-08-03", value: 78 },
    { date: "2026-08-04", value: 78 },
  ]);
});

test("fillForward returns null before first data point", () => {
  const rows = [{ day: "2026-08-03", weight: 78 }];
  const result = fillForward(rows, "2026-08-01", "2026-08-03", "weight");
  assert.deepEqual(result, [
    { date: "2026-08-01", value: null },
    { date: "2026-08-02", value: null },
    { date: "2026-08-03", value: 78 },
  ]);
});

test("fillForward with all-null rows returns all null", () => {
  const rows = [];
  const result = fillForward(rows, "2026-08-01", "2026-08-03", "weight");
  assert.deepEqual(result, [
    { date: "2026-08-01", value: null },
    { date: "2026-08-02", value: null },
    { date: "2026-08-03", value: null },
  ]);
});

test("bmiFromWeightHeight computes correctly", () => {
  assert.equal(bmiFromWeightHeight(80, 1.78), 25.2);
  assert.equal(bmiFromWeightHeight(60, 1.65), 22.0);
  assert.equal(bmiFromWeightHeight(80, 0), null);
  assert.equal(bmiFromWeightHeight(null, 1.78), null);
  assert.equal(bmiFromWeightHeight(80, null), null);
});

test("bmiCategory standard WHO boundaries", () => {
  assert.equal(bmiCategory(17.0, "standard"), "Underweight");
  assert.equal(bmiCategory(18.5, "standard"), "Normal");
  assert.equal(bmiCategory(24.9, "standard"), "Normal");
  assert.equal(bmiCategory(25.0, "standard"), "Overweight");
  assert.equal(bmiCategory(29.9, "standard"), "Overweight");
  assert.equal(bmiCategory(30.0, "standard"), "Obese");
});

test("bmiCategory Asian WHO boundaries", () => {
  assert.equal(bmiCategory(17.0, "asian"), "Underweight");
  assert.equal(bmiCategory(18.5, "asian"), "Normal");
  assert.equal(bmiCategory(22.9, "asian"), "Normal");
  assert.equal(bmiCategory(23.0, "asian"), "Overweight");
  assert.equal(bmiCategory(27.4, "asian"), "Overweight");
  assert.equal(bmiCategory(27.5, "asian"), "Obese");
});

test("bmiCategory returns null for null input", () => {
  assert.equal(bmiCategory(null, "standard"), null);
});

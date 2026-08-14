import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculateDeltas, calculateBaseline } from "../src/ai/metricsBuilder.js";

describe("Daily Review Metrics Builder Helpers", () => {
  test("calculateDeltas computes differences correctly", () => {
    const today = { steps: 10000, restingHeartRate: 60 };
    const yesterday = { steps: 8000, restingHeartRate: 65 };

    const deltas = calculateDeltas(today, yesterday);
    assert.equal(deltas.steps, 2000);
    assert.equal(deltas.restingHeartRate, -5);
  });

  test("calculateBaseline computes average over days", () => {
    const pastDays = [
      { steps: 7000, sleepMinutes: 400 },
      { steps: 9000, sleepMinutes: 440 },
    ];

    const baseline = calculateBaseline(pastDays);
    assert.equal(baseline.steps, 8000);
    assert.equal(baseline.sleepMinutes, 420);
  });
});

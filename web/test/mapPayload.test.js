import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPayload } from "../src/mapPayload.js";

const payload = {
  source: "vitalix",
  appVersion: "1.0.0",
  device: "Pixel 8",
  exportedAt: "2026-07-21T09:00:00Z",
  rangeDays: 7,
  days: [
    {
      date: "2026-07-20",
      activity: { steps: 8123, activeCalories: 412.0, distance: 6100.0 },
      body: { weight: 71.2 },
      vitals: {
        heartRate: { min: 52, max: 146, avg: 68 },
        restingHeartRate: 54,
        bloodPressure: { systolic: { avg: 118 }, diastolic: { avg: 76 } },
      },
      sleep: { durationMinutes: 431, stages: { deep: 78, light: 240, rem: 96, awake: 17 } },
      nutrition: { hydrationMl: 1800, energyKcal: 2100 },
      exercises: [{ name: "Running", start: "2026-07-20T06:12:00Z", durationMinutes: 32, source: "com.google.android.apps.fitness", hcId: "ex-1" }],
      samples: [
        { metric: "heartRate", start: "2026-07-20T10:04:12Z", value: 68, source: "com.samsung.health", hcId: "hr-1" },
        { metric: "steps", start: "2026-07-20T10:00:00Z", end: "2026-07-20T11:00:00Z", value: 412 },
        { metric: "bloodPressure", start: "2026-07-20T07:30:00Z", value: 118, value2: 76 },
        { metric: "sleepStage", start: "2026-07-20T00:12:00Z", end: "2026-07-20T01:30:00Z", text: "deep" },
        { metric: "bogusMetric", start: "2026-07-20T00:00:00Z", value: 1 },
      ],
    },
  ],
};

test("maps sync metadata", () => {
  const { sync } = mapPayload(payload);
  assert.deepEqual(sync, {
    source: "vitalix",
    app_version: "1.0.0",
    device: "Pixel 8",
    exported_at: "2026-07-21T09:00:00Z",
    range_days: 7,
  });
});

test("maps scalar columns and omits absent metrics", () => {
  const { days } = mapPayload(payload);
  const s = days[0].scalars;
  assert.equal(s.steps, 8123);
  assert.equal(s.weight, 71.2);
  assert.equal(s.resting_heart_rate, 54);
  assert.equal(s.sleep_deep, 78);
  assert.equal(s.hydration_ml, 1800);
  assert.equal(s.energy_kcal, 2100);
  assert.ok(!("body_fat" in s)); // absent metric not present
});

test("maps aggregates including split blood pressure", () => {
  const aggs = mapPayload(payload).days[0].aggregates;
  const hr = aggs.find((a) => a.metric === "heartRate");
  assert.deepEqual(hr, { metric: "heartRate", min: 52, max: 146, avg: 68 });
  assert.ok(aggs.find((a) => a.metric === "bpSystolic" && a.avg === 118));
  assert.ok(aggs.find((a) => a.metric === "bpDiastolic" && a.avg === 76));
});

test("maps samples by record shape and skips unknown metrics", () => {
  const { days, skipped } = mapPayload(payload);
  const samples = days[0].samples;
  const hr = samples.find((s) => s.metric === "heartRate");
  assert.deepEqual(hr, { metric: "heartRate", start_at: "2026-07-20T10:04:12Z", end_at: null, value_num: 68, value_secondary: null, value_text: null, source: "com.samsung.health", hc_id: "hr-1", meta: null });
  const steps = samples.find((s) => s.metric === "steps");
  assert.equal(steps.source, null); // absent source maps to null
  assert.equal(steps.end_at, "2026-07-20T11:00:00Z");
  assert.equal(steps.value_num, 412);
  const bp = samples.find((s) => s.metric === "bloodPressure");
  assert.equal(bp.value_num, 118);
  assert.equal(bp.value_secondary, 76);
  const stage = samples.find((s) => s.metric === "sleepStage");
  assert.equal(stage.value_text, "deep");
  assert.equal(skipped, 1); // bogusMetric
  assert.ok(!samples.find((s) => s.metric === "bogusMetric"));
});

test("maps exercises", () => {
  const ex = mapPayload(payload).days[0].exercises[0];
  assert.deepEqual(ex, { name: "Running", start_at: "2026-07-20T06:12:00Z", duration_minutes: 32, source: "com.google.android.apps.fitness", hc_id: "ex-1", detail: null });
});

test("carries hc_id through samples and exercises", () => {
  const { days } = mapPayload(payload);
  const hr = days[0].samples.find((s) => s.metric === "heartRate");
  assert.equal(hr.hc_id, "hr-1");
  const steps = days[0].samples.find((s) => s.metric === "steps");
  assert.equal(steps.hc_id, null); // absent hcId maps to null
  assert.equal(days[0].exercises[0].hc_id, "ex-1");
});

test("mapSamples passes a meta object through and defaults missing meta to null", () => {
  const mapped = mapPayload({
    days: [{
      date: "2026-07-01",
      samples: [
        { metric: "bloodPressure", start: "2026-07-01T08:00:00Z", value: 120, value2: 80,
          hcId: "bp-1", meta: { bodyPosition: "standing", measurementLocation: "left_wrist" } },
        { metric: "heartRate", start: "2026-07-01T08:01:00Z", value: 70, hcId: "hr-1" },
      ],
    }],
  });
  const samples = mapped.days[0].samples;
  const bp = samples.find((s) => s.metric === "bloodPressure");
  const hr = samples.find((s) => s.metric === "heartRate");
  assert.deepEqual(bp.meta, { bodyPosition: "standing", measurementLocation: "left_wrist" });
  assert.equal(hr.meta, null);
});

test("keeps new gap metrics and nutrition.* samples", () => {
  const { days, skipped } = mapPayload({ days: [{ date: "2026-07-24", samples: [
    { metric: "skinTemperature", start: "2026-07-24T06:00:00Z", value: 0.3, hcId: "s1" },
    { metric: "mindfulness", start: "2026-07-24T06:00:00Z", end: "2026-07-24T06:10:00Z", value: 10, hcId: "m1" },
    { metric: "nutrition.protein", start: "2026-07-24T06:00:00Z", value: 20, hcId: "n1" },
  ] }] });
  assert.equal(skipped, 0);
  assert.equal(days[0].samples.length, 3);
});

test("maps exercise detail into a detail object", () => {
  const { days } = mapPayload({ days: [{ date: "2026-07-24", exercises: [
    { name: "Run", start: "2026-07-24T06:00:00Z", durationMinutes: 30, hcId: "e1",
      laps: [{ start: "a", end: "b", lengthMeters: 2000 }],
      segments: [{ start: "a", end: "b", type: "running" }],
      route: [{ time: "a", lat: 1.2, lng: 103.8 }] },
  ] }] });
  const ex = days[0].exercises[0];
  assert.equal(ex.detail.laps.length, 1);
  assert.equal(ex.detail.route[0].lat, 1.2);
});

test("exercise without detail has null detail", () => {
  const { days } = mapPayload({ days: [{ date: "2026-07-24", exercises: [
    { name: "Walk", start: "2026-07-24T06:00:00Z", durationMinutes: 10, hcId: "e2" },
  ] }] });
  assert.equal(days[0].exercises[0].detail, null);
});

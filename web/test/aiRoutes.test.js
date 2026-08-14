import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";

const { aiRouter, buildPrompts } = await import("../src/routes/ai.js");
const { signAccess } = await import("../src/auth/tokens.js");

describe("AI Recommendation Routes", () => {
  let server;
  let baseUrl;

  before((_, done) => {
    const app = express();
    app.use(express.json());
    app.use(aiRouter);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  after((_, done) => {
    server.close(done);
  });

  test("POST /api/ai/recommendations/generate returns 401 when unauthenticated", async () => {
    const res = await fetch(`${baseUrl}/api/ai/recommendations/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 401);
  });

  test("POST /api/ai/recommendations/generate returns 500 when DB unavailable", async () => {
    const token = signAccess({ id: 1, role: "user" });
    const res = await fetch(`${baseUrl}/api/ai/recommendations/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ day: "2026-08-14" }),
    });
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(data.error);
  });
});

describe("buildPrompts", () => {
  test("builds system and user prompts from metrics", () => {
    const dayData = { steps: 10000, active_calories: 450, resting_heart_rate: 62 };
    const deltas = { steps: 2000, resting_heart_rate: -3 };
    const baseline7d = { steps: 8500, active_calories: 400 };

    const { system, user } = buildPrompts(dayData, deltas, baseline7d, "2026-08-14");

    assert.ok(system.includes("health and fitness coach"));
    assert.ok(user.includes("Date: 2026-08-14"));
    assert.ok(user.includes("steps: 10000"));
    assert.ok(user.includes("+2000 vs yesterday"));
    assert.ok(user.includes("[7d avg: 8500]"));
    assert.ok(user.includes("active calories: 450"));
    assert.ok(user.includes("[7d avg: 400]"));
    assert.ok(user.includes("resting heart rate: 62"));
    assert.ok(user.includes("-3 vs yesterday"));
  });

  test("handles empty metrics gracefully", () => {
    const { user } = buildPrompts({}, {}, {}, "2026-08-14");
    assert.ok(user.includes("No metric data available"));
  });

  test("omits null metrics", () => {
    const dayData = { steps: 5000, active_calories: null };
    const { user } = buildPrompts(dayData, {}, {}, "2026-08-14");
    assert.ok(user.includes("steps: 5000"));
    assert.ok(!user.includes("active calories"));
  });
});

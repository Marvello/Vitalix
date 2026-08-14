import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";

const { aiRouter } = await import("../src/routes/ai.js");
const { signAccess } = await import("../src/auth/tokens.js");

describe("AI Recommendation Routes", () => {
  let server;
  let baseUrl;

  before((_, done) => {
    process.env.JWT_SECRET ||= "test-secret";
    const app = express();
    app.use(express.json());
    app.use(aiRouter);
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  after((_, done) => {
    server.close(done);
  });

  test("GET /api/daily-review returns 401 when unauthenticated", async () => {
    const res = await fetch(`${baseUrl}/api/daily-review?day=2026-08-14`);
    assert.equal(res.status, 401);
  });

  test("POST /api/ai/recommendations/generate returns 401 when unauthenticated", async () => {
    const res = await fetch(`${baseUrl}/api/ai/recommendations/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 401);
  });

  test("GET /api/daily-review returns daily review data when authenticated", async () => {
    const token = signAccess({ id: 1, role: "user" });
    const res = await fetch(`${baseUrl}/api/daily-review?day=2026-08-14`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.day, "2026-08-14");
    assert.ok(data.metrics);
    assert.ok(data.deltas);
    assert.ok(data.baseline7d);
  });

  test("POST /api/ai/recommendations/generate returns success when authenticated", async () => {
    const token = signAccess({ id: 1, role: "user" });
    const res = await fetch(`${baseUrl}/api/ai/recommendations/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(typeof data.text === "string");
  });
});

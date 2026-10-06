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

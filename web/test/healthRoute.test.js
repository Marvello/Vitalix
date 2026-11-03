import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";

const { pool } = await import("../src/db.js");
// No database here: auth's user lookup and the ingest transaction hit a stub.
const fakeClient = { query: async () => ({ rows: [{ role: "user", disabled_at: null }] }), release() {} };
pool.query = fakeClient.query;
pool.connect = async () => fakeClient;

const { router } = await import("../src/routes/health.js");
const { signAccess } = await import("../src/auth/tokens.js");

describe("POST /api/health schemaVersion", () => {
  let server;
  let baseUrl;
  before((_, done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });
  after((_, done) => { server.close(done); });

  const post = (body) => fetch(`${baseUrl}/api/health`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signAccess({ id: 1, role: "user" })}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  test("schemaVersion above PAYLOAD_SCHEMA_VERSION -> 400 unsupported schemaVersion", async () => {
    const res = await post({ schemaVersion: 3, days: [] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unsupported schemaVersion");
  });

  test("current and absent schemaVersion are not rejected", async () => {
    for (const body of [{ schemaVersion: 2, days: [] }, { days: [] }]) {
      assert.notEqual((await post(body)).status, 400);
    }
  });

  test("deletedHcIds above 10 000 -> 400; at the cap it is accepted", async () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => `id${i}`);
    const over = await post({ days: [], deletedHcIds: ids(10001) });
    assert.equal(over.status, 400);
    assert.equal((await over.json()).error, "deletedHcIds holds more than 10000 ids");
    assert.notEqual((await post({ days: [], deletedHcIds: ids(10000) })).status, 400);
  });
});

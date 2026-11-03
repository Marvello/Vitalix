import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";

const { pool } = await import("../src/db.js");
pool.query = async () => ({ rows: [{ role: "user", disabled_at: null, timezone: "UTC" }] });

const { pearson, pairSeries } = await import("../src/correlate.js");
const { pagesRouter } = await import("../src/routes/pages.js");
const { signAccess } = await import("../src/auth/tokens.js");

const seq = (n) => Array.from({ length: n }, (_, i) => i);

describe("pearson", () => {
  test("perfect line -> r 1", () => {
    const { r, n } = pearson(seq(12), seq(12).map((i) => 3 * i + 2));
    assert.ok(Math.abs(r - 1) < 1e-12);
    assert.equal(n, 12);
  });
  test("9 pairs -> null", () => assert.equal(pearson(seq(9), seq(9)), null));
  test("constant series -> null", () => assert.equal(pearson(seq(12), seq(12).map(() => 5)), null));
  test("non-finite pairs are dropped", () => {
    const xs = [...seq(10), null], ys = [...seq(10), 3];
    assert.equal(pearson(xs, ys).n, 10);
  });
});

describe("pairSeries", () => {
  const rows = [{ day: "2026-11-03", a: 1, b: 10 }, { day: "2026-11-05", a: 2, b: 20 }, { day: "2026-11-06", a: 3, b: 30 }];
  test("lag 1 pairs by date: 11-03 is not paired with 11-05", () => {
    assert.deepEqual(pairSeries(rows, "a", "b", 1), [[2, 30]]);
  });
  test("lag 0 pairs same day", () => {
    assert.deepEqual(pairSeries(rows, "a", "b", 0), [[1, 10], [2, 20], [3, 30]]);
  });
});

describe("GET /insights/correlations validation", () => {
  let server, base;
  before((_, done) => {
    const app = express();
    app.use(cookieParser());
    app.use(pagesRouter);
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  after((_, done) => { server.close(done); });
  const get = (qs) => fetch(`${base}/insights/correlations${qs}`, {
    headers: { Authorization: `Bearer ${signAccess({ id: 1, role: "user" })}` },
  });
  test("unknown x, array x, bad lag/days -> 400", async () => {
    for (const qs of ["?x=nope&y=hrv", "?x[]=steps&y=hrv", "?x=steps&y=hrv&lag=2", "?x=steps&y=hrv&days=7", "?x=steps"])
      assert.equal((await get(qs)).status, 400, qs);
  });
});

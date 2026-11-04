import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { errorHandler } from "../src/errorHandler.js";

async function statusAndBody(status) {
  const app = express();
  app.get("/api/x", (req, res, next) => next(Object.assign(new Error("boom"), { status })));
  app.use(errorHandler);
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const origErr = console.error; console.error = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/x`);
    return [res.status, (await res.json()).error];
  } finally { console.error = origErr; s.close(); }
}

test("413 says Payload too large; other 4xx Bad request; 5xx Internal error", async () => {
  assert.deepEqual(await statusAndBody(413), [413, "Payload too large"]);
  assert.deepEqual(await statusAndBody(400), [400, "Bad request"]);
  assert.deepEqual(await statusAndBody(503), [500, "Internal error"]);
});

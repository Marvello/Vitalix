import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../src/rateLimit.js";

function call(mw, req) {
  let status = 200;
  const res = {
    set() {},
    status(s) { status = s; return this; },
    json() { return this; },
    send() { return this; },
  };
  mw({ path: "/api/x", accepts: () => "json", ...req }, res, () => {});
  return status;
}

test("rateLimit allows max requests per key per window, then 429", () => {
  const mw = rateLimit({ windowMs: 60_000, max: 2 });
  assert.equal(call(mw, { ip: "1.1.1.1" }), 200);
  assert.equal(call(mw, { ip: "1.1.1.1" }), 200);
  assert.equal(call(mw, { ip: "1.1.1.1" }), 429);
  assert.equal(call(mw, { ip: "2.2.2.2" }), 200, "other keys are independent");
});

test("rateLimit resets after the window", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const mw = rateLimit({ windowMs: 1000, max: 1 });
  assert.equal(call(mw, { ip: "a" }), 200);
  assert.equal(call(mw, { ip: "a" }), 429);
  t.mock.timers.tick(1001);
  assert.equal(call(mw, { ip: "a" }), 200);
});

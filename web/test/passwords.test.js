import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";
const { hash, verify } = await import("../src/auth/passwords.js");

test("hash then verify", async () => {
  const h = await hash("s3cret!");
  assert.notEqual(h, "s3cret!");
  assert.equal(await verify("s3cret!", h), true);
  assert.equal(await verify("wrong", h), false);
});

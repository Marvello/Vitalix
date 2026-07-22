import { test } from "node:test";
import assert from "node:assert/strict";
import { hash, verify } from "../src/auth/passwords.js";

test("hash then verify", async () => {
  const h = await hash("s3cret!");
  assert.notEqual(h, "s3cret!");
  assert.equal(await verify("s3cret!", h), true);
  assert.equal(await verify("wrong", h), false);
});

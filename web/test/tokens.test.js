import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";
const { signAccess, verifyAccess, randomToken, hashToken } = await import("../src/auth/tokens.js");

test("access token round-trips sub+role", () => {
  const t = signAccess({ id: 42, role: "admin" });
  const claims = verifyAccess(t);
  assert.equal(claims.sub, "42");
  assert.equal(claims.role, "admin");
});

test("tampered token rejected", () => {
  assert.equal(verifyAccess("not.a.jwt"), null);
});

test("hashToken deterministic, randomToken unique", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.notEqual(randomToken(), randomToken());
});

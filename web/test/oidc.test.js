import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { matchUser, signFlow, readFlow } = await import("../src/auth/oidc.js");

const users = new Map([
  ["owner@example.com", { id: 1, role: "admin", disabled_at: null }],
  ["gone@example.com", { id: 2, role: "user", disabled_at: "2026-10-01" }],
]);
const find = async (email) => users.get(email) ?? null;

test("a verified email of an enabled user signs in (trimmed, lower-cased)", async () => {
  assert.deepEqual(await matchUser({ email: " Owner@Example.com ", email_verified: true }, find), {
    user: { id: 1, role: "admin", disabled_at: null },
  });
});

test("SSO never creates accounts: unknown email is refused", async () => {
  assert.match((await matchUser({ email: "new@example.com", email_verified: true }, find)).error, /No Vitalix account/);
});

test("disabled accounts and unverified/missing emails are refused", async () => {
  assert.equal((await matchUser({ email: "gone@example.com", email_verified: true }, find)).error, "Account disabled.");
  for (const claims of [{ email: "owner@example.com", email_verified: false }, { email: "owner@example.com" }, { email_verified: true }, undefined])
    assert.match((await matchUser(claims, find)).error, /verified email/);
});

test("flow cookie round-trips and rejects tampering or garbage", () => {
  const flow = { verifier: "v", state: "s", nonce: "n" };
  const raw = signFlow(flow);
  assert.deepEqual(Object.fromEntries(Object.entries(readFlow(raw)).filter(([k]) => k in flow)), flow);
  assert.equal(readFlow(raw.slice(0, -2) + "xx"), null);
  assert.equal(readFlow(undefined), null);
  assert.equal(readFlow("not-a-jwt"), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";
const { signAccess, verifyAccess, randomToken, hashToken, randomInviteCode, normalizeInviteCode } =
  await import("../src/auth/tokens.js");

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

test("invite code is short, grouped, and free of ambiguous glyphs", () => {
  const code = randomInviteCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(code.replace(/-/g, "").length, 12);
});

test("invite codes are unique across draws", () => {
  const seen = new Set(Array.from({ length: 200 }, () => randomInviteCode()));
  assert.equal(seen.size, 200);
});

test("invite normalization survives case, separators and misread glyphs", () => {
  const canonical = normalizeInviteCode("K3MN-7PQR-STV0");
  for (const variant of [
    "k3mn-7pqr-stv0",
    "K3MN 7PQR STV0",
    "K3MN7PQRSTV0",
    "K3MN-7PQR-STVO", // O typed for 0
    "K3MN-7PQR-STv0",
  ]) {
    assert.equal(normalizeInviteCode(variant), canonical, variant);
  }
});

test("invite normalization folds U to V and I/L to 1", () => {
  assert.equal(normalizeInviteCode("ABCU"), normalizeInviteCode("ABCV"));
  assert.equal(normalizeInviteCode("ABCI"), normalizeInviteCode("ABC1"));
  assert.equal(normalizeInviteCode("ABCL"), normalizeInviteCode("ABC1"));
});

test("invite normalization keeps distinct codes distinct", () => {
  assert.notEqual(normalizeInviteCode("K3MN-7PQR-STV0"), normalizeInviteCode("K3MN-7PQR-STV1"));
});

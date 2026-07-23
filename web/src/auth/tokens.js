import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function signAccess(user) {
  return jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.accessTtl,
    algorithm: "HS256",
  });
}
export function verifyAccess(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    return { sub: p.sub, role: p.role };
  } catch {
    return null;
  }
}
export function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}
// Crockford base32: no I, L, O or U, so codes can't be misread or spell words.
const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INVITE_LENGTH = 12; // 60 bits — single-use, email-bound and 7-day TTL

/** Short, typeable invite code, grouped as XXXX-XXXX-XXXX for the app's field. */
export function randomInviteCode() {
  const bytes = crypto.randomBytes(INVITE_LENGTH);
  // 256 % 32 === 0, so the modulo is unbiased.
  let out = "";
  for (const b of bytes) out += INVITE_ALPHABET[b % 32];
  return out.match(/.{1,4}/g).join("-");
}

/**
 * Canonical form used for hashing, so lookup survives however the user typed it:
 * case, dashes/spaces, and the ambiguous glyphs Crockford folds (I/L→1, O→0, U→V).
 */
export function normalizeInviteCode(raw) {
  return String(raw)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

export function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

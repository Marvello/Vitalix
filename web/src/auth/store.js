import { query } from "../db.js";
import { randomToken, hashToken } from "./tokens.js";
import { config } from "../config.js";

export async function createUser(email, passwordHash, role = "user") {
  const { rows } = await query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role",
    [email, passwordHash, role]
  );
  return rows[0];
}
export async function findUserByEmail(email) {
  const { rows } = await query("SELECT id, email, role, password_hash FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}
export async function findUserById(id) {
  const { rows } = await query("SELECT id, email, role FROM users WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function issueRefresh(userId) {
  const raw = randomToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)", [userId, hashToken(raw), expires]);
  return raw;
}
export async function rotateRefresh(raw) {
  const { rows } = await query(
    "SELECT rt.id, rt.user_id, u.role, u.email FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()",
    [hashToken(raw)]
  );
  if (rows.length === 0) return null;
  await query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [rows[0].id]);
  const next = await issueRefresh(rows[0].user_id);
  return { user: { id: rows[0].user_id, role: rows[0].role, email: rows[0].email }, rawToken: next };
}
export async function revokeRefresh(raw) {
  await query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(raw)]);
}

export async function createReset(userId) {
  const raw = randomToken();
  await query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)", [userId, hashToken(raw), new Date(Date.now() + config.resetTtlMs)]);
  return raw;
}
export async function consumeReset(raw) {
  const { rows } = await query(
    "UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
    [hashToken(raw)]
  );
  return rows[0]?.user_id ?? null;
}

export async function createInvite(email, role, createdBy) {
  const raw = randomToken();
  await query("INSERT INTO invites (token_hash, email, role, created_by, expires_at) VALUES ($1,$2,$3,$4,$5)", [hashToken(raw), email, role, createdBy, new Date(Date.now() + config.inviteTtlMs)]);
  return raw;
}
export async function consumeInvite(raw) {
  const { rows } = await query(
    "UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email, role",
    [hashToken(raw)]
  );
  return rows[0] ?? null;
}
export async function revokeAllRefresh(userId) {
  await query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

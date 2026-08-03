import { query, withTransaction } from "../db.js";
import { randomToken, randomInviteCode, normalizeInviteCode, hashToken } from "./tokens.js";
import { config } from "../config.js";

export async function createUser(email, passwordHash, role = "user") {
  const { rows } = await query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role",
    [email, passwordHash, role]
  );
  return rows[0];
}
export async function findUserByEmail(email) {
  const { rows } = await query("SELECT id, email, role, password_hash, disabled_at FROM users WHERE email = $1", [email]);
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
  return withTransaction(async (client) => {
    const revoked = await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashToken(raw)]
    );
    if (revoked.rows.length === 0) return null;
    const userId = revoked.rows[0].user_id;
    const u = await client.query("SELECT id, role, email, disabled_at FROM users WHERE id = $1", [userId]);
    if (u.rows.length === 0) return null;
    if (u.rows[0].disabled_at) return null;
    const rawNew = randomToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
      [userId, hashToken(rawNew), expires]
    );
    return { user: { id: u.rows[0].id, role: u.rows[0].role, email: u.rows[0].email }, rawToken: rawNew };
  });
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
  const raw = randomInviteCode();
  await query("INSERT INTO invites (token_hash, email, role, created_by, expires_at) VALUES ($1,$2,$3,$4,$5)", [hashToken(normalizeInviteCode(raw)), email, role, createdBy, new Date(Date.now() + config.inviteTtlMs)]);
  return raw;
}
export async function findValidInvite(raw) {
  const { rows } = await query(
    "SELECT email, role FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [hashToken(normalizeInviteCode(raw))]
  );
  return rows[0] ?? null;
}
export async function consumeInvite(raw) {
  const { rows } = await query(
    "UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email, role",
    [hashToken(normalizeInviteCode(raw))]
  );
  return rows[0] ?? null;
}
export async function revokeAllRefresh(userId) {
  await query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

export async function updatePassword(userId, passwordHash) {
  await query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
}

export async function listUsers() {
  const { rows } = await query(
    "SELECT id, email, role, created_at, disabled_at FROM users ORDER BY created_at DESC"
  );
  return rows;
}

export async function updateUserRole(id, role) {
  await query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
}

export async function setUserDisabled(id, disabled) {
  if (disabled) {
    await query("UPDATE users SET disabled_at = now() WHERE id = $1", [id]);
  } else {
    await query("UPDATE users SET disabled_at = NULL WHERE id = $1", [id]);
  }
}

export async function countAdmins() {
  const { rows } = await query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL");
  return rows[0].n;
}

export async function listInvites() {
  const { rows } = await query(
    `SELECT i.email, i.role, i.created_at, i.expires_at, i.used_at,
            u.email AS created_by_email
       FROM invites i
       LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC`
  );
  return rows;
}

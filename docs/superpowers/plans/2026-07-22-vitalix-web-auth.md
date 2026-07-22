# Vitalix Web Auth + Per-User Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add invite-based accounts (signup/login/forgot/reset), JWT sessions, an admin invite flow, a `create-admin` CLI, and a logged-in web dashboard to the `web/` receiver — and scope all health data per user.

**Architecture:** Passwords via bcrypt; sessions via short-lived JWT access + rotated server-side refresh tokens. One `requireAuth` middleware accepts a Bearer header (app) or an httpOnly cookie (web). Pure security logic (`passwords`, `tokens`) is unit-tested; DB access stays in a thin `auth/store.js`; EJS renders the pages. Health data gains a `user_id` and upserts on `(user_id, day)`.

**Tech Stack:** Node LTS (ESM), Express, pg, node-pg-migrate, bcrypt, jsonwebtoken, cookie-parser, nodemailer, ejs, `node:test`.

## Global Constraints

- Everything under `web/`. ESM. Raw SQL only (in `persist.js` / `auth/store.js`).
- **Security (bind every task):** bcrypt cost ≥ 12; `JWT_SECRET` required (server exits if unset); refresh/reset/invite tokens are 32-byte random, stored only as SHA-256 hashes, single-use where applicable, expiring; refresh tokens rotate on use; **no user enumeration** (login + forgot return generic responses); cookies `httpOnly`+`SameSite=Lax`+`Secure` in production; **identity comes from the verified token, never the request body**.
- Token TTLs: access ~15m, refresh ~30d, reset ~1h, invite ~7d.
- Health ingest/read must be scoped to `req.user.id`. `health_days` unique key becomes `(user_id, day)`.
- Migration clears pre-existing throwaway health rows (they predate users).
- git repo, branch `main`. Commit each task with `git -c user.name='Vitalix Dev' -c user.email='dev@vitalix.local' commit`.
- Metric/ingest contract from the receiver spec is unchanged; only its auth + user scoping change.

---

### Task 1: Dependencies + config

**Files:** Modify `web/package.json`, `web/src/config.js`, `web/.env.example`

**Interfaces:**
- Produces: `config.jwtSecret` (required), `config.accessTtl`, `config.refreshTtl`, `config.resetTtlMs`, `config.inviteTtlMs`, `config.bcryptRounds`, `config.smtp` (or null), `config.mailFrom`, `config.appBaseUrl`, `config.isProd`. Keeps `databaseUrl`, `port`. Removes `authToken`.

- [ ] **Step 1: Add deps**

Run: `cd web && npm install bcrypt jsonwebtoken cookie-parser nodemailer ejs`
Expected: added to `dependencies`, no error.

- [ ] **Step 2: Rewrite `web/src/config.js`**

```js
export const config = {
  databaseUrl: process.env.DATABASE_URL,
  port: Number(process.env.PORT || 3000),
  isProd: process.env.NODE_ENV === "production",
  jwtSecret: process.env.JWT_SECRET,
  accessTtl: process.env.ACCESS_TTL || "15m",
  refreshTtl: process.env.REFRESH_TTL || "30d",
  resetTtlMs: Number(process.env.RESET_TTL_MS || 60 * 60 * 1000),
  inviteTtlMs: Number(process.env.INVITE_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  mailFrom: process.env.MAIL_FROM || "Vitalix <no-reply@vitalix.local>",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  smtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    : null,
};

if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
if (!config.jwtSecret) throw new Error("JWT_SECRET is required");
```

- [ ] **Step 3: Update `web/.env.example`**

```bash
DATABASE_URL=postgres://vitalix:vitalix@localhost:5432/vitalix
PORT=3000
JWT_SECRET=change-me-to-a-long-random-string
APP_BASE_URL=http://localhost:3000
# Optional SMTP; if unset, reset/invite links are logged to the server console
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=apikey
# SMTP_PASS=secret
# MAIL_FROM=Vitalix <no-reply@yourdomain>
```

- [ ] **Step 4: Verify parse**

Run: `cd web && JWT_SECRET=x DATABASE_URL=x node -e "import('./src/config.js').then(m=>console.log(!!m.config.jwtSecret))"`
Expected: prints `true`.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/config.js web/.env.example
git commit -m "feat(web): auth deps + config (JWT/SMTP/bcrypt)"
```

---

### Task 2: Migration — users, tokens, invites, per-user health

**Files:** Create `web/migrations/1721600000000_auth.cjs`

**Interfaces:**
- Produces: tables `users`, `refresh_tokens`, `password_resets`, `invites`; `user_id` on `syncs`/`health_days`; `health_days` unique `(user_id, day)`. `citext` extension enabled.

- [ ] **Step 1: Write the migration**

```js
exports.up = (pgm) => {
  pgm.createExtension("citext", { ifNotExists: true });

  pgm.createTable("users", {
    id: "bigserial",
    email: { type: "citext", notNull: true, unique: true },
    password_hash: { type: "text", notNull: true },
    role: { type: "text", notNull: true, default: "user" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("users", "users_pkey", { primaryKey: "id" });

  const tokenTable = (name, extra = {}) => {
    pgm.createTable(name, {
      id: "bigserial",
      user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" },
      token_hash: { type: "text", notNull: true },
      expires_at: { type: "timestamptz", notNull: true },
      created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
      ...extra,
    });
    pgm.addConstraint(name, `${name}_pkey`, { primaryKey: "id" });
    pgm.createIndex(name, "token_hash");
  };
  tokenTable("refresh_tokens", { revoked_at: { type: "timestamptz" } });
  tokenTable("password_resets", { used_at: { type: "timestamptz" } });

  pgm.createTable("invites", {
    id: "bigserial",
    token_hash: { type: "text", notNull: true },
    email: { type: "citext", notNull: true },
    role: { type: "text", notNull: true, default: "user" },
    created_by: { type: "bigint", references: "users", onDelete: "SET NULL" },
    expires_at: { type: "timestamptz", notNull: true },
    used_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("invites", "invites_pkey", { primaryKey: "id" });
  pgm.createIndex("invites", "token_hash");

  // Per-user health data. Existing throwaway rows predate users → clear them.
  pgm.sql("DELETE FROM day_aggregates; DELETE FROM samples; DELETE FROM exercises; DELETE FROM health_days; DELETE FROM syncs;");
  pgm.addColumn("syncs", { user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" } });
  pgm.addColumn("health_days", { user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" } });
  pgm.dropConstraint("health_days", "health_days_day_key", { ifExists: true }); // the UNIQUE(day) auto-name
  pgm.addConstraint("health_days", "health_days_user_day_key", { unique: ["user_id", "day"] });
};

exports.down = (pgm) => {
  pgm.dropConstraint("health_days", "health_days_user_day_key");
  pgm.addConstraint("health_days", "health_days_day_key", { unique: "day" });
  pgm.dropColumn("health_days", "user_id");
  pgm.dropColumn("syncs", "user_id");
  pgm.dropTable("invites");
  pgm.dropTable("password_resets");
  pgm.dropTable("refresh_tokens");
  pgm.dropTable("users");
};
```

- [ ] **Step 2: Note on the dropped constraint name.** The v1 migration created `day UNIQUE` inline, which node-pg-migrate names `health_days_day_key`. If `docker compose` migration fails on that name, check the actual name with `\d health_days` and adjust. (Verified at Task 10.)

- [ ] **Step 3: Commit**

```bash
git add web/migrations/1721600000000_auth.cjs
git commit -m "feat(db): auth tables + per-user health scoping"
```

---

### Task 3: passwords + tokens (pure) — TDD

**Files:** Create `web/src/auth/passwords.js`, `web/src/auth/tokens.js`; tests `web/test/passwords.test.js`, `web/test/tokens.test.js`

**Interfaces:**
- `passwords.hash(pw): Promise<string>`, `passwords.verify(pw, hash): Promise<boolean>`
- `tokens.signAccess({id, role}): string`, `tokens.verifyAccess(jwt): {sub, role}|null`
- `tokens.randomToken(): string` (hex), `tokens.hashToken(raw): string` (sha256 hex)

- [ ] **Step 1: Write `web/test/passwords.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { hash, verify } from "../src/auth/passwords.js";

test("hash then verify", async () => {
  const h = await hash("s3cret!");
  assert.notEqual(h, "s3cret!");
  assert.equal(await verify("s3cret!", h), true);
  assert.equal(await verify("wrong", h), false);
});
```

- [ ] **Step 2: Write `web/test/tokens.test.js`**

```js
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
```

- [ ] **Step 3: Run → RED**

Run: `cd web && node --test test/passwords.test.js test/tokens.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `web/src/auth/passwords.js`**

```js
import bcrypt from "bcrypt";
import { config } from "../config.js";

export function hash(password) {
  return bcrypt.hash(password, config.bcryptRounds);
}
export function verify(password, hashStr) {
  return bcrypt.compare(password, hashStr);
}
```

- [ ] **Step 5: Implement `web/src/auth/tokens.js`**

```js
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function signAccess(user) {
  return jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.accessTtl,
  });
}
export function verifyAccess(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return { sub: p.sub, role: p.role };
  } catch {
    return null;
  }
}
export function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}
export function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
```

- [ ] **Step 6: Run → GREEN**

Run: `cd web && node --test test/passwords.test.js test/tokens.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/auth/passwords.js web/src/auth/tokens.js web/test/passwords.test.js web/test/tokens.test.js
git commit -m "feat(auth): bcrypt passwords + JWT/token helpers with tests"
```

---

### Task 4: auth store (DB) + mailer

**Files:** Create `web/src/auth/store.js`, `web/src/auth/mailer.js`

**Interfaces:**
- `store.createUser(email, passwordHash, role)`, `findUserByEmail(email)`, `findUserById(id)`
- `store.issueRefresh(userId): Promise<rawToken>`, `rotateRefresh(rawToken): Promise<{user, rawToken}|null>`, `revokeRefresh(rawToken)`
- `store.createReset(userId): Promise<rawToken>`, `consumeReset(rawToken): Promise<userId|null>`
- `store.createInvite(email, role, createdBy): Promise<rawToken>`, `consumeInvite(rawToken): Promise<{email, role}|null>`
- `mailer.sendMail(to, subject, body): Promise<void>`

- [ ] **Step 1: Implement `web/src/auth/mailer.js`**

```js
import nodemailer from "nodemailer";
import { config } from "../config.js";

const transport = config.smtp
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export async function sendMail(to, subject, body) {
  if (!transport) {
    console.log(`[mail:log] to=${to} subject=${subject}\n${body}`);
    return;
  }
  await transport.sendMail({ from: config.mailFrom, to, subject, text: body });
}
```

- [ ] **Step 2: Implement `web/src/auth/store.js`**

```js
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
```

- [ ] **Step 3: Parse-check**

Run: `cd web && node --check src/auth/store.js && node --check src/auth/mailer.js`
Expected: no output (ok). (DB-backed behavior verified in Task 10.)

- [ ] **Step 4: Commit**

```bash
git add web/src/auth/store.js web/src/auth/mailer.js
git commit -m "feat(auth): user/refresh/reset/invite store + mailer"
```

---

### Task 5: auth middleware

**Files:** Create `web/src/auth/middleware.js`

**Interfaces:**
- `requireAuth(req,res,next)` — reads Bearer header OR `access` cookie → verifies → sets `req.user = {id, role}`; 401 (API) or redirect `/login` (page requests) on failure.
- `requireAdmin(req,res,next)` — 403 unless `req.user.role === 'admin'`.

- [ ] **Step 1: Implement**

```js
import { verifyAccess } from "./tokens.js";

function extractToken(req) {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  if (req.cookies?.access) return req.cookies.access;
  return null;
}

export function requireAuth(req, res, next) {
  const token = extractToken(req);
  const claims = token ? verifyAccess(token) : null;
  if (!claims) {
    if (req.accepts(["html", "json"]) === "html") return res.redirect("/login");
    return res.status(401).json({ error: "unauthorized" });
  }
  req.user = { id: Number(claims.sub), role: claims.role };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "forbidden" });
  next();
}
```

- [ ] **Step 2: Parse-check** — `cd web && node --check src/auth/middleware.js`. Expected: ok.

- [ ] **Step 3: Commit**

```bash
git add web/src/auth/middleware.js
git commit -m "feat(auth): Bearer-or-cookie auth middleware + requireAdmin"
```

---

### Task 6: auth routes + admin invites

**Files:** Create `web/src/routes/auth.js`, `web/src/routes/admin.js`

**Interfaces:**
- `authRouter`: POST `/api/auth/signup|login|refresh|logout|forgot|reset`.
- `adminRouter`: POST `/api/admin/invites` (requireAuth+requireAdmin).
- Helper `setAuthCookies(res, access, refresh)` / `clearAuthCookies(res)` exported for pages to reuse.

- [ ] **Step 1: Implement `web/src/routes/auth.js`**

```js
import { Router } from "express";
import { hash, verify } from "../auth/passwords.js";
import { signAccess } from "../auth/tokens.js";
import * as store from "../auth/store.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";

export const authRouter = Router();

export function setAuthCookies(res, access, refresh) {
  const base = { httpOnly: true, sameSite: "lax", secure: config.isProd };
  res.cookie("access", access, { ...base, maxAge: 15 * 60 * 1000 });
  res.cookie("refresh", refresh, { ...base, maxAge: 30 * 24 * 60 * 60 * 1000, path: "/" });
}
export function clearAuthCookies(res) {
  res.clearCookie("access");
  res.clearCookie("refresh");
}

async function issueSession(res, user) {
  const access = signAccess(user);
  const refresh = await store.issueRefresh(user.id);
  setAuthCookies(res, access, refresh);
  return { access, refresh };
}

authRouter.post("/api/auth/signup", async (req, res) => {
  const { token, email, password } = req.body || {};
  if (!token || !email || !password) return res.status(400).json({ error: "token, email, password required" });
  const invite = await store.consumeInvite(token);
  if (!invite) return res.status(400).json({ error: "invite invalid or expired" });
  if (invite.email.toLowerCase() !== String(email).toLowerCase()) return res.status(400).json({ error: "invite email mismatch" });
  if (await store.findUserByEmail(email)) return res.status(400).json({ error: "account already exists" });
  const user = await store.createUser(email, await hash(password), invite.role);
  const tokens = await issueSession(res, user);
  res.status(201).json({ ...tokens, user: { id: user.id, email: user.email, role: user.role } });
});

authRouter.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? await store.findUserByEmail(email) : null;
  if (!user || !(await verify(password || "", user.password_hash))) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const tokens = await issueSession(res, { id: user.id, role: user.role });
  res.json({ ...tokens, user: { id: user.id, email: user.email, role: user.role } });
});

authRouter.post("/api/auth/refresh", async (req, res) => {
  const raw = req.body?.refresh || req.cookies?.refresh;
  const rotated = raw ? await store.rotateRefresh(raw) : null;
  if (!rotated) return res.status(401).json({ error: "invalid refresh token" });
  const access = signAccess(rotated.user);
  setAuthCookies(res, access, rotated.rawToken);
  res.json({ access, refresh: rotated.rawToken });
});

authRouter.post("/api/auth/logout", async (req, res) => {
  const raw = req.body?.refresh || req.cookies?.refresh;
  if (raw) await store.revokeRefresh(raw);
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.post("/api/auth/forgot", async (req, res) => {
  const { email } = req.body || {};
  const user = email ? await store.findUserByEmail(email) : null;
  if (user) {
    const raw = await store.createReset(user.id);
    const link = `${config.appBaseUrl}/reset?token=${raw}`;
    await sendMail(user.email, "Reset your Vitalix password", `Reset your password: ${link}\nThis link expires in 1 hour.`);
  }
  res.json({ ok: true }); // generic — no enumeration
});

authRouter.post("/api/auth/reset", async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: "token and password required" });
  const userId = await store.consumeReset(token);
  if (!userId) return res.status(400).json({ error: "reset token invalid or expired" });
  await store.updatePassword(userId, await hash(password));
  await store.revokeAllRefresh(userId);
  res.json({ ok: true });
});
```

- [ ] **Step 2: Add `updatePassword` to `web/src/auth/store.js`** (append):

```js
export async function updatePassword(userId, passwordHash) {
  await query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
}
```

- [ ] **Step 3: Implement `web/src/routes/admin.js`**

```js
import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import * as store from "../auth/store.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";

export const adminRouter = Router();

adminRouter.post("/api/admin/invites", requireAuth, requireAdmin, async (req, res) => {
  const { email, role } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const raw = await store.createInvite(email, role === "admin" ? "admin" : "user", req.user.id);
  const link = `${config.appBaseUrl}/signup?token=${raw}`;
  await sendMail(email, "You're invited to Vitalix", `You've been invited. Complete signup: ${link}\nOr enter this code in the app: ${raw}\nExpires in 7 days.`);
  res.status(201).json({ ok: true });
});
```

- [ ] **Step 4: Parse-check** all three. `cd web && node --check src/routes/auth.js && node --check src/routes/admin.js && node --check src/auth/store.js`. Expected: ok.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/auth.js web/src/routes/admin.js web/src/auth/store.js
git commit -m "feat(auth): signup/login/refresh/logout/forgot/reset + admin invites"
```

---

### Task 7: per-user health ingest + reads

**Files:** Modify `web/src/persist.js`, `web/src/routes/health.js`

**Interfaces:**
- `persist(userId, mapped)` — sets `user_id` on `syncs`/`health_days`; upsert on `(user_id, day)`.
- health routes use `requireAuth`; ingest + reads scoped to `req.user.id`.

- [ ] **Step 1: Update `persist.js`** — change the signature and the two inserts:

`export function persist(userId, mapped) {` — then in the `syncs` insert add `user_id`:
```js
const { rows } = await client.query(
  "INSERT INTO syncs (user_id, source, app_version, device, exported_at, range_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
  [userId, mapped.sync.source, mapped.sync.app_version, mapped.sync.device, mapped.sync.exported_at, mapped.sync.range_days]
);
```
And in `upsertDay`, add `user_id` to the column list, values, and change the conflict target:
```js
const cols = ["sync_id", "user_id", "day", ...DAY_COLUMNS];
const values = [syncId, userId, day.day, ...DAY_COLUMNS.map((c) => day.scalars[c] ?? null)];
// ...ON CONFLICT (user_id, day) DO UPDATE SET ...
```
Pass `userId` from `persist` into `upsertDay(client, syncId, userId, day)`.

- [ ] **Step 2: Update `web/src/routes/health.js`** — add `requireAuth` and scope by user:

```js
import { requireAuth } from "../auth/middleware.js";
// POST /api/health:
router.post("/api/health", requireAuth, async (req, res) => {
  // ...validation...
  const mapped = mapPayload(body);
  const inserted = await persist(req.user.id, mapped);
  res.status(200).json({ inserted, skipped: mapped.skipped });
});
// GET /api/days:
router.get("/api/days", requireAuth, async (req, res) => {
  // ...defaults...
  const { rows } = await query(
    "SELECT * FROM health_days WHERE user_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day DESC",
    [req.user.id, from, to]
  );
  res.json(rows);
});
// GET /api/days/:date:
router.get("/api/days/:date", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, req.params.date]);
  // ...404 / aggregates / samples / exercises by day_id as before...
});
```
Remove the old `bearerAuth` import/usage and delete `web/src/auth.js` (the shared-token middleware) — it's replaced by `auth/middleware.js`. `/healthz` stays public.

- [ ] **Step 3: Parse-check** — `cd web && node --check src/persist.js && node --check src/routes/health.js`. Expected ok. (Full behavior at Task 10.)

- [ ] **Step 4: Commit**

```bash
git add web/src/persist.js web/src/routes/health.js
git rm web/src/auth.js
git commit -m "feat(web): scope health ingest + reads per authenticated user"
```

---

### Task 8: EJS pages + dashboard + app wiring

**Files:** Create `web/views/{layout,login,signup,forgot,reset,dashboard,day}.ejs`, `web/src/routes/pages.js`; modify `web/src/index.js`

**Interfaces:**
- `pagesRouter`: GET `/login /signup /forgot /reset /dashboard /dashboard/:date` + POST form handlers that reuse `store`/`passwords`/cookies.
- `index.js`: `app.set("view engine","ejs")`, `cookieParser()`, mount authRouter/adminRouter/pagesRouter/health router.

- [ ] **Step 1: `web/src/index.js`** — wire everything:

```js
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { router as healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { pagesRouter } from "./routes/pages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../views"));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(healthRouter);
app.use(authRouter);
app.use(adminRouter);
app.use(pagesRouter);

app.listen(config.port, () => console.log(`vitalix receiver listening on :${config.port}`));
export { app };
```

- [ ] **Step 2: `web/src/routes/pages.js`** — render + handle form posts (reuse the same helpers as the API):

```js
import { Router } from "express";
import { hash, verify } from "../auth/passwords.js";
import { signAccess } from "../auth/tokens.js";
import * as store from "../auth/store.js";
import { setAuthCookies } from "./auth.js";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";

export const pagesRouter = Router();
const show = (res, view, extra = {}) => res.render(view, { error: null, ...extra });

pagesRouter.get("/login", (req, res) => show(res, "login"));
pagesRouter.get("/signup", (req, res) => show(res, "signup", { token: req.query.token || "" }));
pagesRouter.get("/forgot", (req, res) => show(res, "forgot", { sent: false }));
pagesRouter.get("/reset", (req, res) => show(res, "reset", { token: req.query.token || "" }));

pagesRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = email ? await store.findUserByEmail(email) : null;
  if (!user || !(await verify(password || "", user.password_hash))) return show(res, "login", { error: "Invalid email or password." });
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});

pagesRouter.post("/signup", async (req, res) => {
  const { token, email, password } = req.body;
  const invite = token ? await store.consumeInvite(token) : null;
  if (!invite || invite.email.toLowerCase() !== String(email || "").toLowerCase()) return show(res, "signup", { token, error: "Invite invalid, expired, or email mismatch." });
  if (await store.findUserByEmail(email)) return show(res, "signup", { token, error: "Account already exists." });
  const user = await store.createUser(email, await hash(password), invite.role);
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});

pagesRouter.post("/forgot", async (req, res) => {
  const user = req.body.email ? await store.findUserByEmail(req.body.email) : null;
  if (user) {
    const raw = await store.createReset(user.id);
    await sendMail(user.email, "Reset your Vitalix password", `${config.appBaseUrl}/reset?token=${raw}`);
  }
  show(res, "forgot", { sent: true });
});

pagesRouter.post("/reset", async (req, res) => {
  const { token, password } = req.body;
  const userId = token ? await store.consumeReset(token) : null;
  if (!userId) return show(res, "reset", { token: "", error: "Reset link invalid or expired." });
  await store.updatePassword(userId, await hash(password));
  await store.revokeAllRefresh(userId);
  res.redirect("/login");
});

pagesRouter.post("/logout", async (req, res) => {
  if (req.cookies?.refresh) await store.revokeRefresh(req.cookies.refresh);
  res.clearCookie("access"); res.clearCookie("refresh");
  res.redirect("/login");
});

pagesRouter.get("/dashboard", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT day, steps, sleep_duration_minutes FROM health_days WHERE user_id = $1 ORDER BY day DESC LIMIT 30", [req.user.id]);
  res.render("dashboard", { days: rows, email: (await store.findUserById(req.user.id))?.email });
});

pagesRouter.get("/dashboard/:date", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, req.params.date]);
  if (rows.length === 0) return res.status(404).render("day", { day: null, samples: [], aggregates: [], exercises: [], date: req.params.date });
  const d = rows[0];
  const [aggs, samples, ex] = await Promise.all([
    query("SELECT metric,min,max,avg FROM day_aggregates WHERE day_id=$1", [d.id]),
    query("SELECT metric,start_at,end_at,value_num,value_secondary,value_text FROM samples WHERE day_id=$1 ORDER BY start_at LIMIT 500", [d.id]),
    query("SELECT name,start_at,duration_minutes FROM exercises WHERE day_id=$1", [d.id]),
  ]);
  res.render("day", { day: d, aggregates: aggs.rows, samples: samples.rows, exercises: ex.rows, date: req.params.date });
});
```

- [ ] **Step 3: EJS templates.** Create a shared `views/layout.ejs` header/footer (Vitalix palette `#0FA9A0`/`#34D399`, inline `<style>`), and the pages. Minimal, functional forms. Example `views/login.ejs`:

```html
<!doctype html><html><head><title>Vitalix — Log in</title><style>
body{font-family:Inter,system-ui,sans-serif;max-width:420px;margin:6vh auto;padding:0 20px;color:#0E1B2B}
h1{color:#0FA9A0} input{display:block;width:100%;padding:10px;margin:8px 0;border:1px solid #cbd5e1;border-radius:8px}
button{background:#0FA9A0;color:#fff;border:0;padding:11px 16px;border-radius:8px;width:100%;font-size:16px}
.err{color:#b91c1c} a{color:#0FA9A0}</style></head><body>
<h1>Vitalix</h1><h2>Log in</h2>
<% if (error) { %><p class="err"><%= error %></p><% } %>
<form method="post" action="/login">
  <input name="email" type="email" placeholder="Email" required>
  <input name="password" type="password" placeholder="Password" required>
  <button type="submit">Log in</button>
</form>
<p><a href="/forgot">Forgot password?</a></p>
<p>Have an invite? <a href="/signup">Sign up</a></p>
</body></html>
```
Build `signup.ejs` (fields: token, email, password — prefill token from `<%= token %>`), `forgot.ejs` (email; show "If that email exists, a reset link was sent." when `sent`), `reset.ejs` (token hidden/prefilled + new password), `dashboard.ejs` (greet `email`, table of `days` linking to `/dashboard/<day>`, a logout form POSTing `/logout`), `day.ejs` (day scalars + aggregates + first 500 samples + exercises, or "No data" when `day` is null). Keep them consistent with the login styling.

- [ ] **Step 4: Build check** — `cd web && node --check src/index.js src/routes/pages.js`. Expected ok. (Rendering verified at Task 10.)

- [ ] **Step 5: Commit**

```bash
git add web/src/index.js web/src/routes/pages.js web/views
git commit -m "feat(web): EJS auth pages + dashboard, wire app"
```

---

### Task 9: create-admin CLI

**Files:** Create `web/scripts/create-admin.js`; modify `web/package.json` (script)

**Interfaces:** `npm run create-admin -- <email> <password>` → inserts an admin; refuses duplicate; exits nonzero on misuse.

- [ ] **Step 1: `web/scripts/create-admin.js`**

```js
import { hash } from "../src/auth/passwords.js";
import * as store from "../src/auth/store.js";
import { pool } from "../src/db.js";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: npm run create-admin -- <email> <password>");
  process.exit(2);
}
try {
  if (await store.findUserByEmail(email)) {
    console.error(`User ${email} already exists.`);
    process.exit(1);
  }
  const user = await store.createUser(email, await hash(password), "admin");
  console.log(`Created admin ${user.email} (id ${user.id}).`);
} finally {
  await pool.end();
}
```

- [ ] **Step 2: Add script** to `web/package.json` scripts: `"create-admin": "node scripts/create-admin.js"`.

- [ ] **Step 3: Parse-check** — `cd web && node --check scripts/create-admin.js`. Expected ok. (Run against DB at Task 10.)

- [ ] **Step 4: Commit**

```bash
git add web/scripts/create-admin.js web/package.json
git commit -m "feat(web): create-admin CLI"
```

---

### Task 10: docker + full end-to-end verification

**Files:** Modify `web/docker-compose.yml` (add `JWT_SECRET`, `APP_BASE_URL`; remove `AUTH_TOKEN`)

- [ ] **Step 1: Update compose `app.environment`** — add `JWT_SECRET: dev-secret-change-me`, `APP_BASE_URL: http://localhost:3000`, `NODE_ENV: development`; remove `AUTH_TOKEN`.

- [ ] **Step 2: Bring up** — `cd web && docker compose up --build -d && sleep 8`. Confirm app log "listening on :3000" and migrations ran (both `..._init` and `..._auth`). If the migration errored on the `health_days_day_key` constraint name, exec into db (`docker compose exec db psql -U vitalix -c '\d health_days'`), find the real unique-constraint name, fix the migration's `dropConstraint`, and re-up.

- [ ] **Step 3: Create an admin** — `cd web && docker compose exec app npm run create-admin -- admin@vitalix.local adminpass123`. Expected: "Created admin ...".

- [ ] **Step 4: Admin logs in, mints an invite** —
```bash
ACCESS=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@vitalix.local","password":"adminpass123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access"])')
curl -s -X POST localhost:3000/api/admin/invites -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d '{"email":"user@vitalix.local"}'
```
Expected: `{"ok":true}`; the invite link/code is printed in `docker compose logs app` (mail:log). Grab the token from the logged link.

- [ ] **Step 5: Signup consumes invite** —
```bash
curl -s -X POST localhost:3000/api/auth/signup -H 'Content-Type: application/json' -d '{"token":"<TOKEN>","email":"user@vitalix.local","password":"userpass123"}'
```
Expected: 201 with `access`/`refresh`. Re-running with the same token → 400 (single-use).

- [ ] **Step 6: Per-user ingest + isolation** — log in as user, POST a day to `/api/health` with the user's Bearer, GET `/api/days` → the day appears. Log in as admin, GET `/api/days` → admin does NOT see the user's day (empty). Confirms `(user_id, day)` scoping.

- [ ] **Step 7: Unauthed ingest rejected** — `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:3000/api/health -H 'Content-Type: application/json' -d '{"days":[]}'` → `401`.

- [ ] **Step 8: Forgot/reset** — POST `/api/auth/forgot {email:user}` → 200; grab reset link from logs; POST `/api/auth/reset {token,password:newpass}` → 200; old password login → 401, new password → 200.

- [ ] **Step 9: Pages smoke** — `curl -s localhost:3000/login | grep -q "Log in"` and `curl -s localhost:3000/signup | grep -qi "sign up"` → both succeed. Dashboard without cookie → redirect to /login (`curl -s -o /dev/null -w "%{http_code}" localhost:3000/dashboard` → 302).

- [ ] **Step 10: Run unit tests** — `cd web && node --test`. Expected: passwords + tokens + mapPayload tests all pass.

- [ ] **Step 11: Tear down + commit** — `docker compose down`; commit compose change.

```bash
git add web/docker-compose.yml
git commit -m "feat(web): compose env for auth (JWT_SECRET/APP_BASE_URL), e2e verified"
```

---

## Self-Review notes

- **Spec coverage:** deps/config incl. required JWT_SECRET (T1); all auth tables + per-user columns + unique swap + data reset (T2); bcrypt + JWT/token helpers TDD (T3); user/refresh/reset/invite store + mailer log-fallback (T4); Bearer-or-cookie middleware + admin (T5); signup(invite)/login/refresh/logout/forgot/reset + admin invites emailed (T6); per-user ingest+reads, old shared token removed (T7); EJS pages + dashboard (T8); create-admin CLI (T9); docker + e2e incl. per-user isolation, single-use invite, unauth 401, forgot/reset, no-enumeration (T10). ✅
- **Type/name consistency:** `store.updatePassword` added in T6 and used by T6/T8; `setAuthCookies` exported from `routes/auth.js` and reused by `pages.js`; `persist(userId, mapped)` (T7) matches health route call; `verifyAccess` returns `{sub,role}` consumed by middleware. ✅
- **No-enumeration** enforced in both API (T6) and pages (T8) login/forgot.
- **Deferred verification:** T2/T4/T6/T7/T9 have no standalone runtime test (need live PG); all exercised by T10 e2e. Pure units (T3) are unit-tested.

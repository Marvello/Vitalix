# Vitalix Auth + Per-User Data (Design)

**Date:** 2026-07-22
**Status:** Draft for review
**Touches:** `web/` (receiver + new UI) and `android/` (`com.android.vitalix`)
**Builds on:** `2026-07-21-vitalix-receiver-design.md`, `2026-07-21-vitalix-health-forwarder-design.md`

---

## Summary

Add user accounts (login, invite-based signup, forgot-password) to both the web receiver and
the Android app, and scope all health data per user. Today the receiver ingests under a single
shared bearer token and `health_days.day` is globally unique. After this change, identity comes
from a per-user JWT, every health row belongs to a user, and the web gains real UI (auth pages +
a logged-in dashboard).

### Locked decisions

| Question | Decision |
|----------|----------|
| Web scope | Full web UI: signup/login/forgot/reset pages **+** a logged-in dashboard showing the user's data |
| Session model | JWT **access** (~15 min) + **refresh** (~30 days, rotated, server-side hash, revocable); bcrypt passwords |
| App auth transport | `Authorization: Bearer <access-jwt>`; web uses an `httpOnly` cookie holding the access JWT |
| Registration | **Invite-only.** Admin mints an invite for an email; the invite is **emailed** to that address; signup consumes the token |
| Admin bootstrap | **`npm run create-admin`** CLI (email + password args) — not env-seeded |
| Forgot password | Single-use, expiring reset token; emailed via SMTP if configured, else the link is **logged to the server console** |
| App features | Login **+** invite-code signup **+** forgot-password (all three) |

---

## Security constraints (bind every task)

- Passwords: **bcrypt**, cost ≥ 12. Never logged, never returned.
- JWT signed with `JWT_SECRET` (env, **required** — server refuses to start without it). Access token carries `sub` (user id), `role`, `exp`.
- Refresh, reset, and invite tokens are random 32+ bytes; only their **SHA-256 hashes** are stored. Raw token travels once (cookie / email / API response) and is never persisted.
- Reset & invite tokens are **single-use** and **expire** (reset ~1 h, invite ~7 days). Refresh tokens **rotate** on use; the old one is revoked.
- **No user enumeration:** login and forgot-password return the same generic response whether or not the email exists.
- Web cookies: `httpOnly`, `SameSite=Lax`, `Secure` when `NODE_ENV=production`.
- Ingest/read identity is taken from the **verified token only**, never from the request body.

---

## Data model (new migration)

New tables:

### `users`
`id BIGSERIAL PK`, `email CITEXT UNIQUE NOT NULL` (case-insensitive), `password_hash TEXT NOT NULL`,
`role TEXT NOT NULL DEFAULT 'user'` (`user|admin`), `created_at TIMESTAMPTZ DEFAULT now()`.
(Enable the `citext` extension in the migration.)

### `refresh_tokens`
`id`, `user_id → users ON DELETE CASCADE`, `token_hash TEXT NOT NULL`, `expires_at TIMESTAMPTZ NOT NULL`,
`revoked_at TIMESTAMPTZ NULL`, `created_at`. Index `(token_hash)`.

### `password_resets`
`id`, `user_id → users ON DELETE CASCADE`, `token_hash TEXT NOT NULL`, `expires_at TIMESTAMPTZ NOT NULL`,
`used_at TIMESTAMPTZ NULL`. Index `(token_hash)`.

### `invites`
`id`, `token_hash TEXT NOT NULL`, `email CITEXT NOT NULL`, `role TEXT NOT NULL DEFAULT 'user'`,
`created_by → users`, `expires_at TIMESTAMPTZ NOT NULL`, `used_at TIMESTAMPTZ NULL`. Index `(token_hash)`.

### Per-user health data (altering existing tables)
- Add `user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE` to **`syncs`** and **`health_days`**.
- **Drop** `health_days.day` global `UNIQUE`; **add** `UNIQUE (user_id, day)`.
- `day_aggregates`, `samples`, `exercises` stay keyed by `day_id` (already cascade from `health_days`), so they inherit user scoping transitively.
- **Migration clears any pre-existing health rows** (`syncs`/`health_days` and cascaded children): they are throwaway test data that predate users and cannot be attributed. Auth tables + columns are added fresh. This is a dev-data reset, called out in the migration and the plan.

---

## Web (`web/`)

### New dependencies
`bcrypt`, `jsonwebtoken`, `cookie-parser`, `nodemailer`, `ejs` (all runtime deps).

### New / changed modules
| File | Role |
|------|------|
| `src/auth/passwords.js` | `hash(password)`, `verify(password, hash)` (bcrypt) — pure-ish, unit-testable |
| `src/auth/tokens.js` | JWT `signAccess(user)`, `verifyAccess(jwt)`; refresh: `issueRefresh(userId)`, `rotateRefresh(raw)`, `revoke(raw)`; `randomToken()`/`hashToken()` helpers |
| `src/auth/middleware.js` | `requireAuth` (accepts Bearer header **or** access cookie → sets `req.user`); `requireAdmin` |
| `src/auth/mailer.js` | `sendMail(to, subject, body)` — nodemailer via SMTP env; if unset, log the message (incl. links) to console |
| `src/routes/auth.js` | `POST /api/auth/signup` (invite token + password), `/login`, `/refresh`, `/logout`, `/forgot`, `/reset` |
| `src/routes/admin.js` | `POST /api/admin/invites` (admin only: email → mint + email invite) |
| `src/routes/pages.js` | EJS pages: `GET /signup`, `/login`, `/forgot`, `/reset`, `/dashboard`, `/dashboard/:date`; form POSTs reuse the auth logic |
| `views/*.ejs` | Templates + a small shared layout, styled with the Vitalix palette |
| `scripts/create-admin.js` | `npm run create-admin -- <email> <password>` → inserts an admin (bcrypt); refuses duplicates |

### Changed existing modules
- `routes/health.js`: `POST /api/health`, `GET /api/days`, `GET /api/days/:date` now use `requireAuth`; pass `req.user.id` into `persist`/queries. The shared `AUTH_TOKEN` bearer check is removed.
- `persist.js`: `persist(userId, mapped)` — sets `user_id` on `syncs`/`health_days`; upsert `ON CONFLICT (user_id, day)`.
- `config.js`: add `jwtSecret` (required), `accessTtl`, `refreshTtl`, SMTP settings, `appBaseUrl` (for links in emails). Drop the old `authToken`.

### Web auth flow
- Login/signup POST → server sets access JWT in an `httpOnly` cookie + issues a refresh cookie; redirect to `/dashboard`.
- `/dashboard` uses `requireAuth` (cookie) → renders the user's recent `health_days` + links to day detail.
- Logout clears cookies + revokes the refresh token.

---

## Android (`android/`)

### New units
| File | Role |
|------|------|
| `AuthStore.kt` | EncryptedSharedPreferences: `accessToken`, `refreshToken`, `email`, `clear()`. Extends the existing secure-prefs pattern (sibling to `SyncSettings`). |
| `AuthClient.kt` | OkHttp calls: `login`, `signup(inviteCode, email, password)`, `forgot(email)`, `refresh()` → returns tokens; parses JSON. |
| `LoginActivity.kt` + layout | Email/password + "Sign up" and "Forgot password" links. |
| `SignupActivity.kt` + layout | Invite code + email + password. |
| `ForgotActivity.kt` + layout | Email → triggers reset email; generic confirmation. |

### Changes
- **App launch gate:** `MainActivity` (or a launcher activity) checks `AuthStore` for a valid session; if none, routes to `LoginActivity`. After login, proceeds to the sync screen.
- `ServerForwarder.forward` and reads now attach `Authorization: Bearer <accessToken>`; on **401**, call `AuthClient.refresh()` once, update `AuthStore`, and retry. If refresh fails → clear session, surface "Session expired — please log in."
- Remove the manual **auth-token field** from the sync UI (replaced by login). **Server URL stays** configurable.
- `ExportWorker`: same refresh-on-401 logic; if refresh fails, `Result.failure()` and (optional) a notification "session expired."
- `SyncSettings` keeps metric/schedule config; server creds (token) move to `AuthStore`. Server URL can stay in `SyncSettings`.

---

## API summary

| Method | Path | Auth | Body / result |
|--------|------|------|---------------|
| POST | `/api/auth/signup` | invite token | `{token, email, password}` → creates user, returns access+refresh |
| POST | `/api/auth/login` | none | `{email, password}` → access+refresh (generic 401 on failure) |
| POST | `/api/auth/refresh` | refresh token | rotates → new access+refresh |
| POST | `/api/auth/logout` | refresh token | revokes refresh, clears cookies |
| POST | `/api/auth/forgot` | none | `{email}` → always 200 generic; emails/logs reset link if user exists |
| POST | `/api/auth/reset` | reset token | `{token, password}` → sets new password, revokes sessions |
| POST | `/api/admin/invites` | admin | `{email, role?}` → mints + emails invite; returns 201 |
| POST | `/api/health` | user | ingest scoped to `req.user.id` |
| GET | `/api/days`, `/api/days/:date` | user | that user's data only |
| GET | `/signup /login /forgot /reset /dashboard` | pages | EJS |

---

## Error handling

| Condition | Behavior |
|-----------|----------|
| Missing/invalid access token | 401 (API) / redirect to `/login` (pages) |
| Expired access, valid refresh | App/web refresh flow issues a new access token |
| Invalid/expired/used invite | 400 generic "invite invalid or expired" |
| Invalid/expired/used reset token | 400 generic |
| Login bad creds / unknown email | 401 generic (no enumeration) |
| Forgot for unknown email | 200 generic (no enumeration); no email sent |
| Non-admin hits admin route | 403 |
| `JWT_SECRET` unset at boot | Server exits with a clear error |

---

## Testing

| Test | Type | Asserts |
|------|------|---------|
| `passwords` hash/verify | unit | verify true for right password, false otherwise; hash ≠ plaintext |
| `tokens` sign/verify + hashToken | unit | access round-trips `sub`/`role`; tampered token rejected; `hashToken` deterministic |
| refresh rotation | integration (docker PG) | rotate revokes old, issues new; revoked/expired rejected |
| signup/login/forgot/reset flows | integration | invite consumed once; reset single-use; generic no-enumeration responses |
| per-user isolation | integration | user A cannot read/ingest into user B's days; `(user_id, day)` upsert independent per user |
| `create-admin` CLI | integration | inserts admin; refuses duplicate email |
| Android `AuthStore`/`AuthClient` | unit | token persistence round-trip; request builds Bearer header; refresh-on-401 retry logic (pure part) |

---

## Out of scope (v1)

- Email verification of the signup address (invite email already proves control).
- Social / OAuth login.
- Roles beyond `user`/`admin`; per-user admin UI for managing users (only invite minting).
- Rate limiting / lockout (note as a hardening follow-up).
- Multi-device refresh-token management UI.

# Admin Panel & User Invitation System

**Date:** 2026-08-03
**Status:** Draft
**Feature request:** `docs/feature-request/02-bug-fixes.md`

## Goal

Give admins a web UI to invite users, manage accounts (role changes, soft-disable), and list invites. Invite emails include a Zealot download link fetched from the Zealot API.

## Constraints

- Follow existing EJS + Express patterns (no frontend framework)
- Backend invite API already exists (`POST /api/admin/invites`) — extend, don't replace
- Zealot API integration is best-effort (email still sends if Zealot is unreachable)
- Soft-delete only — disabled users can't login but data is preserved

## 1. Database migration

Single migration: add `disabled_at` column to `users`.

```sql
ALTER TABLE users ADD COLUMN disabled_at timestamptz;
```

- `NULL` = active, non-null = disabled
- No new tables — the existing `invites` table covers invite tracking

## 2. API endpoints

All admin endpoints require `requireAuth` + `requireAdmin`.

| Method | Path | Body / Query | Response |
|--------|------|-------------|----------|
| `GET` | `/api/admin/users` | — | `[{ id, email, role, created_at, disabled_at }]` |
| `PATCH` | `/api/admin/users/:id` | `{ role?, disabled? }` | `{ ok: true }` |
| `GET` | `/api/admin/invites` | — | `[{ email, role, created_by, created_at, expires_at, used_at }]` |
| `POST` | `/api/admin/invites` | `{ email, role? }` | `{ ok: true }` (existing — enhanced) |

### `PATCH /api/admin/users/:id`

- `role`: set to `"admin"` or `"user"`. Admin cannot demote themselves.
- `disabled`: boolean. `true` sets `disabled_at = NOW()`, `false` clears it. Disabling also deletes all active refresh tokens for that user (immediate session invalidation).

### `GET /api/admin/invites`

Returns all invites ordered by `created_at DESC`. Each row includes a computed `status` field:
- `"used"` if `used_at` is set
- `"expired"` if `expires_at < NOW()` and not used
- `"pending"` otherwise

## 3. Auth middleware changes

### Login check

In the login endpoint (`POST /api/auth/login`), after password verification, check `disabled_at`. If set, return `403 { error: "Account disabled" }`.

### Token refresh check

In the refresh endpoint, check `disabled_at` on the user. If set, reject and clear cookies.

### `requireAuth` middleware

No change needed — disabled users can't get new tokens, and disabling deletes existing refresh tokens. Access tokens (15m TTL) expire naturally.

## 4. Zealot integration

### Config

Add to web server environment:
- `ZEALOT_ENDPOINT` — e.g. `https://zealot.velinlovewithmar.com`
- `ZEALOT_TOKEN` — API token for authenticated requests
- `ZEALOT_CHANNEL_KEY` — production channel key for download link

### Fetching the install URL

Create `src/zealot.js`:

```js
export async function getInstallUrl()
```

- Calls Zealot's latest-release API (verify exact path against Zealot docs at implementation — likely `GET /api/apps/latest?channel_key={ZEALOT_CHANNEL_KEY}`)
- Auth header: `Authorization: Token {ZEALOT_TOKEN}`
- Extracts the install URL from the response (`install_url` field)
- Caches result in memory for 1 hour (simple timestamp + value cache)
- Returns `null` on any error (network, auth, parse) — caller decides fallback

### Graceful degradation

If `ZEALOT_ENDPOINT` is not configured or API fails, the invite email omits the download link. No error surfaced to admin — invite still sends successfully.

## 5. Invite email enhancement

Current email (plain text, via `sendMail`):

```
{Logo}

Dear Friends,

Your Vitalix invite code is:

    XXXX-XXXX-XXXX

Sign up on the web: {signup_link}

Download the Vitalix app: {zealot_install_url}

Expires in 7 days.
```

- Download line only included if Zealot URL was successfully fetched
- No HTML email — keep plain text consistent with existing password reset emails

## 6. Admin UI

### Route

`GET /admin` — served by `pages.js`, requires `requireAuth` + `requireAdmin`. Renders `admin.ejs`.

### Page layout

Three sections on a single page, styled consistently with the existing dashboard:

**Section 1: Invite user**
- Email input field
- Role dropdown: User (default) / Admin
- "Send Invite" button
- Success/error feedback inline

**Section 2: Invites**
- Table: Email, Role, Invited by, Sent, Expires, Status (pending/used/expired)
- Sorted by creation date, newest first
- Status shown as colored badge (green=pending, gray=used, red=expired)

**Section 3: Users**
- Table: Email, Role, Joined, Status (active/disabled)
- Action column with buttons:
  - Toggle role (user ↔ admin) — confirmation prompt
  - Toggle disable/enable — confirmation prompt
- Admin cannot disable/demote themselves (buttons hidden for own row)
- Sorted by creation date, newest first

### Navigation

- Header nav shows "Admin" link when `user.role === "admin"`
- Link not visible to regular users
- Direct URL access returns 403 for non-admins

### Interactions

Form submissions and action buttons use `fetch()` to hit the API endpoints, then update the page inline (no full reload). Error messages shown as toast/inline alerts matching dashboard style.

## 7. Error handling

| Scenario | Behavior |
|----------|----------|
| Zealot API down | Email sent without download link, no error to admin |
| Re-invite same email | Allowed — creates new invite code, old ones remain valid until expiry |
| Admin disables themselves | API rejects with 400, UI hides button for own row |
| Admin demotes last admin | API rejects with 400 "Cannot remove last admin" |
| Invalid email format | Client-side validation + API 400 |

## 8. Security

- All admin endpoints behind `requireAuth` + `requireAdmin`
- Admin page returns 403 for non-admin users
- Disabling a user immediately invalidates refresh tokens
- CSRF protection via existing cookie-based auth (same-origin fetch)
- No sensitive data in URL params

## 9. Files changed / created

| File | Action |
|------|--------|
| `migrations/XXXXXX_admin_disable.cjs` | New — adds `disabled_at` column |
| `src/zealot.js` | New — Zealot API client with caching |
| `src/routes/admin.js` | Extend — add GET users, PATCH user, GET invites; enhance invite email |
| `src/auth/store.js` | Extend — add `listUsers`, `updateUser`, `listInvites`, `deleteRefreshTokensForUser` |
| `src/auth/middleware.js` | Extend — login/refresh check `disabled_at` |
| `src/routes/pages.js` | Extend — add `GET /admin` route |
| `src/config.js` | Extend — add Zealot env vars |
| `views/admin.ejs` | New — admin panel page |
| `views/dashboard.ejs` | Modify — add admin nav link for admin users |

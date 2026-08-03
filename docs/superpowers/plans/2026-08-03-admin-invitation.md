# Admin Panel & User Invitation System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a web UI to invite users, manage accounts, and include Zealot download links in invite emails.

**Architecture:** Extends the existing Express + EJS + PostgreSQL stack. New migration adds `disabled_at` to users. New `zealot.js` module fetches install URLs. Admin routes (API + page) are protected by `requireAuth` + `requireAdmin`. Single `admin.ejs` view with invite form, invite list, and user management table.

**Tech Stack:** Node.js, Express, EJS, PostgreSQL (via node-pg-migrate), nodemailer, native `fetch` for Zealot API.

## Global Constraints

- All admin endpoints require `requireAuth` + `requireAdmin` middleware
- Follow existing EJS + Express patterns — no frontend framework
- Migration filenames: `{timestamp}_name.cjs` with `exports.up`/`exports.down` using `pgm`
- Store functions use `query()` from `../db.js`
- Email stays plain text via `sendMail(to, subject, body)`
- Branding: Vital Teal `#0FA9A0`, no emoji in system messages

---

### Task 1: Database migration — add `disabled_at` to users

**Files:**
- Create: `web/migrations/1722500000000_user_disabled.cjs`

**Interfaces:**
- Consumes: nothing
- Produces: `users.disabled_at` column (timestamptz, nullable, default NULL)

- [ ] **Step 1: Create the migration file**

```js
// web/migrations/1722500000000_user_disabled.cjs
exports.up = (pgm) => {
  pgm.addColumn("users", {
    disabled_at: { type: "timestamptz" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("users", "disabled_at");
};
```

- [ ] **Step 2: Run migration**

Run: `cd web && npx node-pg-migrate up`
Expected: Migration applies successfully, `users` table now has `disabled_at` column.

- [ ] **Step 3: Verify column exists**

Run: `psql "$DATABASE_URL" -c "\d users"`
Expected: `disabled_at` column appears with type `timestamp with time zone`.

- [ ] **Step 4: Commit**

```bash
git add web/migrations/1722500000000_user_disabled.cjs
git commit -m "feat(db): add disabled_at column to users for soft-delete"
```

---

### Task 2: Store functions — user listing, updating, invite listing

**Files:**
- Modify: `web/src/auth/store.js`

**Interfaces:**
- Consumes: `query()` from `../db.js`, `users` table with `disabled_at` column (Task 1)
- Produces:
  - `listUsers()` → `Promise<Array<{ id, email, role, created_at, disabled_at }>>`
  - `updateUserRole(id, role)` → `Promise<void>`
  - `setUserDisabled(id, disabled)` → `Promise<void>`
  - `listInvites()` → `Promise<Array<{ email, role, created_by, created_by_email, created_at, expires_at, used_at }>>`
  - `countAdmins()` → `Promise<number>`
  - `findUserByEmail` updated to also return `disabled_at`

- [ ] **Step 1: Update `findUserByEmail` to include `disabled_at`**

In `web/src/auth/store.js`, change the SELECT in `findUserByEmail`:

```js
export async function findUserByEmail(email) {
  const { rows } = await query("SELECT id, email, role, password_hash, disabled_at FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}
```

- [ ] **Step 2: Add `listUsers` function**

Append to `web/src/auth/store.js`:

```js
export async function listUsers() {
  const { rows } = await query(
    "SELECT id, email, role, created_at, disabled_at FROM users ORDER BY created_at DESC"
  );
  return rows;
}
```

- [ ] **Step 3: Add `updateUserRole` function**

```js
export async function updateUserRole(id, role) {
  await query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
}
```

- [ ] **Step 4: Add `setUserDisabled` function**

```js
export async function setUserDisabled(id, disabled) {
  if (disabled) {
    await query("UPDATE users SET disabled_at = now() WHERE id = $1", [id]);
  } else {
    await query("UPDATE users SET disabled_at = NULL WHERE id = $1", [id]);
  }
}
```

- [ ] **Step 5: Add `countAdmins` function**

```js
export async function countAdmins() {
  const { rows } = await query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL");
  return rows[0].n;
}
```

- [ ] **Step 6: Add `listInvites` function**

```js
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
```

- [ ] **Step 7: Commit**

```bash
git add web/src/auth/store.js
git commit -m "feat(store): add user listing, update, invite listing functions"
```

---

### Task 3: Auth — block disabled users from login and refresh

**Files:**
- Modify: `web/src/routes/auth.js` (API login + refresh)
- Modify: `web/src/routes/pages.js` (page login)
- Modify: `web/src/auth/store.js` (`rotateRefresh` to check `disabled_at`)

**Interfaces:**
- Consumes: `findUserByEmail` with `disabled_at` (Task 2), `rotateRefresh` existing
- Produces: disabled users receive 403 on login, 401 on refresh

- [ ] **Step 1: Add disabled check to API login**

In `web/src/routes/auth.js`, after the password verify block (line 48-50), add a disabled check before issuing session:

```js
// In authRouter.post("/api/auth/login", ...)
// After: if (!user || !ok) { return res.status(401)... }
// Before: const tokens = await issueSession(...)
if (user.disabled_at) {
  return res.status(403).json({ error: "Account disabled" });
}
```

The full login handler becomes:
```js
authRouter.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const emailStr = typeof email === "string" ? email : null;
  const passwordStr = typeof password === "string" ? password : "";
  const user = emailStr ? await store.findUserByEmail(emailStr) : null;
  const ok = await verify(passwordStr, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  if (user.disabled_at) {
    return res.status(403).json({ error: "Account disabled" });
  }
  const tokens = await issueSession(res, { id: user.id, role: user.role });
  res.json({ ...tokens, user: { id: user.id, email: user.email, role: user.role } });
});
```

- [ ] **Step 2: Add disabled check to page login**

In `web/src/routes/pages.js`, the `POST /login` handler (line 29-36). After password verify, before setting cookies:

```js
pagesRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = email ? await store.findUserByEmail(email) : null;
  const ok = await verify(String(password || ""), user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) return show(res, "login", { error: "Invalid email or password." });
  if (user.disabled_at) return show(res, "login", { error: "Account disabled." });
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});
```

- [ ] **Step 3: Add disabled check to refresh**

In `web/src/auth/store.js`, inside `rotateRefresh`, after fetching the user (the `u` query), add a disabled check:

```js
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
```

- [ ] **Step 4: Verify login flow manually**

Start the dev server. Try logging in as a normal user — should work. If you have DB access, set `disabled_at = now()` on a test user and try logging in — should see "Account disabled" error.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/auth.js web/src/routes/pages.js web/src/auth/store.js
git commit -m "feat(auth): block disabled users from login and token refresh"
```

---

### Task 4: Zealot integration — fetch install URL

**Files:**
- Create: `web/src/zealot.js`
- Modify: `web/src/config.js`

**Interfaces:**
- Consumes: `config.zealotEndpoint`, `config.zealotToken`, `config.zealotChannelKey`
- Produces: `getInstallUrl()` → `Promise<string | null>`

- [ ] **Step 1: Add Zealot config vars**

In `web/src/config.js`, add these three properties to the `config` object (after `smtp`):

```js
  zealotEndpoint: process.env.ZEALOT_ENDPOINT || null,
  zealotToken: process.env.ZEALOT_TOKEN || null,
  zealotChannelKey: process.env.ZEALOT_CHANNEL_KEY || null,
```

- [ ] **Step 2: Create `web/src/zealot.js`**

```js
import { config } from "./config.js";

let cache = { url: null, ts: 0 };
const TTL = 60 * 60 * 1000; // 1 hour

export async function getInstallUrl() {
  if (!config.zealotEndpoint || !config.zealotToken || !config.zealotChannelKey) return null;
  if (cache.url && Date.now() - cache.ts < TTL) return cache.url;

  try {
    const res = await fetch(
      `${config.zealotEndpoint}/api/apps/latest?channel_key=${config.zealotChannelKey}`,
      { headers: { Authorization: `Token ${config.zealotToken}` } }
    );
    if (!res.ok) return cache.url || null;
    const data = await res.json();
    const url = data.install_url || null;
    if (url) cache = { url, ts: Date.now() };
    return url;
  } catch {
    return cache.url || null;
  }
}
```

- [ ] **Step 3: Verify module loads without Zealot configured**

Run: `cd web && node -e "import('./src/zealot.js').then(m => m.getInstallUrl()).then(u => console.log('url:', u))"`
Expected: `url: null` (no crash when env vars absent)

- [ ] **Step 4: Commit**

```bash
git add web/src/config.js web/src/zealot.js
git commit -m "feat: add Zealot API client with cached install URL"
```

---

### Task 5: Enhance invite email with Zealot download link

**Files:**
- Modify: `web/src/routes/admin.js`

**Interfaces:**
- Consumes: `getInstallUrl()` from `../zealot.js` (Task 4), `createInvite` from store, `sendMail`, `config.appBaseUrl`
- Produces: enhanced `POST /api/admin/invites` that includes Zealot URL in email body

- [ ] **Step 1: Import `getInstallUrl` and update the invite endpoint**

Replace the full `web/src/routes/admin.js`:

```js
import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import * as store from "../auth/store.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";
import { getInstallUrl } from "../zealot.js";

export const adminRouter = Router();

adminRouter.post("/api/admin/invites", requireAuth, requireAdmin, async (req, res) => {
  const { email, role } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const raw = await store.createInvite(email, role === "admin" ? "admin" : "user", req.user.id);
  const link = `${config.appBaseUrl}/signup?token=${raw}`;
  const installUrl = await getInstallUrl();
  const downloadLine = installUrl ? `\nDownload the Vitalix app: ${installUrl}\n` : "";
  await sendMail(
    email,
    "You're invited to Vitalix",
    `Dear Friend,\n\nYour Vitalix invite code is:\n\n    ${raw}\n\nSign up on the web: ${link}\n${downloadLine}\nExpires in 7 days.`
  );
  res.status(201).json({ ok: true });
});
```

- [ ] **Step 2: Test invite send (with mailer in log mode)**

Without `SMTP_HOST` set, `sendMail` logs to console. Send a test invite via curl or the admin UI (once built). Check console output includes the download line when `ZEALOT_ENDPOINT` is set, and omits it when not set.

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/admin.js
git commit -m "feat(invite): include Zealot download link in invite email"
```

---

### Task 6: Admin API endpoints — list users, update user, list invites

**Files:**
- Modify: `web/src/routes/admin.js`

**Interfaces:**
- Consumes: `listUsers`, `updateUserRole`, `setUserDisabled`, `countAdmins`, `revokeAllRefresh`, `listInvites` from store (Task 2)
- Produces:
  - `GET /api/admin/users` → JSON array of users
  - `PATCH /api/admin/users/:id` → `{ ok: true }`
  - `GET /api/admin/invites` → JSON array of invites with computed `status`

- [ ] **Step 1: Add GET /api/admin/users**

Append to `web/src/routes/admin.js` (before the closing of the file):

```js
adminRouter.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await store.listUsers();
  res.json(users);
});
```

- [ ] **Step 2: Add PATCH /api/admin/users/:id**

```js
adminRouter.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  const { role, disabled } = req.body || {};

  if (role !== undefined) {
    if (role !== "admin" && role !== "user") return res.status(400).json({ error: "role must be admin or user" });
    if (targetId === req.user.id && role !== "admin") return res.status(400).json({ error: "Cannot demote yourself" });
    if (role === "user") {
      const count = await store.countAdmins();
      const target = (await store.listUsers()).find((u) => u.id === targetId);
      if (target?.role === "admin" && count <= 1) return res.status(400).json({ error: "Cannot remove last admin" });
    }
    await store.updateUserRole(targetId, role);
  }

  if (disabled !== undefined) {
    if (targetId === req.user.id) return res.status(400).json({ error: "Cannot disable yourself" });
    await store.setUserDisabled(targetId, !!disabled);
    if (disabled) await store.revokeAllRefresh(targetId);
  }

  res.json({ ok: true });
});
```

- [ ] **Step 3: Add GET /api/admin/invites**

```js
adminRouter.get("/api/admin/invites", requireAuth, requireAdmin, async (req, res) => {
  const invites = await store.listInvites();
  const now = new Date();
  const result = invites.map((inv) => ({
    ...inv,
    status: inv.used_at ? "used" : new Date(inv.expires_at) < now ? "expired" : "pending",
  }));
  res.json(result);
});
```

- [ ] **Step 4: Test endpoints with curl**

```bash
# Get a valid admin access token first, then:
curl -H "Cookie: access=<token>" http://localhost:3000/api/admin/users
curl -H "Cookie: access=<token>" http://localhost:3000/api/admin/invites
```

Expected: JSON arrays returned.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin.js
git commit -m "feat(admin): add user listing, user update, and invite listing endpoints"
```

---

### Task 7: Admin page route and EJS view

**Files:**
- Modify: `web/src/routes/pages.js`
- Create: `web/views/admin.ejs`
- Modify: `web/views/dashboard.ejs` (add admin nav link)

**Interfaces:**
- Consumes: `listUsers`, `listInvites` from store (Task 2), `requireAuth`, `requireAdmin` from middleware, admin API endpoints (Task 6)
- Produces: `GET /admin` renders `admin.ejs` with user and invite data; dashboard shows "Admin" link for admin users

- [ ] **Step 1: Add admin page route to pages.js**

In `web/src/routes/pages.js`, add this route after the existing dashboard route (before the layout management section):

```js
pagesRouter.get("/admin", requireAuth, requireAdmin, async (req, res) => {
  const [users, invites, user] = await Promise.all([
    store.listUsers(),
    store.listInvites(),
    store.findUserById(req.user.id),
  ]);
  const now = new Date();
  const invitesWithStatus = invites.map((inv) => ({
    ...inv,
    status: inv.used_at ? "used" : new Date(inv.expires_at) < now ? "expired" : "pending",
  }));
  res.render("admin", {
    email: user?.email,
    users,
    invites: invitesWithStatus,
    currentUserId: req.user.id,
  });
});
```

Also add `requireAdmin` to the imports at the top of pages.js. Change:

```js
import { requireAuth } from "../auth/middleware.js";
```

to:

```js
import { requireAuth, requireAdmin } from "../auth/middleware.js";
```

- [ ] **Step 2: Create `web/views/admin.ejs`**

```html
<!doctype html><html><head><title>Vitalix — Admin</title>
<style>
body{font-family:Inter,system-ui,sans-serif;margin:0;padding:20px 24px;color:#0E1B2B;background:#f8fafc}
h1{color:#0FA9A0;margin:0} h2{margin:32px 0 12px;font-size:18px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.topbar .sub{color:#64748b;font-size:14px;margin:4px 0 0}
.topbar nav{display:flex;gap:12px;align-items:center}
.topbar nav a{color:#0FA9A0;text-decoration:none;font-size:14px}
.topbar button{background:#0FA9A0;color:#fff;border:0;padding:8px 16px;border-radius:8px;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
td{padding:8px 12px;border-bottom:1px solid #f1f5f9}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600}
.badge-pending{background:#dcfce7;color:#166534}
.badge-used{background:#f1f5f9;color:#64748b}
.badge-expired{background:#fef2f2;color:#991b1b}
.badge-active{background:#dcfce7;color:#166534}
.badge-disabled{background:#fef2f2;color:#991b1b}
.badge-admin{background:#dbeafe;color:#1e40af}
.badge-user{background:#f1f5f9;color:#64748b}
.invite-form{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:24px}
.invite-form label{font-size:13px;color:#64748b;display:block;margin-bottom:4px}
.invite-form input,.invite-form select{padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}
.invite-form input{width:280px}
.invite-form button{background:#0FA9A0;color:#fff;border:0;padding:9px 16px;border-radius:8px;font-size:14px;cursor:pointer}
.btn-sm{padding:4px 10px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:12px}
.btn-sm:hover{background:#f1f5f9}
.btn-danger{color:#991b1b;border-color:#fecaca}
.btn-danger:hover{background:#fef2f2}
.msg{padding:8px 12px;border-radius:8px;margin-bottom:12px;font-size:14px;display:none}
.msg-ok{background:#dcfce7;color:#166534}
.msg-err{background:#fef2f2;color:#991b1b}
.card{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
</style>
</head><body>

<div class="topbar">
  <div>
    <h1>Vitalix</h1>
    <p class="sub"><%= email || "Admin" %></p>
  </div>
  <nav>
    <a href="/dashboard">Dashboard</a>
    <form method="post" action="/logout"><button type="submit">Log out</button></form>
  </nav>
</div>

<div id="msg" class="msg"></div>

<div class="card">
  <h2 style="margin-top:0">Invite User</h2>
  <form class="invite-form" id="invite-form">
    <div>
      <label for="inv-email">Email</label>
      <input type="email" id="inv-email" name="email" required placeholder="user@example.com">
    </div>
    <div>
      <label for="inv-role">Role</label>
      <select id="inv-role" name="role">
        <option value="user">User</option>
        <option value="admin">Admin</option>
      </select>
    </div>
    <button type="submit">Send Invite</button>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">Invites</h2>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>Email</th><th>Role</th><th>Invited by</th><th>Sent</th><th>Expires</th><th>Status</th></tr></thead>
    <tbody id="invites-body">
    <% invites.forEach(function(inv) { %>
      <tr>
        <td><%= inv.email %></td>
        <td><span class="badge badge-<%= inv.role %>"><%= inv.role %></span></td>
        <td><%= inv.created_by_email || "—" %></td>
        <td><%= new Date(inv.created_at).toLocaleDateString() %></td>
        <td><%= new Date(inv.expires_at).toLocaleDateString() %></td>
        <td><span class="badge badge-<%= inv.status %>"><%= inv.status %></span></td>
      </tr>
    <% }); %>
    </tbody>
  </table>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Users</h2>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>Email</th><th>Role</th><th>Joined</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody id="users-body">
    <% users.forEach(function(u) {
         var isSelf = u.id === currentUserId;
         var isDisabled = !!u.disabled_at;
    %>
      <tr data-id="<%= u.id %>">
        <td><%= u.email %></td>
        <td><span class="badge badge-<%= u.role %>"><%= u.role %></span></td>
        <td><%= new Date(u.created_at).toLocaleDateString() %></td>
        <td><span class="badge badge-<%= isDisabled ? 'disabled' : 'active' %>"><%= isDisabled ? 'disabled' : 'active' %></span></td>
        <td>
          <% if (!isSelf) { %>
            <button class="btn-sm" onclick="toggleRole(<%= u.id %>, '<%= u.role %>')">
              Make <%= u.role === 'admin' ? 'user' : 'admin' %>
            </button>
            <button class="btn-sm btn-danger" onclick="toggleDisable(<%= u.id %>, <%= !isDisabled %>)">
              <%= isDisabled ? 'Enable' : 'Disable' %>
            </button>
          <% } %>
        </td>
      </tr>
    <% }); %>
    </tbody>
  </table>
  </div>
</div>

<script>
function showMsg(text, ok) {
  var el = document.getElementById("msg");
  el.textContent = text;
  el.className = "msg " + (ok ? "msg-ok" : "msg-err");
  el.style.display = "block";
  setTimeout(function() { el.style.display = "none"; }, 4000);
}

document.getElementById("invite-form").addEventListener("submit", async function(e) {
  e.preventDefault();
  var email = document.getElementById("inv-email").value;
  var role = document.getElementById("inv-role").value;
  try {
    var res = await fetch("/api/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, role: role }),
    });
    var data = await res.json();
    if (!res.ok) return showMsg(data.error || "Failed to send invite", false);
    showMsg("Invite sent to " + email, true);
    document.getElementById("inv-email").value = "";
    setTimeout(function() { location.reload(); }, 1500);
  } catch (err) {
    showMsg("Network error", false);
  }
});

async function toggleRole(id, currentRole) {
  var newRole = currentRole === "admin" ? "user" : "admin";
  if (!confirm("Change role to " + newRole + "?")) return;
  try {
    var res = await fetch("/api/admin/users/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    var data = await res.json();
    if (!res.ok) return showMsg(data.error || "Failed to update role", false);
    showMsg("Role updated", true);
    setTimeout(function() { location.reload(); }, 1000);
  } catch (err) {
    showMsg("Network error", false);
  }
}

async function toggleDisable(id, disable) {
  var action = disable ? "disable" : "enable";
  if (!confirm("Are you sure you want to " + action + " this user?")) return;
  try {
    var res = await fetch("/api/admin/users/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: disable }),
    });
    var data = await res.json();
    if (!res.ok) return showMsg(data.error || "Failed to " + action + " user", false);
    showMsg("User " + action + "d", true);
    setTimeout(function() { location.reload(); }, 1000);
  } catch (err) {
    showMsg("Network error", false);
  }
}
</script>
</body></html>
```

- [ ] **Step 3: Add admin nav link to dashboard**

In `web/views/dashboard.ejs`, the topbar section (around line 91-97). Change the topbar to include an admin link and pass `role` from the route. Find:

```html
<div class="topbar">
  <div>
    <h1>Vitalix</h1>
    <p class="sub"><%= email || "Signed in" %></p>
  </div>
  <form method="post" action="/logout"><button type="submit">Log out</button></form>
</div>
```

Replace with:

```html
<div class="topbar">
  <div>
    <h1>Vitalix</h1>
    <p class="sub"><%= email || "Signed in" %></p>
  </div>
  <div style="display:flex;gap:12px;align-items:center">
    <% if (userRole === "admin") { %><a href="/admin" style="color:#0FA9A0;font-size:14px">Admin</a><% } %>
    <form method="post" action="/logout"><button type="submit">Log out</button></form>
  </div>
</div>
```

- [ ] **Step 4: Pass `userRole` to dashboard template**

In `web/src/routes/pages.js`, in the dashboard render call, add `userRole`:

Find where `email: user?.email,` is in the render object and add below it:

```js
userRole: user?.role,
```

Also add it to the error fallback render:

```js
userRole: null,
```

- [ ] **Step 5: Start dev server, navigate to /admin as admin user**

Verify:
- Admin page loads with three sections (invite form, invites table, users table)
- Dashboard shows "Admin" link in topbar for admin users
- Non-admin users redirected/blocked from /admin

- [ ] **Step 6: Test invite form**

Submit an invite via the form. Check console for email log output (if no SMTP configured). Verify the invite appears in the invites table after page reload.

- [ ] **Step 7: Test user management**

Try changing a user's role and disabling/enabling a user. Verify:
- Role change works
- Disable/enable toggles status
- Cannot disable/demote yourself (buttons hidden)
- Error shown when trying to remove last admin

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/pages.js web/views/admin.ejs web/views/dashboard.ejs
git commit -m "feat(admin): add admin panel page with invite, user, and invite management"
```

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { sameOrigin } from "../src/sameOrigin.js";

const APP = "https://vitalix.example";
async function serve(opts) {
  const app = express();
  app.set("trust proxy", true);
  app.use(sameOrigin(opts));
  app.use((req, res) => res.json({ ok: true }));
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() };
}
const call = (base, path, method, headers = {}) => fetch(base + path, { method, headers });

test("unsafe methods: cross-site Origin / Sec-Fetch-Site refused, same origin and header-less pass", async () => {
  const s = await serve({ baseUrl: () => APP });
  try {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await call(s.base, "/dashboard/layout", m, { Origin: "https://evil.example" })).status, 403, m);
    assert.equal((await call(s.base, "/login", "POST", { Origin: "https://vitalix.example:8443" })).status, 403, "port differs");
    assert.equal((await call(s.base, "/login", "POST", { Origin: "http://vitalix.example" })).status, 403, "scheme differs");
    assert.equal((await call(s.base, "/login", "POST", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await call(s.base, "/login", "POST", { Origin: "null" })).status, 403);
    assert.equal((await call(s.base, "/login", "POST", { Origin: APP })).status, 200);
    assert.equal((await call(s.base, "/login", "POST", { Origin: "https://VITALIX.example" })).status, 200, "normalized");
    assert.equal((await call(s.base, "/login", "POST", { "Sec-Fetch-Site": "same-origin" })).status, 200);
    assert.equal((await call(s.base, "/login", "POST")).status, 200, "no headers (curl / old clients)");
  } finally { s.close(); }
});

test("safe methods untouched except the export downloads; OIDC callback GET passes", async () => {
  const s = await serve({ baseUrl: () => APP });
  const evil = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  try {
    assert.equal((await call(s.base, "/auth/oidc/callback", "GET", evil)).status, 200);
    assert.equal((await call(s.base, "/dashboard", "GET", evil)).status, 200);
    assert.equal((await call(s.base, "/account/export.json", "GET", evil)).status, 403);
    assert.equal((await call(s.base, "/account/export-days.csv", "GET", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await call(s.base, "/account/export.json", "GET", { Origin: APP })).status, 200);
  } finally { s.close(); }
});

test("Bearer requests are exempt; webhook and cron routes are unaffected", async () => {
  const s = await serve({ baseUrl: () => APP });
  const evil = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  try {
    assert.equal((await call(s.base, "/api/health", "POST", { ...evil, Authorization: "Bearer abc" })).status, 200);
    assert.equal((await call(s.base, "/account/export.json", "GET", { ...evil, Authorization: "Bearer abc" })).status, 200);
    assert.equal((await call(s.base, "/api/webhooks/zealot?token=x", "POST", evil)).status, 200);
    assert.equal((await call(s.base, "/api/admin/run-digests", "POST", evil)).status, 200);
    assert.equal((await call(s.base, "/api/admin/run-other", "POST", evil)).status, 403, "only the four exact cron paths");
    assert.equal((await call(s.base, "/api/admin/invites", "POST", evil)).status, 403, "other admin routes stay guarded");
  } finally { s.close(); }
});

test("unparseable APP_BASE_URL fails closed when Origin is present", async () => {
  const s = await serve({ baseUrl: () => "not a url" });
  try {
    assert.equal((await call(s.base, "/login", "POST", { Origin: APP })).status, 403);
    assert.equal((await call(s.base, "/login", "POST")).status, 200);
    assert.equal((await call(s.base, "/account/export.json", "GET", { "Sec-Fetch-Site": "same-site" })).status, 403);
  } finally { s.close(); }
});

test("403 body: JSON for /api, plain text otherwise, nothing echoed", async () => {
  const s = await serve({ baseUrl: () => APP });
  try {
    const h = { Origin: "https://evil.example" };
    const api = await call(s.base, "/api/fcm/register", "POST", h);
    assert.match(api.headers.get("content-type"), /json/);
    assert.deepEqual(await api.json(), { error: "Forbidden" });
    const page = await call(s.base, "/account/delete", "POST", h);
    assert.match(page.headers.get("content-type"), /text\/plain/);
    assert.equal(await page.text(), "Forbidden");
  } finally { s.close(); }
});

test("APP_BASE_URL unset: Origin is compared with the request's own host (proxy-aware)", async () => {
  const s = await serve({ baseUrl: () => undefined });
  try {
    const host = new URL(s.base).host;
    assert.equal((await call(s.base, "/login", "POST", { Origin: `http://${host}` })).status, 200);
    assert.equal((await call(s.base, "/login", "POST", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await call(s.base, "/login", "POST", { Origin: `https://${host}` })).status, 403, "scheme mismatch");
    assert.equal((await call(s.base, "/login", "POST", { Origin: `https://${host}`, "X-Forwarded-Proto": "https" })).status, 200);
  } finally { s.close(); }
});

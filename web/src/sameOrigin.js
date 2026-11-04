// CSRF defence for cookie-authenticated web requests (SameSite=Lax alone treats sibling
// subdomains as same-site and lets top-level GETs, e.g. the exports, through). Browsers always send Sec-Fetch-Site / Origin on cross-site
// writes; clients that send neither (curl, old browsers) pass, since they aren't a CSRF vector.
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// No cookies here: Zealot authenticates with a token in the URL, cron with a header secret.
const EXEMPT_PREFIX = "/api/webhooks/";
const CRON = new Set(["/api/admin/run-daily-insights", "/api/admin/run-anomaly-check", "/api/admin/run-digests", "/api/admin/run-sync-check"]);
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

/**
 * baseUrl: APP_BASE_URL (read per request so tests can set it). Unset -> compare Origin with
 * the request's own scheme+host (trust-proxy aware req.protocol).
 * Bearer requests (Android app) skip the check; a browser can't attach that header cross-site.
 * Invariant: requireAuth never falls back to cookies for a request carrying a Bearer header.
 * Export GETs also refuse Sec-Fetch-Site same-site (a sibling subdomain navigating here).
 */
export function sameOrigin({ baseUrl = () => process.env.APP_BASE_URL } = {}) {
  return (req, res, next) => {
    const isExport = req.method === "GET" && req.path.toLowerCase().startsWith("/account/export");
    const guarded = UNSAFE.has(req.method) || isExport;
    if (!guarded || (req.get("authorization") || "").startsWith("Bearer ") || req.path.startsWith(EXEMPT_PREFIX) || CRON.has(req.path)) return next();
    const origin = req.get("origin"), site = req.get("sec-fetch-site");
    const expected = originOf(baseUrl() || `${req.protocol}://${req.get("host")}`);
    if (site === "cross-site" || (isExport && site === "same-site") || (origin && !(expected && originOf(origin) === expected))) {
      return res.status(403).type(req.path.startsWith("/api/") ? "json" : "text").send(req.path.startsWith("/api/") ? '{"error":"Forbidden"}' : "Forbidden");
    }
    next();
  };
}

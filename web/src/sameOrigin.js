// CSRF defence for cookie-authenticated web requests (SameSite=Lax alone leaves GET exports
// and same-site subdomains open). Browsers always send Sec-Fetch-Site / Origin on cross-site
// writes; clients that send neither (curl, old browsers) pass, since they aren't a CSRF vector.
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// No cookies here: Zealot authenticates with a token in the URL, cron with a header secret.
const EXEMPT = ["/api/webhooks/", "/api/admin/run-"];
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

/**
 * baseUrl: APP_BASE_URL (read per request so tests can set it). Unset -> compare Origin with
 * the request's own scheme+host (trust-proxy aware req.protocol).
 * Bearer requests (Android app) skip the check; a browser can't attach that header cross-site.
 */
export function sameOrigin({ baseUrl = () => process.env.APP_BASE_URL } = {}) {
  return (req, res, next) => {
    const guarded = UNSAFE.has(req.method) || (req.method === "GET" && req.path.startsWith("/account/export"));
    if (!guarded || (req.get("authorization") || "").startsWith("Bearer ") || EXEMPT.some((p) => req.path.startsWith(p))) return next();
    const origin = req.get("origin");
    const expected = originOf(baseUrl() || `${req.protocol}://${req.get("host")}`);
    if (req.get("sec-fetch-site") === "cross-site" || (origin && originOf(origin) !== expected)) {
      return res.status(403).type(req.path.startsWith("/api/") ? "json" : "text").send(req.path.startsWith("/api/") ? '{"error":"Forbidden"}' : "Forbidden");
    }
    next();
  };
}

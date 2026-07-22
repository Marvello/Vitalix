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
    // API clients (incl. curl sending Accept: */*) get JSON 401; only browser
    // page routes redirect to the login screen.
    if (!req.path.startsWith("/api/") && req.accepts(["html", "json"]) === "html") return res.redirect("/login");
    return res.status(401).json({ error: "unauthorized" });
  }
  req.user = { id: Number(claims.sub), role: claims.role };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "forbidden" });
  next();
}

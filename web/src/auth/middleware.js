import { verifyAccess, signAccess } from "./tokens.js";
import * as store from "./store.js";
import { setAuthCookies } from "../routes/auth.js";

function extractToken(req) {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  if (req.cookies?.access) return req.cookies.access;
  return null;
}

async function tryRefresh(req, res) {
  const raw = req.cookies?.refresh;
  if (!raw) return null;
  const rotated = await store.rotateRefresh(raw).catch(() => null);
  if (!rotated) return null;
  const access = signAccess(rotated.user);
  setAuthCookies(res, access, rotated.rawToken);
  return verifyAccess(access);
}

export async function requireAuth(req, res, next) {
  const token = extractToken(req);
  let claims = token ? verifyAccess(token) : null;

  if (!claims) {
    claims = await tryRefresh(req, res);
  }

  if (!claims) {
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

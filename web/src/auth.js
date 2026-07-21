import crypto from "node:crypto";
import { config } from "./config.js";

export function bearerAuth(req, res, next) {
  if (!config.authToken) return next(); // open mode (warned at startup)
  const header = req.get("authorization") || "";
  const prefix = "Bearer ";
  const provided = header.startsWith(prefix) ? header.slice(prefix.length) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(config.authToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

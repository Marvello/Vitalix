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

import { Router } from "express";
import { hash, verify, DUMMY_HASH } from "../auth/passwords.js";
import { signAccess } from "../auth/tokens.js";
import * as store from "../auth/store.js";
import { sendMail } from "../auth/mailer.js";
import { config } from "../config.js";

export const authRouter = Router();

export function setAuthCookies(res, access, refresh) {
  const base = { httpOnly: true, sameSite: "lax", secure: config.isProd };
  res.cookie("access", access, { ...base, maxAge: 15 * 60 * 1000 });
  res.cookie("refresh", refresh, { ...base, maxAge: 30 * 24 * 60 * 60 * 1000, path: "/" });
}
export function clearAuthCookies(res) {
  res.clearCookie("access");
  res.clearCookie("refresh");
}

async function issueSession(res, user) {
  const access = signAccess(user);
  const refresh = await store.issueRefresh(user.id);
  setAuthCookies(res, access, refresh);
  return { access, refresh };
}

authRouter.post("/api/auth/signup", async (req, res) => {
  const { token, email, password } = req.body || {};
  if (typeof token !== "string" || typeof email !== "string" || typeof password !== "string" || !token || !email || !password)
    return res.status(400).json({ error: "token, email, password required" });
  const invite = await store.findValidInvite(token);
  if (!invite || invite.email.toLowerCase() !== email.toLowerCase())
    return res.status(400).json({ error: "invite invalid or expired" });
  if (await store.findUserByEmail(email)) return res.status(400).json({ error: "account already exists" });
  const consumed = await store.consumeInvite(token); // single-use guard; null if raced
  if (!consumed) return res.status(400).json({ error: "invite invalid or expired" });
  const user = await store.createUser(email, await hash(password), invite.role);
  const tokens = await issueSession(res, user);
  res.status(201).json({ ...tokens, user: { id: user.id, email: user.email, role: user.role } });
});

authRouter.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const emailStr = typeof email === "string" ? email : null;
  const passwordStr = typeof password === "string" ? password : "";
  const user = emailStr ? await store.findUserByEmail(emailStr) : null;
  const ok = await verify(passwordStr, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const tokens = await issueSession(res, { id: user.id, role: user.role });
  res.json({ ...tokens, user: { id: user.id, email: user.email, role: user.role } });
});

authRouter.post("/api/auth/refresh", async (req, res) => {
  const raw = req.body?.refresh || req.cookies?.refresh;
  const rotated = raw ? await store.rotateRefresh(raw) : null;
  if (!rotated) return res.status(401).json({ error: "invalid refresh token" });
  const access = signAccess(rotated.user);
  setAuthCookies(res, access, rotated.rawToken);
  res.json({ access, refresh: rotated.rawToken });
});

authRouter.post("/api/auth/logout", async (req, res) => {
  const raw = req.body?.refresh || req.cookies?.refresh;
  if (raw) await store.revokeRefresh(raw);
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.post("/api/auth/forgot", async (req, res) => {
  const { email } = req.body || {};
  const user = typeof email === "string" && email ? await store.findUserByEmail(email) : null;
  if (user) {
    const raw = await store.createReset(user.id);
    const link = `${config.appBaseUrl}/reset?token=${raw}`;
    await sendMail(user.email, "Reset your Vitalix password", `Reset your password: ${link}\nThis link expires in 1 hour.`);
  }
  res.json({ ok: true }); // generic — no enumeration
});

authRouter.post("/api/auth/reset", async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== "string" || typeof password !== "string" || !token || !password)
    return res.status(400).json({ error: "token and password required" });
  const userId = await store.consumeReset(token);
  if (!userId) return res.status(400).json({ error: "reset token invalid or expired" });
  await store.updatePassword(userId, await hash(password));
  await store.revokeAllRefresh(userId);
  res.json({ ok: true });
});

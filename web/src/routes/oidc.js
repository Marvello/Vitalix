import { Router } from "express";
import { signAccess } from "../auth/tokens.js";
import * as store from "../auth/store.js";
import { setAuthCookies } from "./auth.js";
import { config } from "../config.js";
import { FLOW_COOKIE, callbackClaims, matchUser, oidcEnabled, readFlow, startUrl } from "../auth/oidc.js";

export const oidcRouter = Router();
const flowCookie = { httpOnly: true, sameSite: "lax", secure: config.isProd, path: "/auth/oidc" };
const fail = (res, error) => res.status(400).render("login", { error });

oidcRouter.get("/auth/oidc/start", async (_req, res) => {
  if (!oidcEnabled) return res.redirect("/login");
  try {
    const { url, cookie } = await startUrl();
    res.cookie(FLOW_COOKIE, cookie, { ...flowCookie, maxAge: 10 * 60 * 1000 });
    res.redirect(url);
  } catch (err) {
    console.error("[oidc] start failed:", err.message);
    fail(res, "Authentik sign-in is unavailable right now.");
  }
});

oidcRouter.get("/auth/oidc/callback", async (req, res) => {
  if (!oidcEnabled) return res.redirect("/login");
  const flow = readFlow(req.cookies?.[FLOW_COOKIE]);
  res.clearCookie(FLOW_COOKIE, flowCookie);
  if (!flow) return fail(res, "Sign-in expired. Try again.");
  let claims;
  try {
    claims = await callbackClaims(req.query, flow);
  } catch (err) {
    console.warn("[oidc] callback rejected:", err.message);
    return fail(res, "Authentik sign-in failed. Try again.");
  }
  const { user, error } = await matchUser(claims, store.findUserByEmail);
  if (error) {
    console.warn(`[oidc] login refused email=${String(claims?.email)}: ${error}`);
    return fail(res, error);
  }
  setAuthCookies(res, signAccess({ id: user.id, role: user.role }), await store.issueRefresh(user.id));
  res.redirect("/dashboard");
});

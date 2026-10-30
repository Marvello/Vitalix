// Authentik (OIDC) sign-in for the web dashboard. Ends in the same access/refresh cookies as the
// password form; SSO never creates accounts (invite-only stays invite-only).
import * as client from "openid-client";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

const { issuer, clientId, clientSecret, redirectUri } = config.oidc;
export const oidcEnabled = Boolean(issuer && clientId && clientSecret && redirectUri);

let discovered;
const oidcConfig = () => (discovered ??= client.discovery(new URL(issuer), clientId, clientSecret)
  .catch((err) => { discovered = undefined; throw err; })); // retry discovery on the next login

// PKCE verifier + state + nonce ride in a short-lived signed cookie between start and callback.
export const FLOW_COOKIE = "oidc_flow";
const FLOW_TTL_S = 600;
export const signFlow = (flow) => jwt.sign(flow, config.jwtSecret, { expiresIn: FLOW_TTL_S, audience: "oidc-flow" });
export function readFlow(raw) {
  try {
    return jwt.verify(String(raw || ""), config.jwtSecret, { audience: "oidc-flow" });
  } catch {
    return null;
  }
}

// Verified email → existing, enabled user. Returns { user } or { error } (message shown on /login).
export async function matchUser(claims, findUserByEmail) {
  if (claims?.email_verified !== true || typeof claims.email !== "string" || !claims.email.trim())
    return { error: "Authentik did not provide a verified email." };
  const user = await findUserByEmail(claims.email.trim().toLowerCase());
  if (!user) return { error: "No Vitalix account for this Authentik user." };
  if (user.disabled_at) return { error: "Account disabled." };
  return { user };
}

export async function startUrl() {
  const verifier = client.randomPKCECodeVerifier();
  const flow = { verifier, state: client.randomState(), nonce: client.randomNonce() };
  const url = client.buildAuthorizationUrl(await oidcConfig(), {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state: flow.state,
    nonce: flow.nonce,
  });
  return { url: url.href, cookie: signFlow(flow) };
}

// Exchanges the code (checks state, nonce, PKCE, id_token signature) and returns the id_token claims.
export async function callbackClaims(query, flow) {
  const current = new URL(redirectUri);
  current.search = new URLSearchParams(query).toString();
  const tokens = await client.authorizationCodeGrant(await oidcConfig(), current, {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
  });
  return tokens.claims();
}

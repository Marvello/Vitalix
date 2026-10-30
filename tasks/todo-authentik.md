# Authentik sign-in for the Vitalix web dashboard (2026-10-30)

Goal: "Sign in with Authentik" on the web `/login` page. Scope is the **web dashboard only** — the Android app keeps
email/password + Bearer JWT (an in-app OIDC flow would need AppAuth/custom tabs; separate project).

Why not NextAuth now: `common-tech/tech-standard/auth-direction.md` — NextAuth comes with the Express→Next.js migration.
Until then OIDC is a small add-on to the existing Express auth that ends in the **same** access/refresh cookies.

## Plan
- [x] Dependency: `openid-client` (certified OIDC RP lib; hand-rolling code flow + PKCE + nonce + JWKS checks is not worth it).
- [x] `web/src/auth/oidc.js`: discovery from `OIDC_ISSUER`, authorization-code + PKCE + state + nonce (stored in a short-lived
      signed httpOnly cookie), callback exchanges the code, requires `email_verified`.
- [x] Routes: `GET /auth/oidc/start`, `GET /auth/oidc/callback` → look up the user by email; unknown or disabled → back to
      `/login` with an error (invite-only stays invite-only). Known → issue the normal access + refresh tokens and set the
      same cookies as `/login` (reuse the existing cookie helper in `routes/auth.js`).
- [x] `views` login page: "Sign in with Authentik" button (only rendered when `OIDC_ISSUER` is set).
- [x] Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` — all optional; feature off without them.
- [x] Tests (`node --test`): callback mapping (unknown → refused, disabled → refused, known → cookies set), state mismatch refused.
- [x] Docs: `docs/architecture.md` Auth section + config table (CLAUDE.md requires it in the same commit).
- [ ] Authentik + homeserver `k8s/vitalix`: provider+app `vitalix`, group, env + secrets, deploy.
- [ ] Verify with a real login (session cookie set, dashboard loads).

## Not doing
- Android app login, invite/signup flow, password reset — unchanged.

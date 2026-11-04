# Vitalix receiver

Self-hosted server that ingests Health Connect data forwarded by the [Vitalix Android app](../README.md) and stores it in your own Postgres, with a private dashboard.

Node/Express + Postgres. See the [root README](../README.md) for the full picture; quickstart below.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/health` | Bearer | Ingest a `{ days: [...] }` payload from the app. |
| `GET`  | `/api/days`   | Bearer/session | Query stored per-day rows. |
| `GET`  | `/healthz`    | — | Liveness (checks the DB). |

Plus the dashboard, auth (login/signup/reset/invite), and admin pages (EJS views).

## Run

```bash
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, APP_BASE_URL
docker compose up             # app + Postgres, migrations run on start
```

Without Docker (needs a running Postgres):

```bash
npm ci
npm run migrate up
npm run create-admin
npm start                     # :3000
npm test
```

The `*.db.test.js` files and the DB sections of a few others run against a real Postgres and are skipped unless `TEST_DATABASE_URL` is set:

```bash
docker run -d --rm -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t -p 55432:5432 postgres:18-alpine
TEST_DATABASE_URL=postgres://t:t@127.0.0.1:55432/t npm test
```

`TEST_DATABASE_URL` is only the admin connection: each DB test file creates its own `vitalix_test_<file>_<pid>` database (`test/helpers/testDb.js`), migrates it and drops it afterwards, so files run in parallel and nothing in the admin database is touched. A hard-killed run can leave a `vitalix_test_*` database behind; `DROP DATABASE <name> WITH (FORCE)` cleans it.

## Environment

See `.env.example`. `JWT_SECRET` must be a long random string. If `SMTP_*` is unset, reset/invite links are printed to the server console instead of emailed.

`TRUST_PROXY` (Express `trust proxy`, default `loopback, linklocal, uniquelocal`) decides which hops' `X-Forwarded-For` is believed when resolving the client IP for rate limits. The default suits a proxy on the private network (cloudflared, Traefik, Docker). Auth and AI-generate endpoints are rate limited in memory, per process.

## Deploy

CI (`.github/workflows/web.yml`) tests every change and publishes a Docker image to `ghcr.io/<owner>/<repo>-web` on pushes to `main` and `v*` tags. Pull that image, supply the env vars, and run it against your Postgres.

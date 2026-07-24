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

## Environment

See `.env.example`. `JWT_SECRET` must be a long random string. If `SMTP_*` is unset, reset/invite links are printed to the server console instead of emailed.

## Deploy

CI (`.github/workflows/web.yml`) tests every change and publishes a Docker image to `ghcr.io/<owner>/<repo>-web` on pushes to `main` and `v*` tags. Pull that image, supply the env vars, and run it against your Postgres.

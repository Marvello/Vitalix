# Vitalix

**Own your health data.** Vitalix reads your [Health Connect](https://health.google/health-connect-android/) records on-device and forwards them as JSON to a server **you** control — no Google Sheets, no CSV, no third-party data path. It ships with a self-hosted receiver that stores the data in your own Postgres and shows it back to you on a private dashboard.

It is a privacy-first re-target of the upstream [`teqxnology/healthexport`](https://github.com/teqxnology/healthexport) app, swapping the Google Sheets / CSV export destination for a generic authenticated HTTP `POST`.

```
┌──────────────┐   reads    ┌───────────────┐   POST /api/health   ┌──────────────────┐
│ Health       │ ─────────► │ Vitalix app   │ ───────────────────► │ Vitalix receiver │
│ Connect      │  on-device │ (Android)     │   Bearer <token>     │ (your server)    │
└──────────────┘            └───────────────┘                      └──────────────────┘
                                                                     Postgres + dashboard
```

## Repository layout

| Path | What it is |
|------|------------|
| `android/` | The **Vitalix** Android app (`com.android.vitalix`). Reads Health Connect, forwards JSON. |
| `web/` | The **Vitalix receiver** — a self-hosted Node/Express + Postgres server that ingests, stores, and charts the data. |
| `android/healthexport/` | Upstream reference clone. Read-only; not shipped. |
| `docs/` | Design spec and branding. |

## The Android app (`android/`)

Reads Health Connect on-device and forwards only the metrics you enable to your server. Highlights:

- Pick exactly which of ~30 metrics to send; choose a date range or backfill history.
- **Auto-sync** in the background via WorkManager, gated so it only turns on once the OS will actually let it run in the background (battery-optimization exemption + OEM allow-list confirmation on aggressive vendors like Samsung).
- Server URL + optional bearer token stored in `EncryptedSharedPreferences`.

Build:

```bash
cd android
./gradlew installDebug        # build + install to a connected device/emulator
./gradlew testDebugUnitTest   # JVM unit tests
```

Requires a device/emulator with Health Connect installed. `minSdk 30`, `compileSdk 36`, Java 11.

## The receiver (`web/`)

A small Express app that authenticates the app, ingests the JSON payload at `POST /api/health`, stores per-day rows in Postgres, and serves a private dashboard.

- Endpoints: `POST /api/health` (ingest, bearer-auth), `GET /api/days` (query), `GET /healthz` (liveness).
- User accounts with invite codes, password reset, and an admin area (EJS views).
- Schema managed by `node-pg-migrate`.

### Run locally

```bash
cd web
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, APP_BASE_URL
docker compose up             # app + Postgres, migrations run on start
```

Or without Docker (needs a running Postgres):

```bash
cd web
npm ci
npm run migrate up
npm run create-admin          # create your first account
npm start                     # listens on :3000
npm test                      # unit tests
```

Point the Android app's server URL at `https://<your-host>/api/health` and paste the token from your account.

### Deploy

Pushes to `main` (and `v*` tags) run the tests and publish a Docker image to GitHub Container Registry via [`.github/workflows/web.yml`](.github/workflows/web.yml):

```
ghcr.io/<owner>/<repo>-web:latest
```

Deploy that image anywhere that runs containers, supplying the same env vars as `.env.example` and a `DATABASE_URL` pointing at your Postgres. To publish, ensure GitHub Actions has package-write permission (Settings → Actions → General → Workflow permissions → *Read and write*).

## Configuration

`web/.env.example` documents every variable. The essentials:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string. |
| `JWT_SECRET` | Long random string — signs session/auth tokens. **Change this.** |
| `APP_BASE_URL` | Public URL of the receiver (used in reset/invite links). |
| `SMTP_*`, `MAIL_FROM` | Optional. If unset, reset/invite links are logged to the server console. |

## License

[AGPL-3.0](LICENSE). Vitalix is a self-hosted, network-facing app — the AGPL's network clause means anyone who runs a **modified** version as a service must publish their source, keeping the whole project open. See [`LICENSE`](LICENSE) for the full text.

The upstream `android/healthexport/` clone is included for reference only and is not covered by this license.

# Postgres 17 → 18 upgrade

The compose files pin `postgres:18-alpine`. **A tag bump alone does not migrate
data** — Postgres 18 changed two things:

1. Default `PGDATA` moved to `/var/lib/postgresql/18/docker` (was `/var/lib/postgresql/data`).
2. The recommended volume mount is now the parent `/var/lib/postgresql` (already
   updated in `web/docker-compose.yml`).

pg18 binaries cannot read a pg17 data directory, and it refuses to boot if it
finds pg17 data at the old path. So an existing database must be dumped from 17
and restored into 18. For Vitalix (a single small DB) `pg_dump | pg_restore` is
the safe, simple path.

## Runbook (run on the prod host, during a short maintenance window)

```bash
cd web   # where docker-compose.yml lives

# 0. Stop the app so nothing writes mid-dump (leave the DB up).
docker compose stop vitalix-app

# 1. Dump the live pg17 database to a file on the host.
docker compose exec -T vitalix-db \
  pg_dump -U "${POSTGRES_USER:-vitalix}" -d "${POSTGRES_DB:-vitalix}" -Fc \
  > vitalix-pg17.dump

# 2. Take the pg17 DB down and MOVE its volume aside (keep it as a rollback).
docker compose down
docker volume rename vitalix_pgdata vitalix_pgdata_pg17   # backup, do not delete yet

# 3. Bring up pg18 — a fresh, empty cluster in the new layout.
docker compose up -d vitalix-db
until docker compose exec -T vitalix-db pg_isready -U "${POSTGRES_USER:-vitalix}"; do sleep 1; done

# 4. Restore the dump into pg18.
docker compose exec -T vitalix-db \
  pg_restore -U "${POSTGRES_USER:-vitalix}" -d "${POSTGRES_DB:-vitalix}" --no-owner \
  < vitalix-pg17.dump

# 5. Start the app. Its startup migrate is idempotent — schema_migrations came
#    across in the dump, so it applies nothing and just serves.
docker compose up -d

# 6. Verify, then reclaim space once confident:
#    docker volume rm vitalix_pgdata_pg17 ; rm vitalix-pg17.dump
```

Rollback (if step 4/5 fails): `docker compose down`, `docker volume rm
vitalix_pgdata`, `docker volume rename vitalix_pgdata_pg17 vitalix_pgdata`,
pin the image back to `postgres:17-alpine`, `docker compose up -d`.

folionix is the same procedure (`docker/docker-compose.yml`, volume `pgdata`,
db service `folionix-db`).

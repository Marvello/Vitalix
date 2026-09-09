# Standardize DB: ISO dates + SQL-runner migrations + auto-migrate

## Decisions (from user)
- Standardize all repos on ISO date strings.
- Auto-migrate on main-process start (in-process, like folionix).
- ONE migration style = `.sql` files + `schema_migrations` + advisory-locked runner.
- Live PROD Vitalix DB exists (uses node-pg-migrate `pgmigrations` ledger) → must adopt, not replay.

## Tasks
- [x] 1. ISO parsers in web/src/db.js (date/timestamp/timestamptz). Safe: toKey() handles both.
- [x] 2. Convert 13 .cjs migrations → web/db/migrations/001..013_*.sql (faithful 1:1).
- [x] 3. New runner web/src/migrate.js (ESM): schema_migrations, advisory lock, run pending NNN,
        runner inserts ledger row per file. `--check` CLI. Auto-adopt legacy pgmigrations ledger
        (order-zip) so prod cutover is automatic and safe.
- [x] 4. Auto-run: index.js awaits runPendingMigrations() before app.listen.
- [x] 5. Dockerfile CMD → just `node src/index.js` (drop node-pg-migrate chain).
- [x] 6. package.json: migrate script → new runner; drop node-pg-migrate dep + its override.
- [x] 7. Delete old web/migrations/*.cjs after conversion.
- [x] 8. Fix common-tech README: document THE single migration style.
- [x] 9. VERIFY with docker postgres:17-alpine:
        (a) fresh DB: runner builds full schema, idempotent re-run no-ops.
        (b) legacy DB: seed pgmigrations+tables, runner adopts ledger without replaying.
        (c) forward: add a 014 test migration, confirm it runs on both.

## Review
(to fill)

## Review (done 2026-09-08)
- ISO parsers added to web/src/db.js; toKey() already tolerant, 78 tests pass.
- 13 .cjs migrations → db/migrations/001..013.sql. pg_dump diff vs node-pg-migrate
  output: APPLICATION SCHEMA BYTE-IDENTICAL (only ledger table differs, as expected).
- New runner src/migrate.js: advisory lock, schema_migrations, per-file txn, --check,
  auto-adopts legacy pgmigrations ledger (order-zip) for safe prod cutover.
- Verified on postgres:17-alpine: (a) fresh build+idempotent, (b) legacy adopt runs 0,
  (c) forward 014 applies on both. Startup smoke: migrates then listens (302).
- index.js auto-runs migrations before listen; Dockerfile CMD = node src/index.js;
  node-pg-migrate removed from deps + lockfile; migration test rewritten (format-agnostic).
- common-tech README: migrations section rewritten to the single SQL-runner style.
- NOT DONE: prod still has the old `pgmigrations` table after cutover — harmless; drop
  it manually once confident. folionix already conforms; left as-is.

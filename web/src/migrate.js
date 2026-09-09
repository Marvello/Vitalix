// Migration runner — the standard style (see common-tech README).
//
// Applies db/migrations/NNN_*.sql whose version is not yet in schema_migrations,
// in numeric order, each in its own transaction, serialized by an advisory lock
// so concurrent boots don't race. The runner owns the ledger row per file.
//
// One-time adoption: this app previously used node-pg-migrate (a `pgmigrations`
// ledger). On the first boot after the switch, an existing database has all the
// tables but no schema_migrations — replaying 001 would fail. So when
// schema_migrations is empty and a populated pgmigrations exists, we backfill
// the ledger from it (record only, never re-run) before running anything new.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const FILE_RE = /^(\d{3})_[A-Za-z0-9_]+\.sql$/;
const LOCK_KEY = 5417320; // arbitrary but stable — serializes concurrent starts

/** Walk up from this file looking for db/migrations (works from src/, /app, repo root). */
export function findMigrationsDir() {
  const override = process.env.MIGRATIONS_DIR;
  if (override) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "db", "migrations");
    try { readdirSync(candidate); return candidate; } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("db/migrations not found — set MIGRATIONS_DIR");
}

function migrationFiles(dir) {
  return readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function appliedVersions(client) {
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => r.version));
}

/** Backfill schema_migrations from a legacy node-pg-migrate ledger, once. */
async function adoptLegacyLedger(client, files) {
  const reg = await client.query("SELECT to_regclass('public.pgmigrations') AS t");
  if (!reg.rows[0].t) return; // no legacy ledger — fresh DB
  const { rows } = await client.query("SELECT name FROM pgmigrations ORDER BY id");
  if (rows.length === 0) return;
  if (rows.length > files.length) {
    throw new Error(
      `pgmigrations has ${rows.length} rows but only ${files.length} .sql migrations exist — refusing to adopt`);
  }
  // Order-zip: the Nth applied node-pg-migrate migration is our Nth .sql file.
  for (let i = 0; i < rows.length; i++) {
    const version = files[i].slice(0, 3);
    await client.query(
      `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING`,
      [version, files[i].replace(/\.sql$/, "")]);
  }
  console.log(`[migrate] adopted ${rows.length} migration(s) from legacy pgmigrations ledger`);
}

/** Apply every pending migration. Returns filenames applied, in order. */
export async function runPendingMigrations() {
  const dir = findMigrationsDir();
  const files = migrationFiles(dir);
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await ensureLedger(client);

    let done = await appliedVersions(client);
    if (done.size === 0) {
      await adoptLegacyLedger(client, files);
      done = await appliedVersions(client);
    }

    for (const file of files) {
      const version = file.slice(0, 3);
      if (done.has(version)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)
           ON CONFLICT (version) DO NOTHING`,
          [version, file.replace(/\.sql$/, "")]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
      console.log(`[migrate] applied ${file}`);
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Read-only: which migration files are not yet in the ledger. */
export async function checkMigrations() {
  const dir = findMigrationsDir();
  const files = migrationFiles(dir);
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, name text, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await pool.query("SELECT version FROM schema_migrations");
  const done = new Set(rows.map((r) => r.version));
  return {
    applied: files.filter((f) => done.has(f.slice(0, 3))),
    pending: files.filter((f) => !done.has(f.slice(0, 3))),
  };
}

// CLI: `node src/migrate.js` applies pending; `--check` reports only.
if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  const checkOnly = process.argv.includes("--check");
  const run = checkOnly
    ? checkMigrations().then((s) => {
        console.log(`[migrate] ${s.applied.length} applied, ${s.pending.length} pending`);
        if (s.pending.length > 0) {
          console.log(s.pending.map((f) => `  pending: ${f}`).join("\n"));
          process.exitCode = 1;
        }
      })
    : runPendingMigrations().then((a) =>
        console.log(a.length === 0 ? "[migrate] up to date" : `[migrate] applied ${a.length}`));
  run.catch((err) => { console.error("[migrate]", err.message); process.exit(1); })
     .finally(() => pool.end());
}

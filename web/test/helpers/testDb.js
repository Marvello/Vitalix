// Per-file throwaway database for DB-backed tests, so test files can run in parallel.
//
// Usage, at the TOP LEVEL of a test file, before anything imports src/db.js
// (db.js and config.js bind DATABASE_URL at import time, so import app modules
// dynamically AFTER this call):
//
//   const testDb = await createTestDb(import.meta.url);   // null if TEST_DATABASE_URL unset
//   describe("...", { skip: !testDb }, () => { ... });
//
// TEST_DATABASE_URL is the admin connection. This creates vitalix_test_<file>_<pid>,
// points DATABASE_URL at it, runs migrations, and registers an `after` hook that
// closes src/db.js's pool and drops the database. Unset => DATABASE_URL gets a
// dummy value (pure-logic imports still work) and null is returned.
import { after } from "node:test";
import { basename } from "node:path";
import pg from "pg";

export async function createTestDb(fileUrl) {
  process.env.JWT_SECRET ??= "test-secret"; // config.js requires it at import
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) {
    process.env.DATABASE_URL = "postgres://x";
    return null;
  }
  const suffix = `_${process.pid}`;
  const slug = basename(new URL(fileUrl).pathname).replace(/\W/g, "_").toLowerCase();
  const name = `vitalix_test_${slug}`.slice(0, 63 - suffix.length) + suffix;
  const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
  let dbModule; // set once migrations have imported src/db.js
  const cleanup = async () => {
    if (dbModule) {
      // Ended clients can still be mid-disconnect when FORCE kills them; db.js would log that as an error.
      dbModule.pool.removeAllListeners("error").on("error", () => {});
      await dbModule.pool.end();
    }
    await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await adminPool.end();
  };
  await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE ${name}`);
  const u = new URL(admin);
  u.pathname = `/${name}`;
  process.env.DATABASE_URL = u.toString();
  try {
    await (await import("../../src/migrate.js")).runPendingMigrations();
    dbModule = await import("../../src/db.js");
  } catch (err) {
    // A rejected top-level await may skip root hooks, so clean up here.
    dbModule = await import("../../src/db.js").catch(() => null);
    await cleanup().catch(() => {});
    throw err;
  }
  after(cleanup);
  return { url: u.toString(), name };
}

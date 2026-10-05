import pg from "pg";
import { config } from "./config.js";

// Return date/timestamp columns as ISO strings (not JS Date), so values can be
// .slice()d, compared, and serialized without timezone surprises. Set once,
// before the first query — pg type parsers are process-global.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1114, (v) => v); // timestamp
pg.types.setTypeParser(1184, (v) => v); // timestamptz

export const pool = new pg.Pool({ connectionString: config.databaseUrl });
// An idle client erroring (Postgres restart, network blip) emits on the pool;
// unhandled, Node exits. The pool drops that client and reconnects on demand.
pool.on("error", (err) => console.error("[db] idle client error:", err.message));

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  let broken;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // A failed ROLLBACK means the connection itself is bad: destroy it rather
    // than hand a half-open transaction to the next caller.
    await client.query("ROLLBACK").catch((e) => { broken = e; });
    throw err;
  } finally {
    client.release(broken);
  }
}

export async function ping() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

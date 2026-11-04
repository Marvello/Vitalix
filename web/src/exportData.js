import { pool, query } from "./db.js";

const PAGE = 5000;
/** A client that stops reading for this long loses its export (response destroyed). */
export const DRAIN_TIMEOUT_MS = 60_000;
/** Whole-export cap, however steadily the client reads: past it the response is destroyed. */
export const EXPORT_DEADLINE_MS = 15 * 60 * 1000;
// Row -> JSON object, minus ownership/internal columns (ids that only matter to the server).
const J = (alias, ...drop) => `to_jsonb(${alias})${drop.map((c) => ` - '${c}'`).join("")} AS j`;

// Fixed small tables, each scoped to the user (directly or through health_days).
const TABLES = [
  ["health_days", `SELECT ${J("t", "user_id", "sync_id")} FROM health_days t WHERE user_id = $1 ORDER BY day`],
  ["day_aggregates", `SELECT ${J("t")} FROM day_aggregates t JOIN health_days h ON h.id = t.day_id WHERE h.user_id = $1 ORDER BY t.id`],
  // records is streamed separately, in the order the brief lists it
  ["exercises", `SELECT ${J("t")} FROM exercises t JOIN health_days h ON h.id = t.day_id WHERE h.user_id = $1 ORDER BY t.id`],
  ["journal", `SELECT ${J("t", "user_id")} FROM journal_entries t WHERE user_id = $1 ORDER BY logged_at, id`],
  ["ai_recommendations", `SELECT ${J("t", "user_id")} FROM ai_recommendations t WHERE user_id = $1 ORDER BY day`],
  ["ai_digests", `SELECT ${J("t", "user_id")} FROM ai_digests t WHERE user_id = $1 ORDER BY period_start, kind`],
  ["anomaly_alerts", `SELECT ${J("t", "user_id")} FROM anomaly_alerts t WHERE user_id = $1 ORDER BY day, rule`],
];
const RECORDS_SQL = `SELECT ${J("t", "user_id")}, t.id AS _id FROM records t WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT ${PAGE}`;
// Order of keys in the output document.
const ORDER = ["health_days", "day_aggregates", "records", "exercises", "journal", "ai_recommendations", "ai_digests", "anomaly_alerts"];

/** res.write that honours backpressure; resolves false once the client is gone or stalls past `timeoutMs`. */
export async function write(res, chunk, timeoutMs = DRAIN_TIMEOUT_MS) {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  const drained = await new Promise((resolve) => {
    const finish = (ok) => { clearTimeout(timer); res.off("drain", onDrain); res.off("close", onClose); resolve(ok); };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
  if (!drained) res.destroy();
  return drained && !res.destroyed;
}

/**
 * Streams the user's full export as one JSON document. Only the user's own
 * rows are read; secrets (password hash, token hashes, fcm tokens) never are.
 * Returns false if the client disconnected, stalled, or the deadline hit before the end;
 * otherwise the result of the final write.
 */
export async function streamExport(res, userId, { exportedAt = new Date(), drainTimeoutMs = DRAIN_TIMEOUT_MS, deadlineMs = EXPORT_DEADLINE_MS } = {}) {
  const deadline = setTimeout(() => res.destroy(), deadlineMs); // write() then returns false and the loops stop
  try {
    return await run(res, userId, exportedAt, drainTimeoutMs);
  } finally { clearTimeout(deadline); }
}

async function run(res, userId, exportedAt, drainTimeoutMs) {
  // No held connection: each statement borrows from the pool and returns it before any
  // write can block on a slow client (no transaction, so no snapshot is needed).
  const send = (chunk) => write(res, chunk, drainTimeoutMs);
  const u = (await query(
    "SELECT email, timezone, profile_height_m, bmi_scale FROM users WHERE id = $1", [userId])).rows[0];
  const user = { email: u.email, timezone: u.timezone, profile: { height_m: u.profile_height_m, bmi_scale: u.bmi_scale } };
  if (!await send(`{"exportedAt":${JSON.stringify(exportedAt.toISOString())},"user":${JSON.stringify(user)}`)) return false;

  for (const key of ORDER) {
    if (!await send(`,${JSON.stringify(key)}:[`)) return false;
    if (key === "records") {
      let after = 0, first = true;
      for (;;) {
        const { rows } = await query(RECORDS_SQL, [userId, after]);
        if (rows.length === 0) break;
        const body = rows.map((r) => JSON.stringify(r.j)).join(",");
        if (!await send((first ? "" : ",") + body)) return false;
        first = false;
        after = rows[rows.length - 1]._id;
        if (rows.length < PAGE) break;
      }
    } else {
      const { rows } = await query(TABLES.find(([k]) => k === key)[1], [userId]);
      if (!await send(rows.map((r) => JSON.stringify(r.j)).join(","))) return false;
    }
    if (!await send("]")) return false;
  }
  return send("}");
}

/** RFC 4180 field; text starting with = + - @ (or tab/CR) is prefixed with ' against formula injection. */
export function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export async function healthDaysCsv(userId) {
  const { rows, fields } = await pool.query("SELECT * FROM health_days WHERE user_id = $1 ORDER BY day", [userId]);
  const cols = fields.map((f) => f.name).filter((c) => c !== "user_id" && c !== "sync_id");
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvField(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

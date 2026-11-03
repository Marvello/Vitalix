import { pool } from "./db.js";

const PAGE = 5000;
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

/** res.write that honours backpressure; resolves false once the client is gone. */
async function write(res, chunk) {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  await new Promise((resolve) => {
    const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
    res.once("drain", done);
    res.once("close", done);
  });
  return !res.destroyed;
}

/**
 * Streams the user's full export as one JSON document. Only the user's own
 * rows are read; secrets (password hash, token hashes, fcm tokens) never are.
 * Returns false if the client disconnected before the end.
 */
export async function streamExport(res, userId, { exportedAt = new Date() } = {}) {
  const client = await pool.connect();
  try {
    const u = (await client.query(
      "SELECT email, timezone, profile_height_m, bmi_scale FROM users WHERE id = $1", [userId])).rows[0];
    const user = { email: u.email, timezone: u.timezone, profile: { height_m: u.profile_height_m, bmi_scale: u.bmi_scale } };
    if (!await write(res, `{"exportedAt":${JSON.stringify(exportedAt.toISOString())},"user":${JSON.stringify(user)}`)) return false;

    for (const key of ORDER) {
      if (!await write(res, `,${JSON.stringify(key)}:[`)) return false;
      if (key === "records") {
        let after = 0, first = true;
        for (;;) {
          const { rows } = await client.query(RECORDS_SQL, [userId, after]);
          if (rows.length === 0) break;
          const body = rows.map((r) => JSON.stringify(r.j)).join(",");
          if (!await write(res, (first ? "" : ",") + body)) return false;
          first = false;
          after = rows[rows.length - 1]._id;
          if (rows.length < PAGE) break;
        }
      } else {
        const { rows } = await client.query(TABLES.find(([k]) => k === key)[1], [userId]);
        if (!await write(res, rows.map((r) => JSON.stringify(r.j)).join(","))) return false;
      }
      if (!await write(res, "]")) return false;
    }
    await write(res, "}");
    return true;
  } finally {
    client.release();
  }
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

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { mapPayload, PAYLOAD_SCHEMA_VERSION, MAX_DELETED_HC_IDS } from "../mapPayload.js";
import { persist } from "../persist.js";
import { query, ping } from "../db.js";
import { userTimeZone } from "../ai/recommendations.js";
import { dayReadings } from "../stats.js";
import { buildRecordsQuery, shapeBucketRow, BUCKETS, RAW_LIMIT } from "../records.js";

export const router = Router();

function isTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.get("/healthz", async (_req, res) => {
  const ok = await ping();
  res.status(ok ? 200 : 503).json({ ok });
});

router.post("/api/health", requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.days)) {
    return res.status(400).json({ error: "body must include a days array" });
  }
  // Absent (or null) means a pre-versioning build: version 1.
  const sv = body.schemaVersion;
  if (sv != null && !(Number.isInteger(sv) && sv > 0)) {
    return res.status(400).json({ error: "invalid schemaVersion" });
  }
  if (sv > PAYLOAD_SCHEMA_VERSION) {
    return res.status(400).json({ error: "unsupported schemaVersion" });
  }
  if (Array.isArray(body.deletedHcIds) && body.deletedHcIds.length > MAX_DELETED_HC_IDS) {
    return res.status(400).json({ error: `deletedHcIds holds more than ${MAX_DELETED_HC_IDS} ids` });
  }
  try {
    const mapped = mapPayload(body);
    const { deleted, ...inserted } = await persist(req.user.id, mapped);
    const profileHeightM = typeof body.profileHeightM === "number" ? body.profileHeightM : null;
    const bmiScale = body.bmiScale === "asian" ? "asian" : "standard";
    if (typeof body.timeZone === "string" && isTimeZone(body.timeZone)) {
      await query("UPDATE users SET timezone = $2 WHERE id = $1 AND timezone IS DISTINCT FROM $2", [req.user.id, body.timeZone]);
    }
    if (profileHeightM !== null || body.bmiScale) {
      const sets = [];
      const vals = [req.user.id];
      let i = 2;
      if (profileHeightM !== null) { sets.push(`profile_height_m = $${i++}`); vals.push(profileHeightM); }
      sets.push(`bmi_scale = $${i++}`); vals.push(bmiScale);
      await query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, vals);
    }
    res.status(200).json({ inserted, skipped: mapped.skipped, deleted });
  } catch (err) {
    console.error("ingest failed", err);
    res.status(500).json({ error: "ingest failed" });
  }
});

router.get("/api/days", requireAuth, async (req, res) => {
  try {
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const { rows } = await query(
      "SELECT * FROM health_days WHERE user_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day DESC",
      [req.user.id, from, to]
    );
    res.json(rows);
  } catch (err) {
    console.error("query failed", err);
    res.status(500).json({ error: "query failed" });
  }
});

router.get("/api/days/:date", requireAuth, async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM health_days WHERE user_id = $1 AND day = $2", [req.user.id, req.params.date]);
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    const day = rows[0];
    const [aggregates, samples, exercises] = await Promise.all([
      query("SELECT metric, min, max, avg FROM day_aggregates WHERE day_id = $1", [day.id]),
      dayReadings(req.user.id, req.params.date, await userTimeZone(req.user.id)),
      query("SELECT name, start_at, duration_minutes FROM exercises WHERE day_id = $1", [day.id]),
    ]);
    res.json({ ...day, aggregates: aggregates.rows, samples: samples.map(({ source, meta, ...r }) => r), exercises: exercises.rows });
  } catch (err) {
    console.error("query failed", err);
    res.status(500).json({ error: "query failed" });
  }
});

router.get("/api/records", requireAuth, async (req, res) => {
  const bucket = req.query.bucket || "day";
  if (!BUCKETS.has(bucket)) return res.status(400).json({ error: `bucket must be one of ${[...BUCKETS].join(", ")}` });
  const to = req.query.to || new Date().toISOString();
  const from = req.query.from || new Date(Date.now() - 6 * 864e5).toISOString();
  const types = typeof req.query.types === "string" && req.query.types.length
    ? req.query.types.split(",") : null;
  try {
    const tz = await userTimeZone(req.user.id);
    const q = buildRecordsQuery({ userId: req.user.id, from, to, types, bucket, tz });
    const { rows } = await query(q.text, q.values);
    res.json(bucket === "raw" ? { bucket, rows, truncated: rows.length === RAW_LIMIT }
                              : { bucket, rows: rows.map(shapeBucketRow) });
  } catch (err) {
    console.error("records query failed", err);
    res.status(500).json({ error: "records query failed" });
  }
});

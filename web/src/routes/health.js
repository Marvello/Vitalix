import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { mapPayload } from "../mapPayload.js";
import { persist } from "../persist.js";
import { query, ping } from "../db.js";
import { buildRecordsQuery, shapeBucketRow, BUCKETS } from "../records.js";

export const router = Router();

router.get("/healthz", async (_req, res) => {
  const ok = await ping();
  res.status(ok ? 200 : 503).json({ ok });
});

router.post("/api/health", requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.days)) {
    return res.status(400).json({ error: "body must include a days array" });
  }
  try {
    const mapped = mapPayload(body);
    const inserted = await persist(req.user.id, mapped);
    res.status(200).json({ inserted, skipped: mapped.skipped });
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
      query("SELECT metric, start_at, end_at, value_num, value_secondary, value_text FROM samples WHERE day_id = $1 ORDER BY start_at", [day.id]),
      query("SELECT name, start_at, duration_minutes FROM exercises WHERE day_id = $1", [day.id]),
    ]);
    res.json({ ...day, aggregates: aggregates.rows, samples: samples.rows, exercises: exercises.rows });
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
    const q = buildRecordsQuery({ userId: req.user.id, from, to, types, bucket });
    const { rows } = await query(q.text, q.values);
    res.json(bucket === "raw" ? { bucket, rows, truncated: rows.length === 5000 }
                              : { bucket, rows: rows.map(shapeBucketRow) });
  } catch (err) {
    console.error("records query failed", err);
    res.status(500).json({ error: "records query failed" });
  }
});

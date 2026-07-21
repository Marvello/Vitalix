import { Router } from "express";
import { bearerAuth } from "../auth.js";
import { mapPayload } from "../mapPayload.js";
import { persist } from "../persist.js";
import { query, ping } from "../db.js";

export const router = Router();

router.get("/healthz", async (_req, res) => {
  res.status((await ping()) ? 200 : 503).json({ ok: await ping() });
});

router.post("/api/health", bearerAuth, async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.days)) {
    return res.status(400).json({ error: "body must include a days array" });
  }
  try {
    const mapped = mapPayload(body);
    const inserted = await persist(mapped);
    res.status(200).json({ inserted, skipped: mapped.skipped });
  } catch (err) {
    console.error("ingest failed", err);
    res.status(500).json({ error: "ingest failed" });
  }
});

router.get("/api/days", bearerAuth, async (req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const { rows } = await query(
    "SELECT * FROM health_days WHERE day BETWEEN $1 AND $2 ORDER BY day DESC",
    [from, to]
  );
  res.json(rows);
});

router.get("/api/days/:date", bearerAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM health_days WHERE day = $1", [req.params.date]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  const day = rows[0];
  const [aggregates, samples, exercises] = await Promise.all([
    query("SELECT metric, min, max, avg FROM day_aggregates WHERE day_id = $1", [day.id]),
    query("SELECT metric, start_at, end_at, value_num, value_secondary, value_text FROM samples WHERE day_id = $1 ORDER BY start_at", [day.id]),
    query("SELECT name, start_at, duration_minutes FROM exercises WHERE day_id = $1", [day.id]),
  ]);
  res.json({ ...day, aggregates: aggregates.rows, samples: samples.rows, exercises: exercises.rows });
});

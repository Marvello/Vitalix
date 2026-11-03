import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db.js";
import { rateLimit } from "../rateLimit.js";
import { todayIn, userTimeZone } from "../ai/recommendations.js";
import { validateEntry } from "../journal.js";

export const journalRouter = Router();

const postLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, key: (req) => req.user.id });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COLS = "id, day::text AS day, kind, value_num, value_text, logged_at";

// Entries for [from, to] (YYYY-MM-DD, inclusive); both default to the user's today.
journalRouter.get("/api/journal", requireAuth, async (req, res) => {
  const today = todayIn(await userTimeZone(req.user.id));
  const { from = today, to = from } = req.query;
  if (!DAY.test(from) || !DAY.test(to)) return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
  const { rows } = await query(
    `SELECT ${COLS} FROM journal_entries WHERE user_id = $1 AND day BETWEEN $2 AND $3 ORDER BY logged_at, id`,
    [req.user.id, from, to],
  );
  res.json({ entries: rows });
});

journalRouter.post("/api/journal", requireAuth, postLimit, async (req, res) => {
  const v = validateEntry(req.body, await userTimeZone(req.user.id));
  if (!v.ok) return res.status(400).json({ error: v.error });
  const e = v.entry;
  const { rows } = await query(
    `INSERT INTO journal_entries (user_id, day, kind, value_num, value_text, logged_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [req.user.id, e.day, e.kind, e.value_num, e.value_text, e.logged_at],
  );
  res.status(201).json(rows[0]);
});

journalRouter.delete("/api/journal/:id", requireAuth, async (req, res) => {
  if (!/^\d{1,15}$/.test(req.params.id)) return res.status(404).json({ error: "not found" });
  const { rowCount } = await query("DELETE FROM journal_entries WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (rowCount === 0) return res.status(404).json({ error: "not found" });
  res.sendStatus(204);
});

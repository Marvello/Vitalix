import { query as dbQuery } from "./db.js";
import { messaging as defaultMessaging } from "./firebase.js";
import { generateRecommendation as defaultGenerate, yesterdayKey } from "./ai/recommendations.js";
import { deadTokens } from "./syncCheck.js";

// Users who have a health_days row for `day` but no ai_recommendation yet — the
// set the worker should generate for (skip ones already done, don't re-spend).
export const PENDING_USERS_SQL = `
  SELECT DISTINCT h.user_id AS id
  FROM health_days h
  WHERE h.day = $1
    AND NOT EXISTS (
      SELECT 1 FROM ai_recommendations r
      WHERE r.user_id = h.user_id AND r.day = $1
    )`;

const TOKENS_SQL = "SELECT array_agg(token) AS tokens FROM fcm_tokens WHERE user_id = $1";

// Generates yesterday's insight for each pending user, then pushes an
// "insight_ready" nudge to their devices. Deps injected for testing.
// ponytail: sequential per-user — fine for a daily batch; parallelize if the
// user base ever makes the LLM round-trips too slow.
export async function runDailyInsights({
  query = dbQuery,
  messaging = defaultMessaging,
  generate = defaultGenerate,
  day = yesterdayKey(),
} = {}) {
  const { rows } = await query(PENDING_USERS_SQL, [day]);
  let generated = 0;
  let pushed = 0;
  let failed = 0;

  for (const { id } of rows) {
    try {
      await generate(id, day);
      generated++;
    } catch (e) {
      failed++;
      if (e.code === "AI_UNCONFIGURED") break; // nothing will succeed — stop early
      console.error(`insight gen failed user=${id}`, e.message);
      continue; // don't push when we have no fresh insight
    }

    if (!messaging) continue;
    const { rows: tok } = await query(TOKENS_SQL, [id]);
    const tokens = tok[0]?.tokens;
    if (!tokens?.length) continue;

    const resp = await messaging.sendEachForMulticast({ tokens, data: { type: "insight_ready", day } });
    const dead = deadTokens(tokens, resp);
    if (dead.length) await query("DELETE FROM fcm_tokens WHERE token = ANY($1)", [dead]);
    if (resp.successCount > 0) pushed++;
  }

  return { day, candidates: rows.length, generated, pushed, failed };
}

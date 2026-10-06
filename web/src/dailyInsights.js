import { query as dbQuery } from "./db.js";
import { messaging as defaultMessaging } from "./firebase.js";
import { generateRecommendation as defaultGenerate } from "./ai/recommendations.js";
import { deadTokens } from "./syncCheck.js";

// The worker runs hourly; each user is picked once it is past GENERATE_HOUR in
// their own zone (UTC when unknown), for their yesterday, if they have data for
// it and no recommendation yet (don't re-spend tokens). Waiting until morning
// gives the phone's 4-hourly auto-sync time to send the end of the night.
export const GENERATE_HOUR = 8;
export const PENDING_USERS_SQL = `
  SELECT u.id, y.day::text AS day
  FROM users u
  CROSS JOIN LATERAL (
    SELECT (now() AT TIME ZONE COALESCE(u.timezone, 'UTC')) AS local_now
  ) n
  CROSS JOIN LATERAL (SELECT n.local_now::date - 1 AS day) y
  WHERE u.disabled_at IS NULL
    AND EXTRACT(HOUR FROM n.local_now) >= ${GENERATE_HOUR}
    AND EXISTS (SELECT 1 FROM health_days h WHERE h.user_id = u.id AND h.day = y.day)
    AND NOT EXISTS (SELECT 1 FROM ai_recommendations r WHERE r.user_id = u.id AND r.day = y.day)`;

const TOKENS_SQL = "SELECT array_agg(token) AS tokens FROM fcm_tokens WHERE user_id = $1";

// Generates yesterday's insight for each pending user, then pushes an
// "insight_ready" nudge to their devices. Deps injected for testing.
// ponytail: sequential per-user — fine for a daily batch; parallelize if the
// user base ever makes the LLM round-trips too slow.
export async function runDailyInsights({
  query = dbQuery,
  messaging = defaultMessaging,
  generate = defaultGenerate,
} = {}) {
  const { rows } = await query(PENDING_USERS_SQL);
  let generated = 0;
  let pushed = 0;
  let failed = 0;
  let skipped = 0;

  for (const { id, day } of rows) {
    try {
      await generate(id, day);
      generated++;
    } catch (e) {
      if (e.code === "NO_DATA" || e.code === "DAY_INCOMPLETE") { skipped++; continue; }
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

  return { candidates: rows.length, generated, pushed, failed, skipped };
}

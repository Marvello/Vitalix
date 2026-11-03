import { query as dbQuery } from "./db.js";
import { messaging as defaultMessaging } from "./firebase.js";
import { pushToUser } from "./push.js";
import { GENERATE_HOUR } from "./dailyInsights.js";
import { DIGEST_KINDS, generateDigest as defaultGenerate, isDue, periodFor } from "./ai/digest.js";

// The user's local date once they are past GENERATE_HOUR (UTC when no timezone).
export const PENDING_DIGEST_USERS_SQL = `
  SELECT u.id, n.local_now::date::text AS today
  FROM users u
  CROSS JOIN LATERAL (
    SELECT (now() AT TIME ZONE COALESCE(u.timezone, 'UTC')) AS local_now
  ) n
  WHERE u.disabled_at IS NULL
    AND EXTRACT(HOUR FROM n.local_now) >= ${GENERATE_HOUR}`;

const EXISTS_SQL = "SELECT 1 FROM ai_digests WHERE user_id = $1 AND kind = $2 AND period_start = $3";

// Hourly: for each user whose local date makes a digest due (Monday / the 1st) and
// who has none for that period yet, generate it and push `digest_ready` once.
// The ai_digests unique key means a re-run never spends tokens or pushes twice.
export async function runDigests({
  query = dbQuery,
  messaging = defaultMessaging,
  generate = defaultGenerate,
} = {}) {
  const { rows } = await query(PENDING_DIGEST_USERS_SQL);
  let candidates = 0;
  let generated = 0;
  let pushed = 0;
  let failed = 0;

  users: for (const { id, today } of rows) {
    for (const kind of DIGEST_KINDS) {
      if (!isDue(kind, today)) continue;
      const { start, end } = periodFor(kind, today);
      if ((await query(EXISTS_SQL, [id, kind, start])).rows.length) continue;
      candidates++;

      try {
        await generate(id, kind, start, end);
        generated++;
      } catch (e) {
        if (e.code === "NO_DATA") continue;
        failed++;
        if (e.code === "AI_UNCONFIGURED") break users; // nothing will succeed — stop early
        console.error(`digest gen failed user=${id} kind=${kind}`, e.message);
        continue; // no fresh digest, no push
      }

      if ((await pushToUser({ query, messaging }, id, { type: "digest_ready", kind, start })).sent) pushed++;
    }
  }
  return { candidates, generated, pushed, failed };
}

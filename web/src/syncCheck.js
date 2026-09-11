import { query as dbQuery } from "./db.js";
import { messaging as defaultMessaging } from "./firebase.js";

export const STALE_HOURS = 36;   // no sync for this long => stale
export const RENOTIFY_HOURS = 24; // re-nudge at most once per this window

// Users who: have a device token, have synced at least once before (we alert on
// *stopped* syncing, not *never started*), are now stale, and weren't nudged
// within the re-notify window. $1 = stale hours, $2 = renotify hours.
export const STALE_USERS_SQL = `
  SELECT u.id, array_agg(DISTINCT f.token) AS tokens
  FROM users u
  JOIN fcm_tokens f ON f.user_id = u.id
  LEFT JOIN syncs s ON s.user_id = u.id
  GROUP BY u.id, u.no_sync_notified_at
  HAVING MAX(s.received_at) IS NOT NULL
     AND MAX(s.received_at) < now() - ($1 || ' hours')::interval
     AND (u.no_sync_notified_at IS NULL
          OR u.no_sync_notified_at < now() - ($2 || ' hours')::interval)`;

// Token is permanently dead (uninstall / expired) — prune it.
const DEAD_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

export function deadTokens(tokens, multicastResponse) {
  const dead = [];
  multicastResponse.responses.forEach((r, i) => {
    if (!r.success && DEAD_CODES.has(r.error?.code)) dead.push(tokens[i]);
  });
  return dead;
}

// Finds stale users and pushes a data-only `type: "no_sync"` message; the app
// renders the local notification (same shape as the app_update push). Prunes
// dead tokens and stamps no_sync_notified_at so we don't nag. Deps are injected
// for testing. ponytail: sequential per-user loop — fine at this scale, batch
// if the stale set ever gets large.
export async function runSyncCheck({ query = dbQuery, messaging = defaultMessaging } = {}) {
  if (!messaging) return { checked: 0, notified: 0, pruned: 0, skipped: "firebase disabled" };

  const { rows } = await query(STALE_USERS_SQL, [String(STALE_HOURS), String(RENOTIFY_HOURS)]);
  let notified = 0;
  let pruned = 0;

  for (const { id, tokens } of rows) {
    const resp = await messaging.sendEachForMulticast({ tokens, data: { type: "no_sync" } });

    const dead = deadTokens(tokens, resp);
    if (dead.length) {
      await query("DELETE FROM fcm_tokens WHERE token = ANY($1)", [dead]);
      pruned += dead.length;
    }
    if (resp.successCount > 0) {
      await query("UPDATE users SET no_sync_notified_at = now() WHERE id = $1", [id]);
      notified++;
    }
  }

  return { checked: rows.length, notified, pruned };
}

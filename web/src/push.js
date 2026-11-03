import { deadTokens } from "./syncCheck.js";

const TOKENS_SQL = "SELECT array_agg(token) AS tokens FROM fcm_tokens WHERE user_id = $1";

// Sends a data-only push to every device of a user and prunes dead tokens.
// Never throws: one FCM/DB failure is logged and reported as sent:false so a
// batch run keeps going. sent = at least one device accepted the message.
export async function pushToUser({ query, messaging }, userId, data) {
  try {
    if (!messaging) return { sent: false, pruned: 0 };
    const tokens = (await query(TOKENS_SQL, [userId])).rows[0]?.tokens;
    if (!tokens?.length) return { sent: false, pruned: 0 };
    const resp = await messaging.sendEachForMulticast({ tokens, data });
    const dead = deadTokens(tokens, resp);
    if (dead.length) await query("DELETE FROM fcm_tokens WHERE token = ANY($1)", [dead]);
    return { sent: resp.successCount > 0, pruned: dead.length };
  } catch (e) {
    console.error(`push failed user=${userId} type=${data?.type}`, e.message);
    return { sent: false, pruned: 0 };
  }
}

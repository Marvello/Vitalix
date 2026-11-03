import { todayIn } from "./ai/recommendations.js";

const NUM_RANGE = { mood: [1, 5, true], caffeine: [0, 20, false], alcohol: [0, 30, false] };
const TEXT_KINDS = ["symptom", "medication", "note"];

/**
 * Pure: request body + the user's zone → { ok, entry } | { ok, error }.
 * `day` is always derived from logged_at in `tz`; a client-sent `day` is ignored.
 */
export function validateEntry(body, tz = "UTC", now = new Date()) {
  const { kind, logged_at: loggedAt } = body ?? {};
  const t = typeof loggedAt === "string" ? Date.parse(loggedAt) : NaN;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(loggedAt ?? "") || Number.isNaN(t)) return { ok: false, error: "logged_at must be an ISO timestamp" };
  if (t > now.getTime() + 864e5) return { ok: false, error: "logged_at is in the future" };
  const entry = { kind, value_num: null, value_text: null, logged_at: new Date(t).toISOString(), day: todayIn(tz, new Date(t)) };

  if (kind in NUM_RANGE) {
    const [min, max, int] = NUM_RANGE[kind];
    const v = body.value_num;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
      return { ok: false, error: `${kind} value_num must be ${int ? "an integer" : "a number"} ${min}-${max}` };
    }
    entry.value_num = v;
  } else if (TEXT_KINDS.includes(kind)) {
    const v = typeof body.value_text === "string" ? body.value_text.trim() : "";
    if (v.length < 1 || v.length > 200) return { ok: false, error: `${kind} value_text must be 1-200 characters` };
    entry.value_text = v;
  } else {
    return { ok: false, error: "unknown kind" };
  }
  return { ok: true, entry };
}

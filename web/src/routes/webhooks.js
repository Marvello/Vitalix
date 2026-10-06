import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { messaging } from "../firebase.js";

export const webhookRouter = Router();

function secretMatches(given) {
  const want = config.zealotWebhookSecret;
  if (!want || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Zealot's upload webhook body → the FCM message the app expects, or null when
 * there's nothing to announce. Zealot posts a flat JSON object (its default body
 * template); `release_type` picks the topic the app subscribed to.
 */
export function zealotUpdatePush(body) {
  if (body?.event !== "upload_events" || !body.install_url) return null;
  const changelog = Array.isArray(body.changelog)
    ? body.changelog.map((c) => `- ${c.message ?? c}`).join("\n")
    : String(body.changelog ?? "");
  return {
    topic: body.release_type === "beta" ? "app-updates-beta" : "app-updates",
    data: {
      type: "app_update",
      version: String(body.release_version ?? ""),
      // The app ignores a push whose version_code isn't newer than its own.
      version_code: String(body.build_version ?? ""),
      download_url: String(body.install_url),
      changelog: changelog.slice(0, 2000), // FCM data payloads cap at 4 KB
    },
  };
}

// Zealot webhooks can't set headers, so the secret rides in the URL:
// https://<host>/api/webhooks/zealot?token=<ZEALOT_WEBHOOK_SECRET>
webhookRouter.post("/api/webhooks/zealot", async (req, res) => {
  if (!secretMatches(req.query.token ?? req.headers["x-zealot-token"])) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const push = zealotUpdatePush(req.body);
  if (push && messaging) {
    try {
      await messaging.send(push);
      console.log(`FCM sent to topic=${push.topic} version=${push.data.version} (${push.data.version_code})`);
    } catch (e) {
      console.error("FCM send failed:", e.message);
      return res.status(502).json({ error: "push failed" });
    }
  }
  res.status(200).json({ ok: true, pushed: !!(push && messaging) });
});

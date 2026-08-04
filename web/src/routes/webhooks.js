import { Router } from "express";
import { config } from "../config.js";
import { admin } from "../firebase.js";

export const webhookRouter = Router();

webhookRouter.post("/api/webhooks/zealot", async (req, res) => {
  const token = req.headers["x-zealot-token"];
  if (!config.zealotWebhookSecret || token !== config.zealotWebhookSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { event, data } = req.body || {};
  if (event === "upload_events" && data) {
    const { bundle_id, release_version, install_url } = data;
    if (config.firebaseEnabled && install_url) {
      const topic = bundle_id?.includes(".beta") ? "app-updates-beta" : "app-updates";
      try {
        await admin.messaging().send({
          topic,
          data: {
            type: "app_update",
            version: release_version || "",
            download_url: install_url,
          },
        });
        console.log(`FCM sent to topic=${topic} version=${release_version}`);
      } catch (e) {
        console.error("FCM send failed:", e.message);
      }
    }
  }

  res.status(200).json({ ok: true });
});

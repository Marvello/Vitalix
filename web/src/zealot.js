import { config } from "./config.js";

let cache = { url: null, ts: 0 };
const TTL = 60 * 60 * 1000; // 1 hour

export async function getInstallUrl() {
  if (!config.zealotEndpoint || !config.zealotToken || !config.zealotChannelKey) return null;
  if (cache.url && Date.now() - cache.ts < TTL) return cache.url;

  try {
    const res = await fetch(
      `${config.zealotEndpoint}/api/apps/latest?channel_key=${config.zealotChannelKey}`,
      { headers: { Authorization: `Token ${config.zealotToken}` } }
    );
    if (!res.ok) return cache.url || null;
    const data = await res.json();
    const url = data.install_url || null;
    if (url) cache = { url, ts: Date.now() };
    return url;
  } catch {
    return cache.url || null;
  }
}

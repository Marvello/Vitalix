import { config } from "./config.js";

let cache = { url: null, ts: 0 };
const TTL = 60 * 60 * 1000; // 1 hour

export async function getInstallUrl() {
  if (!config.zealotEndpoint || !config.zealotToken || !config.zealotChannelKey) return null;
  if (cache.url && Date.now() - cache.ts < TTL) return cache.url;

  try {
    const apiUrl = `${config.zealotEndpoint}/api/apps/latest?channel_key=${config.zealotChannelKey}`;
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Token ${config.zealotToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[zealot:error] ${res.status} ${res.statusText} ${body}`);
      return cache.url || null;
    }
    const data = await res.json();
    const url = data.install_url || null;
    if (url) {
      cache = { url, ts: Date.now() };
      console.log(`[zealot:ok] install_url=${url}`);
    } else {
      console.warn("[zealot:warn] response ok but no install_url", JSON.stringify(data).slice(0, 200));
    }
    return url;
  } catch (err) {
    console.error("[zealot:error]", err.message);
    return cache.url || null;
  }
}

// Fixed-window request limiter keyed per client (IP by default).
// ponytail: in-memory, per process — fine for the single-replica deploy; move the
// counters to Postgres/Redis if the receiver ever runs more than one replica.
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, h] of hits) if (now >= h.reset) hits.delete(k);
    }
    const k = key(req);
    let h = hits.get(k);
    if (!h || now >= h.reset) {
      h = { count: 0, reset: now + windowMs };
      hits.set(k, h);
    }
    if (++h.count <= max) return next();
    res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
    if (req.accepts(["html", "json"]) === "html" && !req.path.startsWith("/api/")) {
      return res.status(429).send("Too many attempts. Try again later.");
    }
    return res.status(429).json({ error: "too many requests" });
  };
}

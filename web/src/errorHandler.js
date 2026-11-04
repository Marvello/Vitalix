/** App-level error handler: logs server-side, never sends the message or stack to the client (any NODE_ENV). */
export function errorHandler(err, req, res, next) {
  console.error(`${req.method} ${req.path} failed`, err);
  if (res.headersSent) return next(err); // let Express close the connection
  // Client errors from middleware (e.g. malformed JSON body) keep their 4xx status.
  const status = err?.status >= 400 && err.status < 500 ? err.status : 500;
  const msg = status === 500 ? "Internal error" : status === 413 ? "Payload too large" : "Bad request";
  if (req.path.startsWith("/api/") || req.accepts(["html", "json"]) === "json") return res.status(status).json({ error: msg });
  res.status(status).render("error");
}

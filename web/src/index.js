import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { router as healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { pagesRouter } from "./routes/pages.js";
import { webhookRouter } from "./routes/webhooks.js";
import { aiRouter } from "./routes/ai.js";
import { fcmRouter } from "./routes/fcm.js";
import { runPendingMigrations } from "./migrate.js";
import { rateLimit } from "./rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Deployed behind a proxy on the private network (cloudflared on k3s). Trusting
// only private/loopback hops makes req.ip the real client without letting an
// internet client spoof it through X-Forwarded-For.
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal");
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../views"));
app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const MIN = 60 * 1000;
const email = (req) => (typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "");
// Per IP, plus per target account for login so a botnet can't spread guesses.
app.post(["/api/auth/login", "/login"], rateLimit({ windowMs: 15 * MIN, max: 20 }));
app.post(["/api/auth/login", "/login"], rateLimit({ windowMs: 15 * MIN, max: 10, key: (req) => email(req) }));
app.post(["/api/auth/forgot", "/forgot"], rateLimit({ windowMs: 60 * MIN, max: 5 }));
app.post(["/api/auth/reset", "/reset"], rateLimit({ windowMs: 60 * MIN, max: 10 }));
app.post(["/api/auth/signup", "/signup"], rateLimit({ windowMs: 60 * MIN, max: 10 }));
app.use(healthRouter);
app.use(authRouter);
app.use(adminRouter);
app.use(pagesRouter);
app.use(webhookRouter);
app.use(aiRouter);
app.use(fcmRouter);

// Apply pending migrations before serving — the DB must match the code that
// starts. A migration failure aborts startup rather than serving a bad schema.
async function start() {
  await runPendingMigrations();
  app.listen(config.port, () => console.log(`vitalix receiver listening on :${config.port}`));
}
start().catch((err) => {
  console.error("[startup] migration failed:", err.message);
  process.exit(1);
});

export { app };

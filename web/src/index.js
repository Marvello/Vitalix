import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { router as healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { pagesRouter } from "./routes/pages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../views"));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(healthRouter);
app.use(authRouter);
app.use(adminRouter);
app.use(pagesRouter);

app.listen(config.port, () => console.log(`vitalix receiver listening on :${config.port}`));

export { app };

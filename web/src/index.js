import express from "express";
import { config } from "./config.js";
import { router } from "./routes/health.js";

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(router);

if (!config.authToken) {
  console.warn("AUTH_TOKEN not set — receiver is open to unauthenticated requests");
}

app.listen(config.port, () => {
  console.log(`vitalix receiver listening on :${config.port}`);
});

export { app };

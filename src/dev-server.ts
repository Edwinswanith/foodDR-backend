/**
 * LOCAL DEV ENTRYPOINT — NOT the real server.ts. Boots plain Express with
 * only the nutrition routes mounted, skipping every real-platform subsystem
 * (AWS Secrets Manager, Firebase, Redis queues, cron jobs, SSO, the
 * crash-proof session store, socket.io, swagger) that this partial-export
 * checkout doesn't actually contain. Use this to exercise the ported
 * generatePersonalizedNutritionPlan / getWeightHistory /
 * getNutritionTimeLineByDate endpoints locally; use the real server.ts (and
 * the real wms codebase's full config/jobs/queues modules) for anything else.
 */
import express from "express";
import dotenv from "dotenv";
dotenv.config();

import apiRoutes from "./api/routes/index";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/v1", apiRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", entrypoint: "dev-server.ts (nutrition routes only)" });
});

const port = process.env.PORT_NO || 3000;
app.listen(port, () => {
  console.log(`[dev-server] listening on :${port} — nutrition routes only, no AWS/Firebase/queues/cron/SSO`);
});

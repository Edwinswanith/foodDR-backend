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
import { mountMediaRoutes } from "./api/routes/mediaRoutes";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Same fix already applied to deploy-server.ts and vercelApp.ts — without
// this, scanMeal/addMeal's image_url/thumbnail_url links (which point at
// /media/:filename) 404 even though the image was genuinely uploaded and
// stored; this entrypoint just never had the route to serve it back.
mountMediaRoutes(app);

app.use("/api/v1", apiRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", entrypoint: "dev-server.ts (nutrition routes only)" });
});

const port = process.env.PORT_NO || 3000;
app.listen(port, () => {
  console.log(`[dev-server] listening on :${port} — nutrition routes only, no AWS/Firebase/queues/cron/SSO`);
});

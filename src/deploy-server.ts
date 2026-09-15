/**
 * Container entrypoint for deploying ONLY the nutrition-client routes from
 * this partial checkout — no AWS Secrets Manager, Firebase, Redis queues,
 * cron jobs, SSO, session store, or the rest of the wider wms platform (see
 * dev-server.ts, which this is a production-shaped sibling of: same router,
 * same "nutrition routes only" scope, but reading Cloud Run's real `PORT`
 * env var instead of defaulting to a fixed local port).
 *
 * Mounts the exact same `apiRoutes` router as dev-server.ts — every route
 * registered in src/api/routes/index.ts, nothing more, nothing less.
 */
import express from "express";
import dotenv from "dotenv";
dotenv.config();

import apiRoutes from "./api/routes/index";
import { mountMediaRoutes } from "./api/routes/mediaRoutes";

const app = express();
// Cloud Run terminates TLS at its load balancer and forwards to the
// container over plain HTTP with X-Forwarded-Proto set — without this,
// req.protocol always reads "http", so every image_url/meal_image_url/
// thumbnail_url this entrypoint builds comes back http:// even when the
// client reached the service over https:// (mixed-content risk). server.ts
// already had this; this entrypoint (Dockerfile-node's actual CMD) never did.
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Real bug fix: this entrypoint (Dockerfile-node's actual CMD, dist/deploy-server.js)
// never had these — scanMeal/addMeal's image_url/thumbnail_url links 404'd on the
// real Cloud Run deployment even though they work locally via server.ts.
mountMediaRoutes(app);

app.use("/api/v1", apiRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", entrypoint: "deploy-server.ts (nutrition routes only)" });
});

// Cloud Run injects PORT (typically 8080) and requires the container to
// listen on it — PORT_NO (used by dev-server.ts / the wider wms platform's
// server.ts) is kept only as a fallback for local parity.
const port = process.env.PORT || process.env.PORT_NO || 3000;
app.listen(port, () => {
  console.log(`[deploy-server] listening on :${port} — nutrition routes only, no AWS/Firebase/queues/cron/SSO`);
});

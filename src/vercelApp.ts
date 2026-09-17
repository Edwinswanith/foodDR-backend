/**
 * Vercel serverless entrypoint — same scope as deploy-server.ts (nutrition
 * routes only, no AWS Secrets Manager/Firebase/Redis queues/cron
 * jobs/SSO/session store/socket.io — none of those are compatible with a
 * stateless serverless function anyway), built as an importable Express
 * `app` instead of a `.listen()`-ing process: Vercel's Node.js runtime
 * invokes the exported handler directly per-request instead of running a
 * long-lived server.
 *
 * Real limitation, not silently glossed over: every invocation is a fresh
 * (possibly cold-started) function instance, so Prisma's connection pool is
 * NOT shared across requests the way it is on Cloud Run's long-lived
 * container. Under real concurrent traffic this can exhaust SQL Server's
 * connection limit — either front the DB with a pooler (e.g. PgBouncer-style
 * proxy for SQL Server, or Azure SQL's built-in pooling) or keep this
 * checkout's real deployment on Cloud Run (see deploy.bat/Dockerfile-node)
 * and treat this Vercel config as a preview/secondary target.
 */
import express from "express";
import dotenv from "dotenv";
dotenv.config();

import apiRoutes from "./api/routes/index";
import { mountMediaRoutes } from "./api/routes/mediaRoutes";

const app = express();
// Vercel terminates TLS in front of the function and forwards the request
// with X-Forwarded-Proto set — without this, req.protocol always reads
// "http", so every image_url/meal_image_url/thumbnail_url this app builds
// comes back http:// even though the client reached it over https:// (real
// bug, caught while manually testing the deployed URL: addMeal's response
// had "image_url": "http://nutrition-backend-delta.vercel.app/media/...").
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mountMediaRoutes(app);

// The /api/v1 prefix only exists because local/Cloud Run's entrypoints use
// it (see deploy-server.ts) — nothing about this deployment actually needs
// it. Mounted at "/" only, e.g.
// https://nutrition-backend-delta.vercel.app/api/v2/....
app.use(apiRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", entrypoint: "vercelApp.ts (nutrition routes only)" });
});

export default app;

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mountMediaRoutes(app);

app.use("/api/v1", apiRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", entrypoint: "vercelApp.ts (nutrition routes only)" });
});

export default app;

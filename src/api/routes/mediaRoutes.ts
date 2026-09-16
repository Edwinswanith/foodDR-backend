/**
 * Root-level (no /api/v1 prefix) image-serving routes, shared by every
 * Express entrypoint that needs scanMeal/addMeal's image_url/thumbnail_url
 * links to actually resolve: the demo placeholder and real uploaded meal
 * photos (stored in the `media_files` table — no disk/object storage in
 * this checkout, so this works the same in a serverless environment with
 * an ephemeral filesystem).
 *
 * Extracted out of server.ts (which has its own inline copy, left as-is)
 * so deploy-server.ts and the Vercel entrypoint don't each hand-roll and
 * risk drifting from it — deploy-server.ts was actually missing both
 * routes entirely before this (a real, pre-existing bug: the Cloud Run
 * deployment's own image_url/thumbnail_url links 404'd, since
 * dist/deploy-server.js — not server.js — is Dockerfile-node's real CMD).
 */
import express from "express";
import path from "path";
import fs from "fs";
import commonService from "../services/commonService";

export function mountMediaRoutes(app: express.Express): void {
  const demoMealImagePath = path.resolve(__dirname, "..", "..", "..", "assets", "default-demo-meal.png");
  app.get(
    ["/i/default-demo-meal.jpg", "/i/default-demo-meal", "/i/demo-food-photo.jpg"],
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!fs.existsSync(demoMealImagePath)) return next();
      res.type("png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.sendFile(demoMealImagePath);
    },
  );

  app.get("/media/:filename", async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const filename = req.params.filename;
    if (!/^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/.test(filename)) return next();
    try {
      const file = await commonService.findOneInTable('media_files', { filename });
      if (!file) return next();
      res.setHeader("Content-Type", file.mime);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(Buffer.from(file.content));
    } catch (err) {
      return next(err);
    }
  });
}

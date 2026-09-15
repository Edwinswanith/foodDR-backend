/**
 * Vercel serverless function entrypoint (Vercel's convention: any file under
 * a top-level /api directory becomes a function). All routes are rewritten
 * here by vercel.json, so this single function serves the whole app — the
 * Express app itself still does its own internal routing (/api/v1/...,
 * /media/..., /i/...) exactly like every other entrypoint in this checkout.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import app from "../src/vercelApp";

export default function handler(req: VercelRequest, res: VercelResponse) {
  return app(req as never, res as never);
}

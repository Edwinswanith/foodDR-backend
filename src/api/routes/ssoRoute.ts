/**
 * LOCAL DEV STUB. The real ssoRoute.ts (Microsoft SSO login flow, per
 * middleware/custom-auth.ts's @microsoft/microsoft-graph-client /
 * @azure/identity imports elsewhere) isn't present in this checkout — this
 * is an empty router so server.ts's `app.use("/auth", ..., ssoRoutes)` has
 * something valid to mount. Every /auth/* request will just 404 rather than
 * authenticate anyone.
 */
import { Router } from "express";

const router = Router();

export default router;

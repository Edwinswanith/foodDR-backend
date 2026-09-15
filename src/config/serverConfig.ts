/** LOCAL DEV STUB — used only to extend server.ts's CORS origin allowlist. */
export const SERVER_CONFIG = {
  BACKEND_SERVER_URL: process.env.BACKEND_SERVER_URL || "http://localhost:3001",
  FRONTEND_SERVER_URL: process.env.FRONTEND_SERVER_URL || "http://localhost:3000",
};

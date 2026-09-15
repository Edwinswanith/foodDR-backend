/**
 * LOCAL DEV STUB — not a reconstruction of the real config/config.ts (which
 * loads secrets from AWS Secrets Manager in the actual wms platform). This
 * reads plain environment variables instead, so the app can boot locally
 * without AWS access. Only the fields actually referenced by the files kept
 * in this checkout (middleware/auth.ts, custom-auth.ts, authSessionService.ts,
 * dev-server.ts) are populated — everything else server.ts references
 * (SERVER_CONFIG, firebase, redis, etc.) stays genuinely missing, since this
 * stub does not attempt to run the full server.ts.
 */

let secretsLoaded = false;

export async function loadSecrets(): Promise<void> {
  // No AWS Secrets Manager here — just mark ready so callers that gate on
  // areSecretsLoaded() proceed. Real secrets come from process.env directly.
  secretsLoaded = true;
}

export function areSecretsLoaded(): boolean {
  return secretsLoaded;
}

export async function connectDB(): Promise<void> {
  // The real config connects to MongoDB here for some subsystem not present
  // in this checkout. No-op stub.
}

const config = {
  jwtSecretKey: process.env.JWT_SECRET_KEY || "dev-local-jwt-secret-change-me",
  cryptoPayloadSecretKey: process.env.CRYPTO_PAYLOAD_SECRET_KEY || "dev-local-payload-secret-change-me",
  otpExpireHours: process.env.OTP_EXPIRE_HOURS || "72",
  redisUrl: process.env.REDIS_URL || "",
  frontendServerUrl: process.env.FRONTEND_SERVER_URL || "http://localhost:3000",
  backendServerUrl: process.env.BACKEND_SERVER_URL || "http://localhost:3001",
  enableWellnessCron: process.env.ENABLE_WELLNESS_CRON || "false",
  ssoConfig: {
    expressSecret: process.env.SSO_EXPRESS_SECRET || "dev-local-sso-secret-change-me",
  },
  AWS_S3: {
    s3Region: process.env.AWS_S3_REGION || "",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    bucketName: process.env.AWS_S3_BUCKET || "",
  },
};

export default config;

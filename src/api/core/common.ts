/**
 * LOCAL DEV STUB, but isValidJSON itself is a genuine, unambiguous utility
 * (not a guess) — it's the only export server.ts actually needs from the
 * real core/common.ts, which also held encryptPassword/S3-presign/etc.
 * helpers used only by the now-removed authController.ts.
 */
export function isValidJSON(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

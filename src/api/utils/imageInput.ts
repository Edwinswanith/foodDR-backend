/**
 * Shared uploaded-image resolution — accepts a raw multipart/form-data
 * upload (multer), a base64 data URL, or bare base64 with no `data:` prefix
 * (e.g. a raw base64 string pasted into a form-data text field, as Postman
 * does when you type/paste base64 directly rather than using its own
 * data-URL format), so callers never need to hand-roll any of the three.
 * Originally lived only inside scanMealService.ts; extracted so addMeal's
 * type 2 (image upload) path accepts the same input shapes instead of
 * requiring a multer file only.
 *
 * The returned `mimetype` is always sniffed from the decoded bytes'
 * magic-number header when recognizable (JPEG/PNG/WEBP), not just trusted
 * from what the client claims — a declared Content-Type/data-URL subtype
 * can be wrong or absent (bare base64 carries no type info at all), and a
 * wrong mimetype reaching Gemini's `inline_data.mime_type` silently breaks
 * recognition (bytes decoded as the wrong format) without ever surfacing as
 * an error.
 */
import type { Request } from "express";

export interface UploadedImage {
  buffer: Buffer;
  mimetype?: string;
}

const BASE64_CHARSET_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Magic-number sniffing for the 3 formats this app actually accepts (see ALLOWED_IMAGE_MIME in scanMealService.ts). */
export function sniffMimeFromBytes(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** multipart upload (multer) takes priority; a base64 data URL in body.image is next; bare base64 (no data: prefix) is the final fallback. */
export function resolveUploadedImage(req: Request, bodyField: string = "image"): UploadedImage | null {
  const multerFile = (req as Request & { file?: Express.Multer.File }).file;
  if (multerFile?.buffer) {
    return { buffer: multerFile.buffer, mimetype: sniffMimeFromBytes(multerFile.buffer) ?? multerFile.mimetype };
  }

  const raw = (req.body as Record<string, unknown> | undefined)?.[bodyField];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();

  const dataUrlMatch = trimmed.match(/^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    const buffer = Buffer.from(dataUrlMatch[2]!, "base64");
    return { buffer, mimetype: sniffMimeFromBytes(buffer) ?? `image/${dataUrlMatch[1]}` };
  }

  // Bare base64, no data: URL wrapper — sniff the real format from the
  // decoded bytes since there's no declared mime type to fall back on.
  if (trimmed.length > 100 && BASE64_CHARSET_RE.test(trimmed)) {
    const buffer = Buffer.from(trimmed, "base64");
    const mime = sniffMimeFromBytes(buffer);
    if (mime) return { buffer, mimetype: mime };
  }

  return null;
}

/** The base64 payload form Gemini's inline_data expects — reused wherever an image buffer needs to become base64 for the AI call. */
export function toBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

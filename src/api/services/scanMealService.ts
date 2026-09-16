/**
 * POST /api/scanMeal — ported 1:1 in contract from FoodDr/backend-node's
 * nutritionClientV1ScanService.ts + nutritionClientV1SharedService.ts.
 *
 * Real behavior confirmed by reading that source, not assumed from the
 * route name: this endpoint is a BARCODE scanner (detect a barcode in the
 * uploaded photo, look the product up on Open Food Facts), not an AI
 * photo-of-a-plate classifier — that's a different real feature
 * (nutrition-client V2's image addMeal, which calls a Gemini vision
 * adapter this checkout has no equivalent wiring for and correctly leaves
 * as an honest 501 stub in addMeal type 2).
 *
 * Also ported deliberately: scan results are RESPONSE-ONLY. The real
 * service's own comment says so explicitly — "even when isMealEligible is
 * true, nothing is ever written to mealsRepo" — and logs a
 * `scan_meal_sql_save_skipped` event for it. This is not a placeholder or
 * a missing feature; it is the real, intentional behavior. Do not persist
 * a meal row here to satisfy a "must write to the DB" expectation — that
 * would be a deviation from the real contract, not a fix.
 */
import type { Request } from "express";
import AppError from "../core/error-handler";
import { ERROR_MESSAGE } from "../constants";
import { detectBarcodeFromImage } from "./barcode/barcodeImageService";
import { lookupBarcode, type BarcodeProduct } from "./barcode/barcodeService";
import { resolveUploadedImage, sniffMimeFromBytes, type UploadedImage } from "../utils/imageInput";

const SCAN_MEAL_TYPE = "snack";
const SCAN_MEAL_TIMEOUT_MS = 4_000;
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_DEMO_IMAGE_PATH = "/i/default-demo-meal.jpg";

function validateImage(file: UploadedImage | null): asserts file is UploadedImage {
  if (!file) throw new AppError(ERROR_MESSAGE.SCAN_IMAGE_REQUIRED, [], 400);
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new AppError(ERROR_MESSAGE.SCAN_IMAGE_EMPTY, [], 400);
  }
  if (file.buffer.length > MAX_IMAGE_BYTES) {
    throw new AppError(ERROR_MESSAGE.FILE_TOO_LARGE, [], 413);
  }
  const mime = sniffMimeFromBytes(file.buffer);
  if (!mime || !ALLOWED_IMAGE_MIME.has(mime)) {
    throw new AppError(ERROR_MESSAGE.SCAN_IMAGE_FORMAT_INVALID, [], 400);
  }
}

/** `true`/`false` string handling — form-data always sends booleans as strings. */
function parseMealEligibility(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || String(raw).trim() === "") return false;
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new AppError(ERROR_MESSAGE.IS_MEAL_ELIGIBLE_INVALID, [], 400);
}

async function withScanTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(Object.assign(new Error(`Scan meal exceeded ${SCAN_MEAL_TIMEOUT_MS}ms`), { code: "SCAN_MEAL_TIMEOUT" })),
      SCAN_MEAL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function publicImageUrl(imageRef: string | null | undefined, req: Request): string {
  const origin = `${req.protocol}://${req.get("host")}`;
  const raw = typeof imageRef === "string" ? imageRef.trim() : "";
  if (!raw) return `${origin}${DEFAULT_DEMO_IMAGE_PATH}`;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `${origin}${DEFAULT_DEMO_IMAGE_PATH}`;
}

function buildScanResponse(opts: {
  productId: string | number | null;
  product: BarcodeProduct;
  req: Request;
  isMealEligible: boolean;
}): Record<string, unknown> {
  const { productId, product, req, isMealEligible } = opts;
  const imageUrl = publicImageUrl(product.image_url, req);
  const base = {
    product_id: productId,
    product_name: product.name,
    meal_name: product.name,
    meal_type: SCAN_MEAL_TYPE,
    image_url: imageUrl,
    meal_image_url: imageUrl,
    thumbnail_url: imageUrl,
    serving_size: 1,
    serving_unit: product.serving_size ?? "serving",
    nutrition: {
      calories: Math.round(product.calories ?? 0),
      protein: product.protein_g ?? 0,
      carbs: product.carbs_g ?? 0,
      fat: product.fat_g ?? 0,
      fibre: product.fibre_g ?? 0,
    },
    ingredients: product.ingredients ?? [],
  };
  // Same shape distinction as the real service: only the analyze-only (preview)
  // response carries these two flags — the "eligible" transient-meal response
  // does not (see toScanProductResponse / previewMealResult vs clientMealResult).
  if (!isMealEligible) {
    return { ...base, is_meal_eligible: false, is_saved: false };
  }
  return base;
}

export async function scanMeal(req: Request): Promise<Record<string, unknown>> {
  const isMealEligible = parseMealEligibility(req.body?.isMealEligible);
  const file = resolveUploadedImage(req);
  validateImage(file);

  let barcodeResult: { barcode: string; format: string };
  try {
    barcodeResult = await withScanTimeout(detectBarcodeFromImage(file.buffer));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "SCAN_MEAL_TIMEOUT") {
      throw new AppError(ERROR_MESSAGE.SCAN_SERVICE_BUSY, [], 503);
    }
    if (err instanceof AppError) {
      throw new AppError(ERROR_MESSAGE.SCAN_BARCODE_INVALID, [], 400);
    }
    throw err;
  }

  const product = await lookupBarcode(barcodeResult.barcode);
  if (!product) {
    throw new AppError(ERROR_MESSAGE.SCAN_BARCODE_PRODUCT_NOT_FOUND, [], 404);
  }

  // Scan results are response-only in both this checkout and the real system —
  // see this file's header comment. No meal row is created either way; the
  // "eligible" product_id is just the barcode itself (there is no meal row to
  // hash an id from), matching the real service's `product.barcode ?? barcodeResult.barcode`.
  const productId = isMealEligible ? product.barcode ?? barcodeResult.barcode : null;
  return buildScanResponse({ productId, product, req, isMealEligible });
}

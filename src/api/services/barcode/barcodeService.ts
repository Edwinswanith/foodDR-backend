/**
 * Barcode nutrition lookup — ported from FoodDr/backend-node's
 * barcodeService.ts (Open Food Facts, free/no API key). This checkout omits
 * two pieces the real service has, both cleanly separable and not silently
 * approximated:
 *  - the Edamam fallback source (requires EDAMAM_APP_ID/APP_KEY, unset here)
 *  - self-hosting the product image via a media-storage service (this
 *    checkout has none wired for arbitrary uploads); the Open Food Facts
 *    image URL is returned to the client as-is instead of being mirrored.
 */
import AppError from "../../core/error-handler";
import { ERROR_MESSAGE } from "../../constants";

const OPEN_FOOD_FACTS_BASE = "https://world.openfoodfacts.org/api/v2/product";
const TIMEOUT_MS = 5000;
const BARCODE_PATTERN = /^[A-Z0-9.\- $/+%]{3,48}$/;
const NUMERIC_BARCODE_LENGTHS = new Set([6, 7, 8, 12, 13, 14]);

function toNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function roundNutritionValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function kcalFromNutriments(nutriments: Record<string, unknown> | undefined, basis: string): number | undefined {
  const kcalKey = basis === "serving" ? "energy-kcal_serving" : "energy-kcal_100g";
  const kjKey = basis === "serving" ? "energy-kj_serving" : "energy-kj_100g";
  const kcal = toNumber(nutriments?.[kcalKey]);
  if (kcal !== undefined) return kcal;
  const kj = toNumber(nutriments?.[kjKey]);
  return kj === undefined ? undefined : kj / 4.184;
}

function pickNutriment(nutriments: Record<string, unknown> | undefined, field: string, basis: string): number | undefined {
  const basisKey = basis === "serving" ? `${field}_serving` : `${field}_100g`;
  const fallbackKey = basis === "serving" ? `${field}_100g` : `${field}_serving`;
  return toNumber(nutriments?.[basisKey]) ?? toNumber(nutriments?.[fallbackKey]);
}

function compactString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length ? text : undefined;
}

function pickProductName(product: Record<string, unknown>): string {
  return (
    compactString(product.product_name_en) ??
    compactString(product.product_name) ??
    compactString(product.generic_name_en) ??
    compactString(product.generic_name) ??
    "Packaged food item"
  );
}

function pickBrand(product: Record<string, unknown>): string | undefined {
  const brands = compactString(product.brands);
  if (!brands) return undefined;
  return brands.split(",").map((brand) => brand.trim()).filter(Boolean)[0];
}

function pickImage(product: Record<string, unknown>): string | undefined {
  return (
    compactString(product.image_front_url) ??
    compactString(product.image_url) ??
    compactString(product.image_front_small_url) ??
    compactString(product.image_small_url)
  );
}

function cleanIngredient(value: unknown): string | undefined {
  const text = compactString(value);
  if (!text) return undefined;
  const cleaned = text
    .replace(/<[^>]*>/g, " ")
    .replace(/_/g, " ")
    .replace(/^\w{2}:/, "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function uniqueIngredients(values: unknown[]): string[] {
  const seen = new Set<string>();
  const ingredients: string[] = [];
  for (const value of values) {
    const ingredient = cleanIngredient(value);
    if (!ingredient) continue;
    const key = ingredient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ingredients.push(ingredient);
  }
  return ingredients;
}

function pickIngredients(product: Record<string, unknown>): string[] {
  const structured = Array.isArray(product.ingredients)
    ? uniqueIngredients((product.ingredients as Record<string, unknown>[]).map((ingredient) => ingredient?.text ?? ingredient?.id))
    : [];
  if (structured.length) return structured;

  const text =
    compactString(product.ingredients_text_en) ??
    compactString(product.ingredients_text) ??
    compactString(product.ingredients_text_with_allergens);
  if (!text) return [];
  return uniqueIngredients(text.split(/[,;\n•]+/));
}

export function normalizeBarcode(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
}

export interface BarcodeValidation {
  valid: boolean;
  barcode: string;
  message?: string;
}

export function validateBarcode(value: unknown): BarcodeValidation {
  const barcode = normalizeBarcode(value);
  if (!barcode) return { valid: false, barcode, message: ERROR_MESSAGE.BARCODE_REQUIRED };
  if (!BARCODE_PATTERN.test(barcode)) {
    return { valid: false, barcode, message: ERROR_MESSAGE.BARCODE_FORMAT_INVALID };
  }
  if (/^\d+$/.test(barcode) && !NUMERIC_BARCODE_LENGTHS.has(barcode.length)) {
    return { valid: false, barcode, message: ERROR_MESSAGE.BARCODE_LENGTH_INVALID };
  }
  return { valid: true, barcode };
}

export interface BarcodeProduct {
  name: string;
  brand?: string;
  serving_size: string;
  basis: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fibre_g?: number;
  image_url?: string | null;
  ingredients: string[];
  barcode: string;
  product_url?: string;
  source: string;
}

/** Real, no-API-key Open Food Facts lookup — this is the only product source in this checkout. */
export async function lookupBarcode(barcode: unknown): Promise<BarcodeProduct | null> {
  const validation = validateBarcode(barcode);
  if (!validation.valid) {
    throw new AppError(validation.message as string, [], 400);
  }

  const normalizedBarcode = validation.barcode;
  const url = `${OPEN_FOOD_FACTS_BASE}/${encodeURIComponent(normalizedBarcode)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "tsconfig-fooddr/1.0", Accept: "application/json" },
    });

    // Open Food Facts v2 returns HTTP 404 for a barcode it doesn't have — a normal "not found".
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new AppError(ERROR_MESSAGE.PRODUCT_LOOKUP_UNAVAILABLE, [], 503);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (data.status !== 1 || !data.product) return null;

    const product = data.product as Record<string, unknown>;
    const nutriments = (product.nutriments as Record<string, unknown> | undefined) ?? {};

    // Open Food Facts shares a barcode space with non-food catalogs (beauty, pet
    // food). Only accept genuine food products — same rule as the real service.
    const productType = String(product.product_type ?? "").toLowerCase();
    const NON_FOOD_TYPES = new Set(["beauty", "petfood", "product", "opff", "obf", "opf"]);
    const NUTRITION_KEYS = [
      "energy-kcal_100g", "energy-kcal_serving", "energy-kcal", "energy_100g", "energy_serving",
      "proteins_100g", "proteins_serving", "proteins",
      "carbohydrates_100g", "carbohydrates_serving", "carbohydrates",
      "fat_100g", "fat_serving", "fat",
    ];
    const hasFoodNutrition = NUTRITION_KEYS.some((key) => toNumber(nutriments[key]) !== undefined);
    const isFood = productType === "food" || (productType === "" && hasFoodNutrition);
    if (NON_FOOD_TYPES.has(productType) || !isFood) return null;

    const hasServing =
      toNumber(nutriments["energy-kcal_serving"]) !== undefined ||
      toNumber(nutriments.proteins_serving) !== undefined ||
      toNumber(nutriments.carbohydrates_serving) !== undefined ||
      toNumber(nutriments.fat_serving) !== undefined;
    const basis = hasServing ? "serving" : "100g";

    return {
      name: pickProductName(product),
      brand: pickBrand(product),
      serving_size: compactString(product.serving_size) ?? (basis === "100g" ? "100g" : "serving"),
      basis,
      calories: Math.round(kcalFromNutriments(nutriments, basis) ?? 0),
      protein_g: roundNutritionValue(pickNutriment(nutriments, "proteins", basis) ?? 0),
      carbs_g: roundNutritionValue(pickNutriment(nutriments, "carbohydrates", basis) ?? 0),
      fat_g: roundNutritionValue(pickNutriment(nutriments, "fat", basis) ?? 0),
      image_url: pickImage(product) ?? null,
      ingredients: pickIngredients(product),
      barcode: normalizedBarcode,
      product_url: compactString(product.url) ?? compactString(product.link),
      source: "open_food_facts",
    };
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError(ERROR_MESSAGE.PRODUCT_LOOKUP_TIMED_OUT, [], 503);
    }
    throw new AppError(ERROR_MESSAGE.PRODUCT_LOOKUP_UNAVAILABLE, [], 503);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Nutrition module service — ported from foodDR's V2 nutrition-client
 * endpoints, adapted to the *real* database schema.
 *
 * IMPORTANT: this file previously targeted a schema
 * (user_nutrition_profiles.age/height/weight-as-strings, a separate `users`
 * table, `weight_logs`, `meal_logs`, `plan_meal_slots` with an
 * `activity_level_id` FK into `nutrition_masters`) that does not exist in
 * the live database — it was a plausible-looking but fictional schema
 * carried over from the wider `wms` platform this checkout is a partial
 * export of. `npx prisma db pull` against the actual `nutrition_sandbox`
 * database (the same one foodDR's production backend-node service uses)
 * replaced prisma/schema.prisma with the 19 real tables — user identity and
 * profile live in one table, `user_nutrition_profiles` (string/UUID `id`,
 * `birth_year` not `age`, `height_cm`/`current_weight_kg` as numbers not
 * unit-tagged strings, `activity_level` as a plain string column, no
 * `nutrition_masters` FK for it); weight history lives in `daily_stats`
 * (`weight_kg`/`weight_lbs`/`weight_logged_at`, one row per user per day,
 * not a dedicated weight_logs table); meal logs live in `meals`; the plan's
 * meal schedule is a JSON blob (`meal_schedule_json`) on
 * `user_nutrition_plans`, not separate `plan_meal_slots` rows.
 *
 * `userId` is a **string** (the real `user_nutrition_profiles.id`) — every
 * signature below was changed from `number` to `string` accordingly; the
 * old `Number(req.body.authUserId)` cast in the controller would have
 * silently produced NaN for any real (non-numeric) user id.
 *
 * Health-critical constants (calorie floors, macro split, water target,
 * activity multipliers) are carried over unchanged from foodDR — see the
 * comments inline where each is used. The deterministic (non-AI) meal-slot
 * split is also unchanged by design: this checkout has no Gemini/AI wiring
 * for meal suggestions, so it never attempted to replicate foodDR's
 * AI-assisted plan generation, only the fixed-percentage fallback shape.
 */
import { randomUUID, createHash } from "crypto";
import momentTZ from "moment-timezone";
import AppError from "../core/error-handler";
import { ERROR_MESSAGE } from "../constants/index";
import commonService from "./commonService";
import {
  routineDietKey,
  routineCuisineKeys,
  routineTargetMealSlots,
  buildRoutineMealSlot,
  routineTitleCase,
  routineTo12Hour,
  buildRoutineAiInsights,
} from "./routineCatalog";
import { recognizeMeal, type RecognizedMeal } from "./gemini/mealRecognitionService";
import { interpretFoodSearchQuery } from "./gemini/foodSearchService";
import { Jimp } from "jimp";
import { sniffMimeFromBytes } from "../utils/imageInput";
import type {
  NutritionProfileReq,
  GetNutritionTimelineReq,
  GetWeightHistoryReq,
  JsonRecord,
} from "../interface/nutrition.interface";

// ── Health-critical constants (unchanged from foodDR) ───────────────────────
const CALORIE_FLOOR_FEMALE = 1200;
const CALORIE_FLOOR_MALE = 1500;
const DEFAULT_CARBS_PCT = 0.4;
const DEFAULT_PROTEIN_PCT = 0.3;
const DEFAULT_FAT_PCT = 0.3;
const WATER_LITRES_PER_KG = 0.07;
const FIBRE_G_PER_1000_KCAL = 14;
const WEIGHT_MIN_KG = 30;
const WEIGHT_MAX_KG = 300;
const LB_PER_KG = 0.453592;

const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  sedentary: 1.42,
  light: 1.45,
  moderate: 1.55,
  active: 1.8,
  very_active: 1.8,
};

// Ported verbatim from backend-node's nutritionClientV2PlanService.ts:
// 1 kg/week ≈ 1000 kcal/day above/below maintenance (TDEE), stepped in
// 250 kcal/0.25 kg increments.
const WEIGHT_TARGET_STEPS: { label: string; delta: number; type: string }[] = [
  { label: "+1 kg/wk", delta: 1000, type: "gain" },
  { label: "+0.5 kg/wk", delta: 500, type: "gain" },
  { label: "+0.25 kg/wk", delta: 250, type: "gain" },
  { label: "Maintain", delta: 0, type: "maintain" },
  { label: "-0.25 kg/wk", delta: -250, type: "loss" },
  { label: "-0.5 kg/wk", delta: -500, type: "loss" },
  { label: "-1 kg/wk", delta: -1000, type: "extreme" },
];

function buildWeightTargets(tdee: number): { label: string; calories: number; type: string }[] {
  return WEIGHT_TARGET_STEPS.map((step) => ({ label: step.label, calories: tdee + step.delta, type: step.type }));
}

// Simple, deterministic meal-slot split (foodDR's is AI-assisted; this is the
// fixed-percentage equivalent, matching the fields meal_schedule_json expects).
// meal_type values match the app's actual vocabulary everywhere else
// (breakfast/lunch/snack/dinner/drinks — see addMealFromCatalog's
// validation) — was "EVENING_SNACK" here, which nothing else in the app
// recognizes; the dashboard's action_items surfaced this directly (it built
// a "Log Evening snack" reminder pointing at a meal_type addMeal would 400
// on if the user actually tried logging it).
const MEAL_SLOT_SPLIT: { meal_type: string; scheduled_time: string; pct: number }[] = [
  { meal_type: "BREAKFAST", scheduled_time: "08:00", pct: 0.25 },
  { meal_type: "LUNCH", scheduled_time: "13:00", pct: 0.35 },
  { meal_type: "SNACK", scheduled_time: "17:00", pct: 0.1 },
  { meal_type: "DINNER", scheduled_time: "20:00", pct: 0.3 },
];

function toCm(height: string, unit: string): number {
  const value = Number(height);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(ERROR_MESSAGE.HEIGHT_MUST_BE_POSITIVE, [], 400);
  }
  return unit === "FT" ? Math.round(value * 30.48) : Math.round(value);
}

function toKg(weight: string, unit: string): number {
  const value = Number(weight);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(ERROR_MESSAGE.WEIGHT_MUST_BE_POSITIVE, [], 400);
  }
  return unit === "LB" ? Number((value * LB_PER_KG).toFixed(1)) : Number(value.toFixed(1));
}

function calculateBmr(weightKg: number, heightCm: number, age: number, gender: string): number {
  // Mifflin-St Jeor.
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (gender === "MALE") return base + 5;
  if (gender === "FEMALE") return base - 161;
  return base - 78; // OTHER — midpoint of the male/female offset
}

function calorieFloor(gender: string): number {
  return gender === "FEMALE" ? CALORIE_FLOOR_FEMALE : CALORIE_FLOOR_MALE;
}

function goalAdjustedCalories(tdee: number, primaryGoal: string | null | undefined): number {
  if (primaryGoal === "WEIGHT_LOSS") return tdee - 400;
  if (primaryGoal === "MUSCLE_GAIN") return tdee + 400;
  return tdee;
}

// user_nutrition_profiles.goal_type is a required, short lowercase code
// (confirmed against a real profile via prod's GET /auth/me: "loss" for a
// WEIGHT_LOSS user). The request interface only collects primary_goal (the
// richer, uppercase enum used elsewhere in this file's math), so goal_type
// is derived from it rather than collected twice.
function goalTypeFrom(primaryGoal: string | null | undefined): string {
  if (primaryGoal === "WEIGHT_LOSS") return "loss";
  if (primaryGoal === "MUSCLE_GAIN") return "gain";
  return "maintain";
}

// Bug found while testing updateWeight's plan-recalc response: this
// multiplied by LB_PER_KG (which is kg-per-lb, matching toKg's lb->kg
// usage above) instead of dividing, so 70kg was coming back as "31.8 lbs"
// instead of ~154.3. Fixed here since it's directly in the path just
// verified live.
function kgToLb(kg: number | null | undefined): number | null {
  return kg == null ? null : Number((Number(kg) / LB_PER_KG).toFixed(1));
}

// ── Food-catalog unit math (Add Meal type 3) — ported 1:1 from foodDR's real
// FoodCatalogService (backend-node/src/api/services/food-catalog/foodCatalogService.ts):
// normalizeUnit/unitCategory/basisForCategory/maxQuantity/basisMultiplier. Kept
// here rather than imported since this checkout has no equivalent service file.
type UnitCategory = "weight" | "volume" | "count";

function normalizeServingUnit(unit: unknown): string | null {
  const u = String(unit ?? "").trim().toLowerCase();
  if (["g", "gram", "grams", "gm", "gms"].includes(u)) return "g";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) return "kg";
  if (["ml", "milliliter", "millilitre", "milliliters", "millilitres"].includes(u)) return "ml";
  if (["piece", "pieces", "pcs", "pc", "nos", "no", "count"].includes(u)) return "piece";
  return null;
}

function unitCategoryFor(unit: string): UnitCategory | null {
  if (unit === "g" || unit === "kg") return "weight";
  if (unit === "ml") return "volume";
  if (unit === "piece") return "count";
  return null;
}

function basisForCategory(category: UnitCategory | null): string | null {
  return category === "weight" ? "100g" : category === "volume" ? "100ml" : category === "count" ? "piece" : null;
}

// Upper bound per unit — keeps computed nutrition within the DB column
// precision (calories decimal(7,2), macros decimal(6,2)) so an absurd
// quantity is a clean 400, not a database overflow 500.
function maxQuantityFor(unit: string): number | null {
  if (unit === "g") return 5000;
  if (unit === "kg") return 5;
  if (unit === "ml") return 5000;
  if (unit === "piece") return 100;
  return null;
}

// Factor to multiply per-basis (per-100g/100ml/piece) nutrition by, for a
// quantity+unit. kg -> grams first.
function basisMultiplier(quantity: number, unit: string): number | null {
  if (unit === "g") return quantity / 100;
  if (unit === "kg") return (quantity * 1000) / 100;
  if (unit === "ml") return quantity / 100;
  if (unit === "piece") return quantity;
  return null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeFoodName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Ported from foodDR's FoodCatalogRepoService.findByName: exact match on the
// normalized `name` column, else an exact match inside the `aliases` JSON
// array. On a miss, the real service makes one AI call to enrich-and-store a
// new catalog row; this checkout has no AI wiring, so a miss is an honest
// "not found" 404 instead of a fabricated AI fallback.
async function findCatalogFoodByName(name: string) {
  const norm = normalizeFoodName(name);
  if (!norm) return null;

  const byName = await commonService.getFromTable('food_catalog', { is_deleted: false, name: norm });
  if (byName) return byName;

  const candidates = await commonService.getManyFromTable('food_catalog', { is_deleted: false, aliases: { contains: norm } });
  for (const row of candidates) {
    let aliases: string[] = [];
    try {
      const parsed: unknown = row.aliases ? JSON.parse(row.aliases) : [];
      aliases = Array.isArray(parsed) ? parsed.map((a) => String(a).trim().toLowerCase()) : [];
    } catch {
      aliases = [];
    }
    if (aliases.includes(norm)) return row;
  }
  return null;
}

function todayInTz(tz: string): string {
  return momentTZ.tz(tz).format("YYYY-MM-DD");
}

function shiftDateStr(dateStr: string, deltaDays: number): string {
  return momentTZ.tz(dateStr, "YYYY-MM-DD", "UTC").add(deltaDays, "days").format("YYYY-MM-DD");
}

// ── Dashboard (getNutritionSummaryByDate) helpers — ported 1:1 from
// foodDR's nutritionClientV2SharedService.ts / meal-serializer.ts /
// meal-intake-v2.ts. All are pure, deterministic, no-AI functions — read
// from the real source rather than approximated, per the same "don't
// fabricate" standard as everything else in this file.

// Approved rotating dashboard nutrition tips — real copy from the reference,
// not invented. Index persisted on user_nutrition_profiles.last_status_message_index
// (a real column), so it never repeats and stays consistent across requests.
const STATUS_TIP_MESSAGES = [
  "Track each meal to stay closer to your daily nutrition goal.",
  "Add eggs, paneer, fish, or dal to increase protein intake.",
  "Balance calories, protein, carbs, and fat across each meal.",
  "Choose whole foods to improve nutrition quality each day.",
  "Spread protein across meals for steadier daily nutrition.",
  "Check remaining calories before planning your next meal.",
  "Add vegetables to meals for more fibre and better balance.",
  "Drink water regularly to support energy and performance.",
  "Choose fruit or nuts instead of processed snack foods.",
  "Keep portions consistent to avoid excess daily calories.",
  "Pair carbohydrates with protein to stay full for longer.",
  "Plan meals early to make nutrition goals easier to reach.",
  "Choose lean protein to improve intake without excess fat.",
  "Review daily progress before selecting your final meal.",
  "Weekly consistency matters more than one perfect day.",
];

function nextStatusTipIndex(lastIndex: unknown): number {
  const last = Number.isInteger(lastIndex) ? (lastIndex as number) : -1;
  return (last + 1) % STATUS_TIP_MESSAGES.length;
}

function pct(consumed: unknown, target: unknown): number {
  const safeTarget = Number(target ?? 0);
  if (safeTarget <= 0) return 0;
  const value = Number(consumed ?? 0);
  if (value >= safeTarget) return 100;
  return Math.min(99.9, Math.round((value / safeTarget) * 1000) / 10);
}

function mlToLitres(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric / 100) / 10;
}

function to12Hour(date: Date, tz: string): string {
  return date.toLocaleTimeString("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
}

function composeMealName(mealName: unknown, mealType: unknown): string {
  const name = String(mealName ?? "").trim();
  return name || `${String(mealType ?? "Meal")} meal`;
}

function pascalMealType(mealType: unknown): string {
  const s = String(mealType ?? "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

// Ported verbatim from foodDR's nutritionClientV2SharedService.ts —
// snake_case enum -> human-readable Title Case for display fields
// (e.g. "very_active" -> "Very Active", "non_vegetarian" -> "Non Vegetarian").
function titleCaseWords(value: unknown): string {
  return String(value ?? "")
    .replace(/_+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-/&(])([a-z])/g, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

// A DB-generated UUID isn't a nice public-facing id; the real system hashes
// it down to a stable positive integer instead of exposing the raw UUID.
function toPublicMealId(internalId: unknown): number {
  const raw = String(internalId ?? "").trim();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  }
  const digest = createHash("sha256").update(raw || "meal").digest("hex").slice(0, 12);
  return Number((BigInt(`0x${digest}`) % 9_000_000_000n) + 1_000_000_000n);
}

function statusMessage(statusPill: unknown): string {
  if (statusPill === "on_track") return "You're on track with your nutrition goals today!";
  if (statusPill === "over") return "You are over your nutrition target today.";
  if (statusPill === "recover_today") return "Recovery mode is active today.";
  return "Keep logging meals to stay on track with your nutrition goals.";
}

function timelineTitle(score: number): string {
  if (score >= 80) return "Super Good!";
  if (score >= 60) return "Great Progress";
  if (score >= 40) return "Keep Going";
  return "Recover Today";
}

function timelineStatus(statusPill: unknown): string {
  if (statusPill === "on_track") return "Healthy";
  if (statusPill === "over") return "Over Target";
  if (statusPill === "recover_today") return "Recovery";
  return "Keep Going";
}

// Absolute demo-meal placeholder, same relative path the real system falls
// back to for a meal with no real photo (this checkout has no photo-upload
// pipeline of its own — addMeal never stores one).
function mealImageUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  return `${req.protocol}://${req.get("host")}/i/default-demo-meal.jpg`;
}

// Bug found via a real report: Quick Add's uploaded photo saves correctly
// (meals.photo_url) but every meal LIST endpoint (dashboard, progress,
// loggedMealsByDate) was calling mealImageUrl(req) unconditionally instead
// of checking the stored photo first, so every logged meal showed the demo
// placeholder regardless of what was actually uploaded. photo_url is
// already a full absolute URL (built by storeUploadedImage), so this is a
// straight fallback, not a path join.
function resolvedMealImageUrl(photoUrl: string | null | undefined, req: { protocol: string; get(name: string): string | undefined }): string {
  return photoUrl || mealImageUrl(req);
}

// Deterministic per-meal "dominant nutrient" + benefit copy — ported from
// meal-v2-fields.ts's computeDominantNutrient/mealBenefitDescription. This
// is the real system's own non-AI fallback path (used whenever its AI
// meal-benefits adapter is unavailable), not an approximation invented here.
function computeDominantNutrient(n: { protein: number; carbs: number; fat: number; fibre: number }): { name: string; benefit: string } {
  const { protein, carbs, fat, fibre } = n;
  if (fibre >= 8 && fibre >= protein && fibre >= fat) {
    return { name: "Fibre", benefit: "Aids digestion and helps you feel full for longer." };
  }
  const proteinKcal = protein * 4;
  const carbsKcal = carbs * 4;
  const fatKcal = fat * 9;
  const max = Math.max(proteinKcal, carbsKcal, fatKcal);
  if (max <= 0) return { name: "Balanced", benefit: "A balanced mix of macronutrients." };
  if (max === proteinKcal) return { name: "Protein", benefit: "Supports muscle repair and helps keep you full." };
  if (max === fatKcal) return { name: "Healthy Fats", benefit: "Supports hormone balance and nutrient absorption." };
  return { name: "Carbohydrates", benefit: "Provides quick energy to fuel your day." };
}

function mealBenefitDescription(n: { protein: number; carbs: number; fat: number; fibre: number }): string {
  const dom = computeDominantNutrient(n);
  if (dom.name === "Balanced") return dom.benefit;
  return `Rich in ${dom.name.toLowerCase()}. ${dom.benefit}`;
}

// ── Meal recommendation (green/yellow/red) — ported from foodDR's real
// meal-v2-fields.ts (rateHealthFromMacros / hasUnhealthyOrOilTerms /
// computeMealRecommendation). Deterministic fallback used whenever there's
// no AI health_rating (true for every meal this checkout saves, since it
// has no AI wiring) — same macro thresholds and fried/oily-keyword override
// as the real system's own non-AI path.
const UNHEALTHY_OR_OIL_PATTERNS = [
  /\b(deep[-\s]?fried|stir[-\s]?fried|refried|fried|fritter|fritters|pakora|pakoda|samosa|kachori|bhatura|vada|varuval|chips?|fries?|burger|pizza|doughnut|donut|chin chin)\b/i,
  /\b(oil[-\s]?heavy|heavy oil|excess(?:ive)? oil|hot oil|chili oil|chilli oil|palm oil)\b/i,
  /\boily\b|\bghee\b/i,
];

function hasUnhealthyOrOilTerms(text: string): boolean {
  return text ? UNHEALTHY_OR_OIL_PATTERNS.some((pattern) => pattern.test(text)) : false;
}

function rateHealthFromMacros(n: { calories: number; protein: number; fat: number; fibre: number }): "green" | "yellow" | "red" {
  if (n.calories <= 0) return "yellow";
  const fatPct = (n.fat * 9) / n.calories;
  if (fatPct >= 0.45) return "red";
  if ((n.fibre >= 3 || n.protein >= 12) && fatPct <= 0.35) return "green";
  return "yellow";
}

const MEAL_RECOMMENDATIONS: Record<"green" | "yellow" | "red", { status: string; title: string; message: string }> = {
  green: { status: "green", title: "Recommended", message: "This is a nutritious choice that fits well with your nutrition goals." },
  yellow: { status: "yellow", title: "Okay in Moderation", message: "This is fine occasionally — keep an eye on the portion size." },
  red: { status: "red", title: "Choose Carefully", message: "This is high in calories or fat — best kept as an occasional treat." },
};

function computeMealRecommendation(n: { calories: number; protein: number; fat: number; fibre: number }, contextText: string) {
  const rating = hasUnhealthyOrOilTerms(contextText) ? "red" : rateHealthFromMacros(n);
  return MEAL_RECOMMENDATIONS[rating];
}

// ── Saved-meal response — ported from foodDR's real meal-intake-v2.ts
// (clientMealResult + savedMealResult + decorateWithV2Fields), the shape
// used by addMeal's success response for a persisted meal row.
function buildSavedMealResponse(
  meal: { id: string; meal_type: string; meal_name: string | null; calories: unknown; protein_g: unknown; carbs_g: unknown; fat_g: unknown; fibre_g: unknown },
  req: { protocol: string; get(name: string): string | undefined },
  options: {
    serving_size?: number;
    serving_unit?: string;
    ingredients?: string[];
    imageUrl?: string;
    // AI-provided dominant_nutrient/health_rating (image recognition path)
    // take priority over the deterministic macro fallback — same preference
    // order as the real system's decorateWithV2Fields.
    aiDominantNutrient?: { name: string; benefit: string } | null;
    aiHealthRating?: "green" | "yellow" | "red" | null;
  } = {},
) {
  const nutrition = {
    calories: Math.round(Number(meal.calories)),
    protein: round1(Number(meal.protein_g)),
    carbs: round1(Number(meal.carbs_g)),
    fat: round1(Number(meal.fat_g)),
    fibre: round1(Number(meal.fibre_g)),
  };
  const mealName = (meal.meal_name && meal.meal_name.trim()) || `${pascalMealType(meal.meal_type)} meal`;
  const ingredients = options.ingredients && options.ingredients.length > 0 ? options.ingredients : [mealName];
  const imageUrl = options.imageUrl ?? mealImageUrl(req);
  const contextText = [mealName, ...ingredients].join(" ");
  const meal_recommendation = hasUnhealthyOrOilTerms(contextText)
    ? MEAL_RECOMMENDATIONS.red
    : options.aiHealthRating
      ? MEAL_RECOMMENDATIONS[options.aiHealthRating]
      : MEAL_RECOMMENDATIONS[rateHealthFromMacros(nutrition)];
  return {
    meal_id: toPublicMealId(meal.id),
    meal_name: mealName,
    meal_type: pascalMealType(meal.meal_type),
    image_url: imageUrl,
    meal_image_url: imageUrl,
    thumbnail_url: imageUrl,
    serving_size: options.serving_size ?? 1,
    serving_unit: options.serving_unit ?? "serving",
    nutrition,
    ingredients,
    is_meal_eligible: true,
    is_saved: true,
    dominant_nutrient: options.aiDominantNutrient ?? computeDominantNutrient(nutrition),
    meal_recommendation,
  };
}

// Downscale + store an uploaded photo as the meal's real image (media_files
// table — no disk/object storage wired in this checkout), returning a
// servable URL. Used by every addMeal type that can carry a photo — for
// type 2 the bytes are also sent to Gemini for recognition; for type 1/3
// this is storage only (no AI call), matching the real system's own type-3
// comment: "the photo is never sent through AI food recognition; it's just
// persisted as the meal's image, same as any other type."
async function storeUploadedImage(
  imageBuffer: Buffer,
  req: { protocol: string; get(name: string): string | undefined },
): Promise<string | null> {
  const img = await Jimp.fromBuffer(imageBuffer).catch(() => null);

  let content: Buffer;
  let mime: string;
  let ext: string;
  if (img) {
    if (img.width > 768) {
      const scale = 768 / img.width;
      img.resize({ w: 768, h: Math.max(1, Math.round(img.height * scale)) });
    }
    content = await img.getBuffer("image/jpeg");
    mime = "image/jpeg";
    ext = "jpg";
  } else {
    // Jimp couldn't decode this format — this checkout's Jimp build has no
    // WebP decoder (same limitation as mealRecognitionService.ts's
    // normalizeForRecognition). Store the original bytes as-is instead of
    // losing the real photo and silently falling back to the demo image.
    mime = sniffMimeFromBytes(imageBuffer) ?? "image/jpeg";
    ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    content = imageBuffer;
  }

  const filename = `${randomUUID()}.${ext}`;
  await commonService.insertIntoTable('media_files', { filename, mime, content });
  return `${req.protocol}://${req.get("host")}/media/${filename}`;
}

// ── addMeal type 2 (image upload) meal-type resolution — ported verbatim
// from foodDR's meal-intake-v2.ts. Food recognition owns the category;
// upload time is only a fallback when recognition returns no valid
// meal_type. The snack/drink keyword overrides are deterministic on
// purpose (backend owns classification, not the AI) — not shortened, since
// a smaller list would silently misclassify real foods the original list
// was tuned to catch.
function mealTypeFromCurrentTime(tz: string): string {
  const hour = momentTZ.tz(tz).hour();
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 19) return "snack";
  return "dinner";
}

const SNACK_KEYWORDS = [
  "coffee", "espresso", "latte", "cappuccino", "americano", "mocha",
  "tea", "chai", "matcha",
  "juice", "smoothie", "milkshake", "shake", "lassi", "buttermilk",
  "biscuit", "cookie", "cracker", "rusk", "wafer", "muffin", "cupcake",
  "doughnut", "donut", "brownie", "croissant",
  "nuts", "almond", "cashew", "peanut", "walnut", "pistachio", "trail mix",
  "makhana", "fox nut",
  "protein bar", "energy bar", "granola bar", "cereal bar", "granola",
  "yogurt", "yoghurt", "curd",
  "sandwich",
  "chips", "crisps", "popcorn", "nachos", "namkeen", "bhujia", "mixture",
  "samosa", "pakora", "vada", "fritter", "spring roll", "cutlet",
  "chocolate", "candy", "toffee", "ice cream", "popsicle",
  "fruit", "apple", "banana", "orange", "mango", "grape", "watermelon",
  "papaya", "pineapple", "guava", "pear", "peach", "plum", "kiwi",
  "berry", "berries", "strawberry", "blueberry", "pomegranate",
];

const DRINK_KEYWORDS = [
  "juice", "smoothie", "milkshake", "shake", "coffee", "latte", "cappuccino", "espresso", "mocha", "frappe",
  "tea", "chai", "lassi", "buttermilk", "chaas", "soda", "cola", "lemonade", "mojito", "mocktail", "cocktail",
  "water", "beverage", "drink", "kombucha", "milk", "cordial", "squash", "sharbat", "aam panna", "coconut water",
];

const UPLOAD_MEAL_TYPES = new Set(["breakfast", "lunch", "snack", "dinner", "drinks"]);

function normalizedRecognizedMealType(recognized: RecognizedMeal | null): string | null {
  const mealType = String(recognized?.meal_type ?? "").trim().toLowerCase();
  return UPLOAD_MEAL_TYPES.has(mealType) ? mealType : null;
}

function isSnackUpload(recognized: RecognizedMeal | null): boolean {
  const matchesSnackKeyword = (value: unknown): boolean => {
    const text = String(value ?? "").toLowerCase();
    return Boolean(text) && SNACK_KEYWORDS.some((keyword) => text.includes(keyword));
  };
  const items = recognized?.items ?? [];
  if (items.length > 0) {
    return items.every((item) => matchesSnackKeyword(item.food_name));
  }
  if (normalizedRecognizedMealType(recognized) === "snack") return true;
  const haystack = String(recognized?.meal_name ?? "").toLowerCase();
  if (!haystack.trim()) return false;
  return matchesSnackKeyword(haystack);
}

function isDrinkUpload(recognized: RecognizedMeal | null): boolean {
  const items = recognized?.items ?? [];
  if (normalizedRecognizedMealType(recognized) === "drinks" && items.length === 0) return true;
  if (!items.length) return false;
  return items.every((it) => {
    const name = String(it.food_name ?? "").toLowerCase();
    return Boolean(name) && DRINK_KEYWORDS.some((k) => name.includes(k));
  });
}

function resolveUploadMealType(recognized: RecognizedMeal | null, timeBasedMealType: string): string {
  if (isDrinkUpload(recognized)) return "drinks";
  if (isSnackUpload(recognized)) return "snack";
  return normalizedRecognizedMealType(recognized) ?? timeBasedMealType;
}

// ── Achievements catalog — verbatim port of foodDR's real
// achievement-types.ts. Static data, no AI, fully portable. This checkout
// never grants achievements itself (nothing writes to the `achievements`
// table anywhere in this file), so `unlocked` is always empty for a
// tsconfig-only user — the catalog/level/category STRUCTURE is still real,
// just showing an honest all-locked state rather than one this checkout
// fabricated progress for.
const STREAK_TYPES: Record<string, number> = { streak_3: 3, streak_7: 7, streak_14: 14, streak_30: 30 };
const MEAL_STREAK_TYPES: Record<string, number> = { meal_streak_3: 3 };
const WATER_STREAK_TYPES: Record<string, number> = { water_streak_3: 3, water_streak_7: 7 };
const PERFECT_WEEK = "perfect_week";
const ACHIEVEMENT_TIERS: Record<string, string> = {
  streak_3: "bronze", streak_7: "silver", streak_14: "gold", streak_30: "obsidian",
  first_meal_logged: "bronze", full_day_meals: "silver", meal_streak_3: "gold",
  water_first_day: "bronze", water_streak_3: "silver", water_streak_7: "gold",
  perfect_day_first: "silver", perfect_week: "obsidian",
  first_1kg_lost: "bronze", first_1kg_gained: "bronze", five_percent_lost: "silver",
  halfway_to_goal: "gold", consistent_gain_3_weeks: "gold",
  target_weight_reached_loss: "obsidian", target_weight_reached_gain: "obsidian",
  maintenance_2_weeks: "obsidian", comeback: "silver",
};
const ACHIEVEMENT_CATEGORIES: Record<string, string> = {
  streak_3: "streak", streak_7: "streak", streak_14: "streak", streak_30: "streak",
  first_meal_logged: "meal", full_day_meals: "meal", meal_streak_3: "meal",
  water_first_day: "water", water_streak_3: "water", water_streak_7: "water",
  perfect_day_first: "day", perfect_week: "day",
  first_1kg_lost: "weight", five_percent_lost: "weight", halfway_to_goal: "weight",
  target_weight_reached_loss: "weight", maintenance_2_weeks: "weight",
  first_1kg_gained: "weight", consistent_gain_3_weeks: "weight", target_weight_reached_gain: "weight",
  comeback: "comeback",
};
const ACHIEVEMENT_LABELS: Record<string, { title: string; subtitle: string }> = {
  streak_3: { title: "3-day streak", subtitle: "Small but real." },
  streak_7: { title: "7-day streak", subtitle: "The hardest part is behind you." },
  streak_14: { title: "14-day streak", subtitle: "This is becoming a habit." },
  streak_30: { title: "30-day streak", subtitle: "A full month." },
  first_1kg_lost: { title: "First kilo down", subtitle: "Real progress." },
  five_percent_lost: { title: "5% body weight lost", subtitle: "Major health win." },
  halfway_to_goal: { title: "Halfway there", subtitle: "Half the journey done." },
  target_weight_reached_loss: { title: "Target reached", subtitle: "You hit your goal weight." },
  maintenance_2_weeks: { title: "2 weeks at goal", subtitle: "Holding the line." },
  first_1kg_gained: { title: "First kilo up", subtitle: "Building momentum." },
  consistent_gain_3_weeks: { title: "3 weeks consistent gain", subtitle: "The plan is working." },
  target_weight_reached_gain: { title: "Target reached", subtitle: "You hit your goal weight." },
  first_meal_logged: { title: "First log", subtitle: "Tracking starts here." },
  full_day_meals: { title: "Full-day logger", subtitle: "All four meals in one day." },
  meal_streak_3: { title: "Meal streak", subtitle: "Three days of logging in a row." },
  water_first_day: { title: "Hydration win", subtitle: "Water target hit." },
  water_streak_3: { title: "3-day hydration", subtitle: "Consistency pays." },
  water_streak_7: { title: "7-day hydration", subtitle: "A full week on target." },
  perfect_day_first: { title: "Perfect day", subtitle: "Meals, calories, water — all on point." },
  perfect_week: { title: "Perfect week", subtitle: "Seven flawless days." },
  comeback: { title: "Welcome back", subtitle: "You returned and logged again." },
};
const TIER_POINTS: Record<string, number> = { bronze: 10, silver: 25, gold: 50, obsidian: 100 };
const TIER_COLORS: Record<string, string> = { bronze: "#A0522D", silver: "#8C8C8C", gold: "#F2B705", obsidian: "#2ECC71" };
const BADGE_BG_COLORS: Record<string, string> = { ...TIER_COLORS, bronze: "#F59E0A1C" };
const TIER_ORDER = ["bronze", "silver", "gold", "obsidian"];
const POINTS_PER_LEVEL = 100;
const ACHIEVEMENT_CATEGORY_LABELS: Record<string, string> = {
  streak: "Streak", meal: "Meals", water: "Water", day: "Day", weight: "Weight", comeback: "Comeback",
};

class NutritionControllerService {
  // ── 1. Generate Personalized Nutrition Plan ─────────────────────────────
  async generatePlan(userId: string, orgId: number | null, body: NutritionProfileReq) {
    const heightCm = toCm(body.height, body.height_unit);
    const weightKg = toKg(body.weight, body.weight_unit);
    // Defaults to current weight (maintain) when omitted — see the interface's
    // doc comment on `goal_weight`.
    const goalWeightKg = toKg(body.goal_weight ?? body.weight, body.weight_unit);
    const age = body.age;
    const gender = body.gender;

    const activityKey = String(body.activity_level || "moderate").toLowerCase();
    const activityMultiplier = ACTIVITY_MULTIPLIERS[activityKey] ?? ACTIVITY_MULTIPLIERS.moderate;

    const bmr = Math.round(calculateBmr(weightKg, heightCm, age, gender));
    const tdee = Math.round(bmr * activityMultiplier);
    const adjustedCalories = goalAdjustedCalories(tdee, body.primary_goal);
    const calorieTarget = Math.max(calorieFloor(gender), adjustedCalories);

    const proteinTargetG = Math.round((calorieTarget * DEFAULT_PROTEIN_PCT) / 4);
    const carbsTargetG = Math.round((calorieTarget * DEFAULT_CARBS_PCT) / 4);
    const fatTargetG = Math.round((calorieTarget * DEFAULT_FAT_PCT) / 9);
    const fibreTargetG = Math.round((calorieTarget / 1000) * FIBRE_G_PER_1000_KCAL);
    const waterTargetL = Number((weightKg * WATER_LITRES_PER_KG).toFixed(2));
    const waterTargetMl = Math.round(waterTargetL * 1000);

    const birthYear = new Date().getUTCFullYear() - age;
    const goalType = goalTypeFrom(body.primary_goal);

    const profileData = {
      birth_year: birthYear,
      gender,
      height_cm: heightCm,
      height_unit: "cm",
      current_weight_kg: weightKg,
      current_weight_lbs: kgToLb(weightKg),
      goal_weight_kg: goalWeightKg,
      goal_weight_lbs: kgToLb(goalWeightKg),
      weight_unit: "kg",
      goal_type: goalType,
      activity_level: activityKey,
      // Required, non-nullable in the real schema; this request shape has no
      // dedicated field for it, so a sensible default is used when absent
      // rather than leaving it undefined (which the DB would reject).
      dietary_preference: body.diet_type ?? "NON_VEGETARIAN",
      cuisine_preferences: JSON.stringify(body.food_preferences ? [body.food_preferences] : []),
      primary_goal: body.primary_goal ?? null,
      secondary_goal: body.secondary_goal ?? null,
      health_conditions: body.health_conditions ?? null,
      energy_level: body.energy_level ?? null,
      meals_per_day: body.meals_per_day ?? null,
      water_intake: body.water_intake ? Number(body.water_intake) : null,
      water_intake_unit: body.water_intake_unit ?? null,
      bmr,
      tdee,
      org_id: orgId,
    };

    // One row per user, keyed by the real primary key (id === userId).
    const profile = await commonService.upsertInTable(
      'user_nutrition_profiles',
      { id: userId },
      { id: userId, created_by: userId, ...profileData },
      profileData,
    );

    const mealSlots = MEAL_SLOT_SPLIT.map((slot) => ({
      meal_type: slot.meal_type,
      scheduled_time: slot.scheduled_time,
      title: slot.meal_type.replace("_", " "),
      calories: Math.round(calorieTarget * slot.pct),
      protein_g: Math.round(proteinTargetG * slot.pct),
      carbs_g: Math.round(carbsTargetG * slot.pct),
      fat_g: Math.round(fatTargetG * slot.pct),
      fibre_g: Math.round(fibreTargetG * slot.pct),
    }));
    const mealScheduleJson = JSON.stringify(mealSlots);

    // No unique constraint on user_nutrition_plans.user_id alone (unlike the
    // profile table), so "one active plan per user" is enforced here rather
    // than via Prisma upsert: find the current active plan and update it in
    // place, or create version 1 if none exists yet.
    const existingPlan = await commonService.getFromTable(
      'user_nutrition_plans',
      { user_id: userId, is_active: true, is_deleted: false },
      { orderBy: { version: "desc" } },
    );

    const planData = {
      calorie_target: calorieTarget,
      protein_target_g: proteinTargetG,
      carbs_target_g: carbsTargetG,
      fat_target_g: fatTargetG,
      fibre_target_g: fibreTargetG,
      water_target_ml: waterTargetMl,
      meal_schedule_json: mealScheduleJson,
    };

    if (existingPlan) {
      await commonService.updateTable('user_nutrition_plans', { id: existingPlan.id }, planData);
    } else {
      await commonService.insertIntoTable('user_nutrition_plans', {
        id: randomUUID(),
        user_id: userId,
        org_id: orgId,
        user_nutrition_profiles_id: profile.id,
        created_by: userId,
        ...planData,
      });
    }

    // Response shape ported verbatim from backend-node's
    // nutritionClientV2PlanService.ts generatePlan() — nested {value, unit}
    // daily_targets, the weight_targets ladder (calories at each kg/week
    // step around TDEE), and user_detailes (keys spelled exactly as the
    // real client contract: "user_detailes" / "food_perference"). This
    // checkout always stores weight in kg regardless of input unit (see
    // profileData above), so current_weight/current_weight_kg are always
    // equal here — real prod echoes back whichever unit the user onboarded
    // with instead.
    return {
      daily_targets: {
        calories: { value: calorieTarget, unit: "kcal" },
        protein: { value: proteinTargetG, unit: "g" },
        carbs: { value: carbsTargetG, unit: "g" },
        fat: { value: fatTargetG, unit: "g" },
        bmr: { value: bmr, unit: "kcal" },
        tdee: { value: tdee, unit: "kcal" },
      },
      weight_targets: buildWeightTargets(tdee),
      user_detailes: {
        current_weight: weightKg,
        current_weight_kg: weightKg,
        goal_weight: goalWeightKg,
        goal_weight_kg: goalWeightKg,
        weight_unit: "kg",
        // Title Case for display, e.g. "very_active" -> "Very Active" — real
        // source's own titleCaseWords (nutritionClientV2SharedService.ts).
        // Confirmed bug report: the raw snake_case value was showing verbatim
        // (with the underscore) on the iOS Plan Summary screen.
        activity: titleCaseWords(activityKey),
        body_type: body.body_type ?? "average",
        food_perference: titleCaseWords(profile.dietary_preference),
      },
    };
  }

  // ── 2. Weight History (?page=1&limit=10) ────────────────────────────────
  // Real weight history is one row per user per day in `daily_stats`
  // (weight_kg/weight_lbs/weight_logged_at), not a dedicated weight_logs
  // table — see this file's header comment.
  async getWeightHistory(userId: string, query: GetWeightHistoryReq) {
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
    const page = Math.max(1, Number(query.page) || 1);

    const where = { user_id: userId, is_deleted: false, weight_kg: { not: null } };
    const [rows, total] = await Promise.all([
      commonService.getManyFromTable('daily_stats', where, {
        orderBy: { date: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      commonService.countInTable('daily_stats', where),
    ]);

    let currentWeight: number | null = rows[0]?.weight_kg != null ? Number(rows[0].weight_kg) : null;
    let currentWeightUnit = "KG";
    if (currentWeight === null) {
      // No logged entries yet — fall back to the profile's stored current weight.
      const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
      currentWeight = profile?.current_weight_kg != null ? Number(profile.current_weight_kg) : 0;
      currentWeightUnit = (profile?.weight_unit ?? "kg").toUpperCase();
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      current_weight: currentWeight,
      weight_unit: currentWeightUnit,
      history: rows.map((r) => ({
        id: `w_${r.id}`,
        date: momentTZ(r.date).format("YYYY-MM-DD"),
        weight: Number(r.weight_kg),
        weight_unit: "KG",
      })),
      page,
      limit,
      total,
      total_pages: totalPages,
      current_page: page,
    };
  }

  // ── 3. Nutrition Timeline By Date (?date=YYYY-MM-DD&page=1&limit=30) ────
  // Real meal logs live in `meals`, not a `meal_logs` table.
  // Ported from foodDR's real nutritionClientV2TimelineService.ts: one merged,
  // chronologically-sorted feed of every actually-logged activity for the day
  // — meals (every one, no dedup), a single running water-total row (only
  // when water was logged), and a weight row (only on the exact date it was
  // last updated) — not just a meals list. `unit` differs per row
  // (kcal/ml/kg) so the client knows how to render `calories`.
  async getTimeline(userId: string, query: GetNutritionTimelineReq) {
    if (!query.date) {
      throw new AppError(ERROR_MESSAGE.DATE_REQUIRED, [], 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      throw new AppError(ERROR_MESSAGE.INVALID_DATE_FORMAT, [], 400);
    }
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const date = query.date;
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 30));
    const page = Math.max(1, Number(query.page) || 1);
    const dateObj = momentTZ.tz(date, "YYYY-MM-DD", "UTC").toDate();
    const dayStart = momentTZ.tz(date, "YYYY-MM-DD", tz).startOf("day").toDate();
    const dayEnd = momentTZ.tz(date, "YYYY-MM-DD", tz).endOf("day").toDate();

    const [meals, stats] = await Promise.all([
      commonService.getManyFromTable('meals', { user_id: userId, is_deleted: false, logged_at: { gte: dayStart, lte: dayEnd } }),
      commonService.findOneInTable('daily_stats', { user_id_date: { user_id: userId, date: dateObj } }),
    ]);

    const fmt24 = (d: Date | null | undefined) => (d ? momentTZ(d).tz(tz).format("HH:mm") : "");
    const ts = (d: Date | null | undefined) => (d ? d.getTime() : 0);

    type Row = { sortKey: number; time: string; title: string; subtitle: string; value: number; unit: string };
    const mealRows: Row[] = meals.map((m) => {
      const calories = Math.round(Number(m.calories));
      return {
        sortKey: ts(m.logged_at),
        time: fmt24(m.logged_at),
        title: pascalMealType(m.meal_type) || "Meal",
        subtitle: composeMealName(m.meal_name, m.meal_type) || `${calories} kcal`,
        value: calories,
        unit: "kcal",
      };
    });

    const waterRows: Row[] = [];
    const waterConsumedMl = Math.trunc(Number(stats?.water_consumed_ml ?? 0));
    if (waterConsumedMl > 0) {
      const waterAt = stats?.water_logged_at ?? stats?.updated_at ?? null;
      waterRows.push({
        sortKey: ts(waterAt),
        time: fmt24(waterAt),
        title: "Water",
        subtitle: `${mlToLitres(waterConsumedMl)} L logged`,
        value: waterConsumedMl,
        unit: "ml",
      });
    }

    const weightRows: Row[] = [];
    const lastWeightUpdateDate = profile.last_weight_update_date ? momentTZ(profile.last_weight_update_date).format("YYYY-MM-DD") : null;
    if (lastWeightUpdateDate === date && profile.current_weight_kg != null) {
      const weightAt = stats?.weight_logged_at ?? stats?.updated_at ?? null;
      const displayUnit = (profile.weight_unit || "kg").toLowerCase();
      const weightValue = displayUnit === "lb" && profile.current_weight_lbs != null ? Number(profile.current_weight_lbs) : Number(profile.current_weight_kg);
      weightRows.push({
        sortKey: ts(weightAt),
        time: fmt24(weightAt),
        title: "Weight",
        subtitle: `${weightValue} ${displayUnit} logged`,
        value: weightValue,
        unit: displayUnit,
      });
    }

    const items = [...mealRows, ...waterRows, ...weightRows]
      .sort((a, b) => a.sortKey - b.sortKey || a.time.localeCompare(b.time))
      .map((row, i) => ({
        id: i + 1,
        title: row.title,
        subtitle: row.subtitle,
        time: row.time,
        date,
        display_date: momentTZ(date).format("D MMM YYYY"),
        calories: row.value,
        unit: row.unit,
      }))
      .reverse();

    const totalPages = Math.max(1, Math.ceil(items.length / limit));
    return {
      items: items.slice((page - 1) * limit, (page - 1) * limit + limit),
      total_pages: totalPages,
      current_page: page,
    };
  }

  // ── Update Weight (range 30–300 kg) ──────────────────────────────────────
  // Real, ported from foodDR's nutritionClientV2WeightService.ts:
  // updateWeight recomputes calorie/macro/water targets from the new weight
  // (same formula generatePlan uses) and rewrites them onto the user's
  // existing active plan row in place — so every screen reading the plan
  // sees fresh numbers immediately and nothing can show a stale plan (the
  // Product Team's "previous plan should not be displayed" requirement is
  // satisfied by construction, not extra filtering). `plan_updated` +
  // `updated_plan` tell the client explicitly that this happened.
  //
  // Deliberately NOT ported (explicit product decision, not an oversight):
  // prod's progressive weight-change tolerance window (±3kg/week1, ±6kg
  // after) and once-a-week update gate. This checkout's weight updates stay
  // unrestricted, matching the ticket's actual ask.
  async updateWeight(userId: string, body: JsonRecord) {
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }

    const unit = typeof body.weight_unit === "string" ? body.weight_unit.toUpperCase() : (profile.weight_unit ?? "kg").toUpperCase();
    const rawValue = Number(body.weight ?? body.weight_kg ?? body.weight_lb);
    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      throw new AppError(ERROR_MESSAGE.WEIGHT_MUST_BE_POSITIVE, [], 400);
    }
    const weightKg = unit === "LB" ? Number((rawValue * LB_PER_KG).toFixed(1)) : Number(rawValue.toFixed(1));
    if (weightKg < WEIGHT_MIN_KG || weightKg > WEIGHT_MAX_KG) {
      throw new AppError(`weight must be between ${WEIGHT_MIN_KG} and ${WEIGHT_MAX_KG} kg`, [], 400);
    }
    const weightLbs = kgToLb(weightKg);

    const today = todayInTz(profile.timezone || "Asia/Kolkata");
    const todayDate = momentTZ.tz(today, "YYYY-MM-DD", "UTC").toDate();

    await commonService.updateTable('user_nutrition_profiles', { id: userId }, {
      current_weight_kg: weightKg,
      current_weight_lbs: weightLbs,
      last_weight_update_date: todayDate,
    });

    await commonService.upsertInTable(
      'daily_stats',
      { user_id_date: { user_id: userId, date: todayDate } },
      {
        id: randomUUID(),
        user_id: userId,
        date: todayDate,
        weight_kg: weightKg,
        weight_lbs: weightLbs,
        weight_logged_at: new Date(),
      },
      { weight_kg: weightKg, weight_lbs: weightLbs, weight_logged_at: new Date() },
    );

    const updatedPlan = await this.recalculatePlanForNewWeight(profile, weightKg);

    return {
      current_weight: weightKg,
      current_weight_lbs: weightLbs,
      weight_unit: profile.weight_unit ?? "kg",
      updated_at: today,
      // Tells the client the Nutrition Plan was recalculated for this weight
      // and hands back the fresh targets so it never has to keep showing the
      // pre-update plan while waiting for a separate fetch.
      plan_updated: updatedPlan !== null,
      ...(updatedPlan ? { updated_plan: updatedPlan } : {}),
    };
  }

  // Recompute calorie/macro/water targets from the user's updated weight
  // (same math generatePlan uses) and persist them onto the existing active
  // plan row — without touching meal_schedule_json, so current meal
  // suggestions aren't discarded just because weight changed. Best-effort:
  // a failure here must never fail the weight update itself, since the
  // weight is already persisted by the time this runs (matches real
  // source's own try/catch-to-null contract).
  private async recalculatePlanForNewWeight(
    profile: { id: string; org_id: number | null; height_cm: unknown; birth_year: number | null; gender: string | null; activity_level: string; primary_goal: string | null },
    weightKg: number,
  ) {
    try {
      const heightCm = Number(profile.height_cm);
      const age = profile.birth_year ? new Date().getUTCFullYear() - profile.birth_year : null;
      const gender = profile.gender ?? "MALE";
      if (!Number.isFinite(heightCm) || !age) return null;

      const activityKey = String(profile.activity_level || "moderate").toLowerCase();
      const activityMultiplier = ACTIVITY_MULTIPLIERS[activityKey] ?? ACTIVITY_MULTIPLIERS.moderate;
      const bmr = Math.round(calculateBmr(weightKg, heightCm, age, gender));
      const tdee = Math.round(bmr * activityMultiplier);
      const adjustedCalories = goalAdjustedCalories(tdee, profile.primary_goal);
      const calorieTarget = Math.max(calorieFloor(gender), adjustedCalories);

      const proteinTargetG = Math.round((calorieTarget * DEFAULT_PROTEIN_PCT) / 4);
      const carbsTargetG = Math.round((calorieTarget * DEFAULT_CARBS_PCT) / 4);
      const fatTargetG = Math.round((calorieTarget * DEFAULT_FAT_PCT) / 9);
      const waterTargetMl = Math.round(weightKg * WATER_LITRES_PER_KG * 1000);

      const targetFields = {
        calorie_target: calorieTarget,
        protein_target_g: proteinTargetG,
        carbs_target_g: carbsTargetG,
        fat_target_g: fatTargetG,
        water_target_ml: waterTargetMl,
      };
      const existing = await commonService.getFromTable(
        'user_nutrition_plans',
        { user_id: profile.id, is_active: true, is_deleted: false },
        { orderBy: { version: "desc" } },
      );
      if (existing) {
        await commonService.updateTable('user_nutrition_plans', { id: existing.id }, targetFields);
      } else {
        await commonService.insertIntoTable('user_nutrition_plans', {
          id: randomUUID(), user_id: profile.id, org_id: profile.org_id, user_nutrition_profiles_id: profile.id, created_by: profile.id, ...targetFields,
        });
      }
      return {
        calories: { value: calorieTarget, unit: "kcal" },
        protein: { value: proteinTargetG, unit: "g" },
        carbs: { value: carbsTargetG, unit: "g" },
        fat: { value: fatTargetG, unit: "g" },
      };
    } catch {
      return null;
    }
  }

  // ── Nutrition Dashboard — ported from foodDR's real
  // nutritionClientV2SummaryService.ts (getDashboard), field-for-field: the
  // grouped summary/nutrition_goals-array/today_timeline/insights/
  // action_items/meal_tracking/logged_meals shape, not the earlier flatter
  // approximation this method used before. Everything below is either a
  // direct port of that file's own algorithm, or (marked inline) a reduced
  // stand-in for a piece of the real system this checkout genuinely doesn't
  // have (the multi-factor health-score/recovery-mode engine, which needs
  // workout/sleep tracking this checkout never collects).
  async getNutritionSummaryByDate(userId: string, query: JsonRecord, req: { protocol: string; get(name: string): string | undefined }) {
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    if (!profile.onboarding_completed) {
      throw new AppError(ERROR_MESSAGE.NO_PLAN_GENERATED, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const date = typeof query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : todayInTz(tz);
    const dateObj = momentTZ.tz(date, "YYYY-MM-DD", "UTC").toDate();
    const current = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));

    const plan = await commonService.getFromTable(
      'user_nutrition_plans',
      { user_id: userId, is_active: true, is_deleted: false },
      { orderBy: { version: "desc" } },
    );
    if (!plan) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PLAN_NOT_FOUND, [], 404);
    }

    const dayStart = momentTZ.tz(date, "YYYY-MM-DD", tz).startOf("day").toDate();
    const dayEnd = momentTZ.tz(date, "YYYY-MM-DD", tz).endOf("day").toDate();
    const goalWindowDays = 7;
    const goalStartDate = shiftDateStr(date, -(goalWindowDays - 1));
    const goalWindowStart = momentTZ.tz(goalStartDate, "YYYY-MM-DD", tz).startOf("day").toDate();

    const [stats, meals, weekMeals, weekStats] = await Promise.all([
      commonService.findOneInTable('daily_stats', { user_id_date: { user_id: userId, date: dateObj } }),
      commonService.getManyFromTable(
        'meals',
        { user_id: userId, is_deleted: false, logged_at: { gte: dayStart, lte: dayEnd } },
        { orderBy: { logged_at: "asc" } },
      ),
      // 7-day window, fetched once and grouped in JS — backs both the
      // goal-progress insight and the hydration-streak insight below,
      // computed from real logged meals/water rather than trusting
      // daily_stats.calories_consumed (nothing in this checkout writes that
      // column — see the "consumed" fix in this same method, below).
      commonService.getManyFromTable('meals', { user_id: userId, is_deleted: false, logged_at: { gte: goalWindowStart, lte: dayEnd } }),
      commonService.getManyFromTable('daily_stats', { user_id: userId, is_deleted: false, date: { gte: goalWindowStart, lte: dateObj } }),
    ]);

    // The real system's `summary.calories_consumed` comes from
    // dailySummaryService's live recompute, not a stored column this
    // checkout ever writes — summing today's actual meals is the honest
    // equivalent (this also fixes a real bug: tsconfig's own writes never
    // touched daily_stats.calories_consumed, so it always read back 0 even
    // right after logging a meal).
    const sums = meals.reduce(
      (acc, m) => {
        acc.calories += Number(m.calories);
        acc.protein_g += Number(m.protein_g);
        acc.carbs_g += Number(m.carbs_g);
        acc.fat_g += Number(m.fat_g);
        acc.fibre_g += Number(m.fibre_g);
        return acc;
      },
      { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fibre_g: 0 },
    );
    const caloriesConsumed = Math.round(sums.calories);
    const waterConsumedMl = stats?.water_consumed_ml ?? 0;
    const waterTargetMl = plan.water_target_ml ?? 0;
    const calorieTarget = plan.calorie_target;

    // today_timeline: this checkout has no workout/sleep tracking, so it
    // can't compute the real system's 3-factor adherence score
    // (meal*0.5 + workout*0.3 + sleep*0.2). Reads daily_stats.health_score/
    // status_pill_state as-is (real columns, populated by whichever backend
    // last touched this row) rather than inventing a substitute formula —
    // defaults to 0/undefined (mapped to the generic "Keep Going" copy) if
    // nothing has ever written them for this user.
    const healthScore = Math.round(Number(stats?.health_score ?? 0));
    const statusPill = stats?.status_pill_state ?? undefined;
    const todayTimeline = {
      health_score_percentage: healthScore,
      status: timelineStatus(statusPill),
      title: timelineTitle(healthScore),
      message: statusMessage(statusPill),
    };

    // Goal-progress insight (last 7 days incl. today): a day counts as
    // "achieved" if that day's real logged meals met its plan's calorie
    // target — same rule, and same window, as GET /reports/goal-progress.
    const mealsByDay = new Map<string, number>();
    for (const m of weekMeals) {
      const key = momentTZ(m.logged_at).tz(tz).format("YYYY-MM-DD");
      mealsByDay.set(key, (mealsByDay.get(key) ?? 0) + Number(m.calories));
    }
    const statsByDay = new Map<string, any>(weekStats.map((r: any) => [momentTZ(r.date).format("YYYY-MM-DD"), r]));
    let goalDaysAchieved = 0;
    let hydrationDays = 0;
    let hydrationStreakBroken = false;
    for (let i = 0; i < goalWindowDays; i += 1) {
      const d = shiftDateStr(goalStartDate, i);
      const dayConsumed = Math.round(mealsByDay.get(d) ?? 0);
      if (calorieTarget > 0 && dayConsumed >= calorieTarget) goalDaysAchieved += 1;

      // Hydration streak counts backward from `date`; stops at the first day
      // (working backward) that didn't meet the water target.
      const fromEnd = goalWindowDays - 1 - i;
      const dRev = shiftDateStr(date, -fromEnd);
      const row = statsByDay.get(dRev);
      const dayWater = row?.water_consumed_ml ?? 0;
      if (!hydrationStreakBroken && waterTargetMl > 0 && dayWater >= waterTargetMl) {
        hydrationDays += 1;
      } else if (waterTargetMl > 0) {
        hydrationStreakBroken = true;
      }
    }

    const insights = [
      {
        type: "daily_momentum",
        title: "Daily Momentum",
        subtitle: "Progress",
        achieved: caloriesConsumed,
        target: Math.round(Number(calorieTarget)),
        unit: "kcal",
      },
      {
        type: "health_score",
        title: "Health Score",
        subtitle: "Nutrition & Streak",
        achieved: healthScore,
        target: 70,
        unit: "points",
      },
      {
        type: "hydration_streak",
        title: "Achievements",
        subtitle: "7 Day Hydration",
        achieved: hydrationDays,
        target: goalWindowDays,
        unit: "days",
        message: `${hydrationDays}/${goalWindowDays} days completed. A full week on target`,
      },
      {
        type: "goal_progress",
        title: "Track your goals",
        subtitle: "Progress",
        achieved: goalDaysAchieved,
        target: goalWindowDays,
        unit: "days",
        message: `${goalDaysAchieved}/${goalWindowDays} days on goal. A full week on goal progress`,
      },
    ];

    // action_items: only for the client's actual "today" (real system's
    // isClientToday check) — a past/future date never gets pending reminders.
    const actionItems: JsonRecord[] = [];
    if (date === todayInTz(tz)) {
      let plannedSlots: { meal_type: string; label: string }[];
      try {
        const parsed = JSON.parse(plan.meal_schedule_json) as { meal_type: string }[];
        plannedSlots = parsed.map((s) => ({ meal_type: s.meal_type.toLowerCase(), label: pascalMealType(s.meal_type.replace("_", " ")) }));
      } catch {
        plannedSlots = [];
      }
      const loggedTypes = new Set(meals.map((m) => m.meal_type.toLowerCase()));
      for (const slot of plannedSlots) {
        if (loggedTypes.has(slot.meal_type)) continue;
        actionItems.push({
          id: `log_${slot.meal_type}`,
          type: "meal",
          title: `Log ${slot.label}`,
          subtitle: `${slot.label} is not logged yet`,
          status: "pending",
          priority: slot.meal_type === "breakfast" || slot.meal_type === "lunch" ? "high" : "medium",
          action_type: "add_meal",
          meal_type: slot.meal_type,
        });
      }

      if (waterTargetMl > 0 && waterConsumedMl < waterTargetMl) {
        actionItems.push({
          id: "drink_water",
          type: "water",
          title: "Drink water",
          subtitle: `${mlToLitres(waterTargetMl - waterConsumedMl)} L remaining for today`,
          status: "pending",
          priority: "medium",
          action_type: "update_water",
        });
      }

      const weightReminderDays = 7;
      const lastWeightUpdate = profile.last_weight_update_date ? momentTZ(profile.last_weight_update_date).format("YYYY-MM-DD") : null;
      const daysSinceWeight = lastWeightUpdate ? momentTZ(date).diff(momentTZ(lastWeightUpdate), "days") : null;
      if (daysSinceWeight === null || daysSinceWeight >= weightReminderDays) {
        actionItems.push({
          id: "update_weight",
          type: "weight",
          title: "Update weight",
          subtitle: "Weekly weight update is due",
          status: "pending",
          priority: "medium",
          action_type: "update_weight",
          frequency: "weekly",
          interval_days: weightReminderDays,
          ...(lastWeightUpdate
            ? { last_updated_date: lastWeightUpdate, days_since_last_update: daysSinceWeight }
            : {}),
        });
      }
    }

    // Rotating status tip — real copy, persisted index (no fabrication, no AI).
    const tipIndex = nextStatusTipIndex(profile.last_status_message_index);
    await commonService.updateTable('user_nutrition_profiles', { id: userId }, { last_status_message_index: tipIndex });

    // meal_tracking: target fixed at 8/day (matches the real system's
    // client-spec constant, not the plan's 4 slots), progress based on how
    // close each applicable macro target is to being met (capped 100 each),
    // averaged — NOT meal count.
    const macroParts = [
      [caloriesConsumed, calorieTarget],
      [sums.protein_g, plan.protein_target_g],
      [sums.carbs_g, plan.carbs_target_g],
      [sums.fat_g, plan.fat_target_g],
    ].filter(([, target]) => Number(target) > 0);
    const nutritionGoalPct = macroParts.length
      ? Math.round((macroParts.reduce((acc, [c, t]) => acc + pct(c, t), 0) / macroParts.length) * 10) / 10
      : 0;

    const allLoggedMeals = meals.map((m) => ({
      meal_id: toPublicMealId(m.id),
      meal_type: pascalMealType(m.meal_type),
      time: to12Hour(m.logged_at, tz),
      meal_name: composeMealName(m.meal_name, m.meal_type),
      image_url: resolvedMealImageUrl(m.photo_url, req),
      meal_image_url: resolvedMealImageUrl(m.photo_url, req),
      thumbnail_url: resolvedMealImageUrl(m.photo_url, req),
      nutrition: {
        calories: Math.round(Number(m.calories)),
        protein: Number(m.protein_g),
        carbs: Number(m.carbs_g),
        fat: Number(m.fat_g),
      },
    }));
    const totalPages = Math.max(1, Math.ceil(allLoggedMeals.length / limit));
    const pagedMeals = allLoggedMeals.slice((current - 1) * limit, (current - 1) * limit + limit);

    return {
      summary: {
        date,
        status_message: STATUS_TIP_MESSAGES[tipIndex],
        completion_percentage: pct(caloriesConsumed, calorieTarget),
        calories: {
          target: Math.round(Number(calorieTarget)),
          consumed: caloriesConsumed,
          remaining: Math.max(0, Math.round(Number(calorieTarget) - caloriesConsumed)),
          unit: "kcal",
        },
      },
      nutrition_goals: [
        {
          type: "protein",
          label: "Protein",
          target: Math.round(Number(plan.protein_target_g)),
          consumed: Math.round(sums.protein_g),
          unit: "g",
          progress_percentage: pct(sums.protein_g, plan.protein_target_g),
        },
        {
          type: "fat",
          label: "Fat",
          target: Math.round(Number(plan.fat_target_g)),
          consumed: Math.round(sums.fat_g),
          unit: "g",
          progress_percentage: pct(sums.fat_g, plan.fat_target_g),
        },
        {
          type: "carbs",
          label: "Carbs",
          target: Math.round(Number(plan.carbs_target_g)),
          consumed: Math.round(sums.carbs_g),
          unit: "g",
          progress_percentage: pct(sums.carbs_g, plan.carbs_target_g),
        },
        {
          type: "water",
          label: "Water",
          target: mlToLitres(waterTargetMl),
          consumed: mlToLitres(waterConsumedMl),
          unit: "L",
          progress_percentage: pct(waterConsumedMl, waterTargetMl),
        },
      ],
      today_timeline: todayTimeline,
      insights,
      action_items: actionItems,
      meal_tracking: {
        target_meals: 8,
        consumed_meals: meals.length,
        progress_percentage: nutritionGoalPct,
      },
      logged_meals: pagedMeals,
      total_pages: totalPages,
      current_page: current,
    };
  }

  // ── Progress By Date — ported from foodDR's real nutritionClientV2ProgressService.ts
  // (getProgress). `include_benefits=true` triggers an AI per-meal benefits
  // call in the real system (cached per dish name) — not implemented here
  // (no AI wiring), but its own deterministic fallback (mealBenefitDescription,
  // used for any meal the AI doesn't cover) is real and always runs, so
  // `description` is never blank either way.
  async getProgressByDate(userId: string, query: JsonRecord, req: { protocol: string; get(name: string): string | undefined }) {
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const date = typeof query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : todayInTz(tz);
    const dateObj = momentTZ.tz(date, "YYYY-MM-DD", "UTC").toDate();
    const current = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));

    const [plan, stats, meals] = await Promise.all([
      commonService.getFromTable('user_nutrition_plans', { user_id: userId, is_active: true, is_deleted: false }, { orderBy: { version: "desc" } }),
      commonService.findOneInTable('daily_stats', { user_id_date: { user_id: userId, date: dateObj } }),
      commonService.getManyFromTable(
        'meals',
        {
          user_id: userId,
          is_deleted: false,
          logged_at: {
            gte: momentTZ.tz(date, "YYYY-MM-DD", tz).startOf("day").toDate(),
            lte: momentTZ.tz(date, "YYYY-MM-DD", tz).endOf("day").toDate(),
          },
        },
        { orderBy: { logged_at: "asc" } },
      ),
    ]);

    // Same "sum today's real meals" fix as the dashboard — daily_stats.calories_consumed
    // is never written by anything in this checkout.
    const consumedCalories = meals.reduce((sum, m) => sum + Number(m.calories), 0);
    const targetCalories = plan?.calorie_target ?? 0;

    const totalPages = Math.max(1, Math.ceil(meals.length / limit));
    const pagedMeals = meals.slice((current - 1) * limit, (current - 1) * limit + limit);

    return {
      goal: {
        achieved_kcal: Math.round(consumedCalories),
        target_kcal: Math.round(Number(targetCalories)),
        percentage: pct(consumedCalories, targetCalories),
        unit: "kcal",
        score_value: Math.round(Number(stats?.health_score ?? 0)),
        calories_value: Math.round(consumedCalories),
      },
      meals: pagedMeals.map((m) => {
        const nutrition = {
          calories: Math.round(Number(m.calories)),
          protein: Number(m.protein_g),
          carbs: Number(m.carbs_g),
          fat: Number(m.fat_g),
          fibre: Number(m.fibre_g ?? 0),
        };
        return {
          meal_id: toPublicMealId(m.id),
          meal_type: pascalMealType(m.meal_type),
          logged_at: m.logged_at.toISOString(),
          time: to12Hour(m.logged_at, tz),
          meal_name: composeMealName(m.meal_name, m.meal_type),
          description: mealBenefitDescription(nutrition),
          thumbnail_url: resolvedMealImageUrl(m.photo_url, req),
          nutrition,
        };
      }),
      total_logged_count: meals.length,
      total_pages: totalPages,
      current_page: current,
    };
  }

  // ── Nutrition Health Score — ported from foodDR's real
  // nutritionClientV2HealthScoreService.ts. daily_stats already carries
  // precomputed health_score/score_breakdown_json/adherence_score columns
  // (the real backend-node's scoring service writes them) — this reads
  // them rather than recomputing an independent scoring algorithm, which
  // would be guessing at business rules this checkout doesn't own; nothing
  // in this checkout writes adherence_score, so that series/percentage
  // reads 0 for data this checkout produced on its own.
  async getHealthScore(userId: string, query: JsonRecord) {
    const range = [7, 30, 90].includes(Number(query.range)) ? Number(query.range) : 7;
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const today = todayInTz(tz);
    // Chart ends yesterday, matching the real system exactly.
    const chartEndDate = shiftDateStr(today, -1);
    const chartStartDate = shiftDateStr(chartEndDate, -(range - 1));
    const startObj = momentTZ.tz(chartStartDate, "YYYY-MM-DD", "UTC").toDate();
    const endObj = momentTZ.tz(chartEndDate, "YYYY-MM-DD", "UTC").toDate();

    const rows = await commonService.getManyFromTable(
      'daily_stats',
      { user_id: userId, is_deleted: false, date: { gte: startObj, lte: endObj } },
      { orderBy: { date: "asc" } },
    );
    const rowByDate = new Map<string, any>(rows.map((r: any) => [momentTZ(r.date).format("YYYY-MM-DD"), r]));

    // 7 daily points for range=7; otherwise bucketed into 7 averaged groups
    // spanning the range (same rule as the real chart).
    type Bucket = { dates: string[]; day: string };
    let buckets: Bucket[];
    if (range === 7) {
      buckets = Array.from({ length: 7 }, (_u, i) => {
        const d = shiftDateStr(chartStartDate, i);
        return { dates: [d], day: momentTZ(d).format("ddd") };
      });
    } else {
      const base = Math.floor(range / 7);
      const remainder = range % 7;
      buckets = [];
      let offset = 0;
      for (let i = 0; i < 7; i += 1) {
        const length = base + (i < remainder ? 1 : 0);
        const bucketStart = shiftDateStr(chartStartDate, offset);
        const dates = Array.from({ length }, (_u, j) => shiftDateStr(bucketStart, j));
        const bucketEnd = dates[dates.length - 1] ?? bucketStart;
        const label =
          momentTZ(bucketStart).format("MMM") === momentTZ(bucketEnd).format("MMM")
            ? `${momentTZ(bucketStart).format("MMM D")}-${momentTZ(bucketEnd).format("D")}`
            : `${momentTZ(bucketStart).format("MMM D")}-${momentTZ(bucketEnd).format("MMM D")}`;
        buckets.push({ dates, day: label });
        offset += length;
      }
    }

    const seriesDefs = [
      { key: "weight", label: "Weight", color: "#2ECC71", field: "weight_kg" as const, scale: 1 },
      { key: "adherence", label: "Adherence", color: "#3B82F6", field: "adherence_score" as const, scale: 100 },
      { key: "score", label: "Score", color: "#F2941F", field: "health_score" as const, scale: 1 },
    ];
    const valueFor = (dateStr: string, field: "weight_kg" | "adherence_score" | "health_score", scale: number): number => {
      const row = rowByDate.get(dateStr);
      const v = row ? row[field] : null;
      return Math.round(Number(v ?? 0) * scale);
    };
    const series = seriesDefs.map((def) => ({
      key: def.key,
      label: def.label,
      color: def.color,
      data: buckets.map((b) => ({
        day: b.day,
        value: Math.round(b.dates.reduce((sum, d) => sum + valueFor(d, def.field, def.scale), 0) / b.dates.length),
      })),
    }));

    const latest = rows.length ? rows[rows.length - 1] : null;
    let breakdown = { nutrition: 0, consistency: 0 };
    if (latest?.score_breakdown_json) {
      try {
        const b = JSON.parse(latest.score_breakdown_json) as JsonRecord;
        breakdown = { nutrition: Number(b.nutrition ?? 0), consistency: Number(b.consistency ?? 0) };
      } catch {
        /* keep zeros */
      }
    }
    const latestScore = Math.round(Number(latest?.health_score ?? 0));
    const latestAdherence = Math.round(Number(latest?.adherence_score ?? 0) * 100);

    const weights = rows.filter((r) => r.weight_kg != null).map((r) => Number(r.weight_kg));
    const goalWeight = Number(profile.goal_weight_kg ?? 0);
    let weightPct = 0;
    if (weights.length >= 1 && goalWeight > 0) {
      const startW = weights[0]!;
      const curW = weights[weights.length - 1]!;
      const denom = startW - goalWeight;
      if (denom !== 0) weightPct = Math.max(0, Math.min(100, Math.round(((startW - curW) / denom) * 100)));
    }

    const healthScoreDescription =
      latestScore >= 75
        ? "You are on track. Your nutrition and consistency are both strong — keep it up."
        : latestScore >= 45
          ? "You are slightly off. Small improvements to your meals or daily consistency will lift your score."
          : "Time to recover. Focus on logging meals and staying consistent to rebuild your score.";

    return {
      score_breakdown: {
        nutrition: {
          value: breakdown.nutrition,
          max: 75,
          description: "Based on how closely your meals match your calorie and macro targets, plus the meals you logged.",
        },
        streak: {
          value: breakdown.consistency,
          max: 25,
          description: "Based on your current streak and how many of the last 7 days you stayed active.",
        },
      },
      health_score: { value: latestScore, label: "Health Score", description: healthScoreDescription },
      chart: { y_axis: { min: 0, max: 100, step: 20 }, series },
      summary_stats: {
        score_percentage: latestScore,
        weight_percentage: weightPct,
        adherence_percentage: latestAdherence,
      },
    };
  }

  // ── Nutrition Achievements — ported from foodDR's real
  // nutritionClientV2AchievementsService.ts. Full badge/level/category
  // structure using the real catalog constants above; `unlocked` comes from
  // whatever's actually in the `achievements` table (always empty for a
  // tsconfig-only user — see the catalog's doc comment).
  async getAchievements(userId: string) {
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const today = todayInTz(tz);
    const since = shiftDateStr(today, -29);

    const [unlocked, recentStats] = await Promise.all([
      commonService.getManyFromTable('achievements', { user_id: userId, is_deleted: false }),
      commonService.getManyFromTable('daily_stats', { user_id: userId, is_deleted: false, date: { gte: momentTZ.tz(since, "YYYY-MM-DD", "UTC").toDate() } }),
    ]);
    const statByDate = new Map<string, any>(recentStats.map((r: any) => [momentTZ(r.date).format("YYYY-MM-DD"), r]));
    const currentStreak = statByDate.get(today)?.streak_day ?? 0;

    const numericStat = (dateStr: string, field: "meal_count" | "calories_consumed" | "goal_calories" | "water_consumed_ml") => {
      const v = statByDate.get(dateStr)?.[field];
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    const waterTargetForDate = (dateStr: string): number => {
      const target = Math.round(Number(profile.current_weight_kg ?? 70) * WATER_LITRES_PER_KG * 1000);
      return target > 0 ? target : 2000;
    };
    const isWaterMet = (dateStr: string) => numericStat(dateStr, "water_consumed_ml") >= waterTargetForDate(dateStr);
    const isPerfectDay = (dateStr: string) => {
      if (!statByDate.has(dateStr)) return false;
      const mealCount = numericStat(dateStr, "meal_count");
      const consumed = numericStat(dateStr, "calories_consumed");
      const target = numericStat(dateStr, "goal_calories");
      return mealCount >= 2 && target > 0 && Math.abs(consumed - target) <= 100 && isWaterMet(dateStr);
    };
    const consecutiveDays = (predicate: (d: string) => boolean, maxLookback = 30): number => {
      let count = 0;
      for (let i = 0; i < maxLookback; i += 1) {
        if (!predicate(shiftDateStr(today, -i))) break;
        count += 1;
      }
      return count;
    };
    const progressByType: Record<string, number> = {
      ...Object.fromEntries(Object.keys(STREAK_TYPES).map((t) => [t, Math.max(0, Math.trunc(currentStreak))])),
      ...Object.fromEntries(Object.keys(MEAL_STREAK_TYPES).map((t) => [t, consecutiveDays((d) => numericStat(d, "meal_count") >= 2)])),
      ...Object.fromEntries(Object.keys(WATER_STREAK_TYPES).map((t) => [t, consecutiveDays(isWaterMet)])),
      [PERFECT_WEEK]: consecutiveDays(isPerfectDay),
    };
    const projectedDate = (type: string): string | null => {
      const target = STREAK_TYPES[type] ?? MEAL_STREAK_TYPES[type] ?? WATER_STREAK_TYPES[type] ?? (type === PERFECT_WEEK ? 7 : null);
      if (!target) return today;
      const current = Math.max(0, Math.trunc(progressByType[type] ?? 0));
      return shiftDateStr(today, Math.max(0, target - current));
    };

    const unlockedByType = new Map<string, any>(unlocked.map((a: any) => [a.achievement_type, a]));
    const allTypes = Object.keys(ACHIEVEMENT_LABELS);
    const badgeFor = (type: string): JsonRecord => {
      const tier = ACHIEVEMENT_TIERS[type] ?? "bronze";
      const label = ACHIEVEMENT_LABELS[type] ?? { title: type, subtitle: "" };
      const u = unlockedByType.get(type);
      const achievementDate = u ? momentTZ(u.unlocked_at).format("YYYY-MM-DD") : projectedDate(type);
      return {
        id: type,
        title: label.title,
        tier: tier.charAt(0).toUpperCase() + tier.slice(1),
        points: TIER_POINTS[tier] ?? 0,
        points_unit: "pts",
        description: label.subtitle,
        is_unlocked: Boolean(u),
        unlocked_date: achievementDate,
        estimated_unlock_date: achievementDate,
        icon_bg_color: BADGE_BG_COLORS[tier] ?? "#F59E0A1C",
      };
    };

    const totalPoints = unlocked.reduce((sum, a) => sum + (TIER_POINTS[ACHIEVEMENT_TIERS[a.achievement_type] ?? "bronze"] ?? 0), 0);
    const currentLevel = Math.floor(totalPoints / POINTS_PER_LEVEL) + 1;
    const tierBreakdown = TIER_ORDER.map((tier) => ({
      tier: tier.charAt(0).toUpperCase() + tier.slice(1),
      count: unlocked.filter((a) => (ACHIEVEMENT_TIERS[a.achievement_type] ?? "bronze") === tier).length,
      color: TIER_COLORS[tier],
    }));

    const categoryKeys = [...new Set(allTypes.map((t) => ACHIEVEMENT_CATEGORIES[t] ?? "streak"))];
    const categories = categoryKeys.map((cat) => {
      const types = allTypes.filter((t) => (ACHIEVEMENT_CATEGORIES[t] ?? "streak") === cat);
      return {
        id: `cat_${cat}`,
        label: ACHIEVEMENT_CATEGORY_LABELS[cat] ?? cat,
        unlocked: types.filter((t) => unlockedByType.has(t)).length,
        total: types.length,
        badges: types.map(badgeFor),
      };
    });

    const streakTypes = Object.keys(STREAK_TYPES).sort((a, b) => STREAK_TYPES[a]! - STREAK_TYPES[b]!);
    const nextStreakType = streakTypes.find((t) => !unlockedByType.has(t));
    let nextBanner: JsonRecord | null = null;
    let nextCard: JsonRecord | null = null;
    if (nextStreakType) {
      const req = STREAK_TYPES[nextStreakType]!;
      const label = ACHIEVEMENT_LABELS[nextStreakType]!;
      const tier = ACHIEVEMENT_TIERS[nextStreakType] ?? "bronze";
      nextBanner = {
        milestone_name: label.title,
        percentage: req > 0 ? Math.min(100, Math.round((currentStreak / req) * 100)) : 0,
        days_completed: currentStreak,
        days_required: req,
        days_remaining: Math.max(0, req - currentStreak),
        unlocked_date: projectedDate(nextStreakType),
        estimated_unlock_date: projectedDate(nextStreakType),
      };
      nextCard = {
        title: label.title,
        tier_tag: tier.charAt(0).toUpperCase() + tier.slice(1),
        description: label.subtitle,
      };
    }

    return {
      summary: {
        unlocked_count: unlocked.length,
        subtitle: unlocked.length > 0 ? "Keep Going" : "Start your streak",
      },
      level: {
        current_level: currentLevel,
        next_level: currentLevel + 1,
        points: totalPoints,
        points_unit: "pts",
        badges_unlocked: unlocked.length,
        badges_total: allTypes.length,
        percentage: allTypes.length ? Math.round((unlocked.length / allTypes.length) * 100) : 0,
        points_to_next_level: POINTS_PER_LEVEL - (totalPoints % POINTS_PER_LEVEL),
        points_required_for_next_level: POINTS_PER_LEVEL,
        tier_breakdown: tierBreakdown,
      },
      next_milestone_banner: nextBanner,
      categories,
      next_milestone_card: nextCard,
    };
  }

  // ── Upcoming Routine (V2) ────────────────────────────────────────────────
  // Real, deterministic port of backend-node's getUpcomingRoutine default
  // (days=7) path — confirmed by reading nutritionClientV2RoutineService.ts
  // + plan/planService.ts that this path is NOT AI-driven: dish names come
  // from a curated, fixed catalog (routineCatalog.ts, ported verbatim),
  // day-of-week indexed with no repeats across 7 days; per-item macros are a
  // fixed 24% protein / 25% fat / remainder-carbs split of that slot's
  // target calories (prod's own formula, not a real per-dish lookup);
  // ai_insights are deterministic goal-aware copy (prod's own
  // "degrades-to-deterministic" comment — no live AI call there either).
  // Only a `days` value other than 7 triggers a real Gemini call in prod
  // (with this exact catalog as its own fallback on timeout/failure) — this
  // checkout has no AI wiring, so every `days` value uses this catalog here,
  // which is exactly what prod itself falls back to when AI is unavailable.
  async getUpcomingRoutine(userId: string, query: JsonRecord) {
    const days = Math.min(30, Math.max(1, Number(query.days) || 7));
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const plan = await commonService.getFromTable(
      'user_nutrition_plans',
      { user_id: userId, is_active: true, is_deleted: false },
      { orderBy: { version: "desc" } },
    );
    if (!plan) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PLAN_NOT_FOUND, [], 404);
    }

    const tz = profile.timezone || "Asia/Kolkata";
    const today = todayInTz(tz);
    const calorieTarget = Math.round(Number(plan.calorie_target)) || 2000;
    const dietKey = routineDietKey(profile.dietary_preference);
    const cuisineKeys = routineCuisineKeys(profile.cuisine_preferences);
    const slots = routineTargetMealSlots(calorieTarget);

    const upcoming_plan = Array.from({ length: days }, (_unused, i) => {
      // Upcoming = starting tomorrow, matching prod's shiftDate(today, i + 1).
      const date = shiftDateStr(today, i + 1);
      const dayIndex = i % 7; // prod's own no-AI fallback also wraps mod 7 here
      const meals = slots.map((slot) => {
        const built = buildRoutineMealSlot(slot, dietKey, cuisineKeys, dayIndex);
        return {
          id: `meal_${built.meal_type}`,
          meal_type: routineTitleCase(built.label),
          title: routineTitleCase(built.suggested_food),
          time: routineTo12Hour(built.time),
          description: mealBenefitDescription({
            protein: built.total_protein_g,
            carbs: built.total_carbs_g,
            fat: built.total_fat_g,
            fibre: built.total_fibre_g,
          }),
          calories: built.total_calories,
          protein_g: built.total_protein_g,
          carbs_g: built.total_carbs_g,
          fat_g: built.total_fat_g,
          items: built.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            calories: item.calories,
            protein_g: item.protein_g,
            carbs_g: item.carbs_g,
            fat_g: item.fat_g,
          })),
        };
      });
      return {
        id: `plan_${date}`,
        date,
        total_calories: calorieTarget,
        unit: "kcal",
        meals,
        macros: {
          protein_g: Math.round(Number(plan.protein_target_g)),
          protein_unit: "g",
          carbs_g: Math.round(Number(plan.carbs_target_g)),
          carbs_unit: "g",
          fat_g: Math.round(Number(plan.fat_target_g)),
          fat_unit: "g",
          water_l: mlToLitres(plan.water_target_ml),
          water_unit: "L",
        },
      };
    });

    return {
      ai_insights: buildRoutineAiInsights(profile.goal_type),
      upcoming_plan,
      total_days: days,
    };
  }

  // ── Goal Progress report — ported from foodDR's real
  // nutritionClientV2ReportsService.ts (getGoalProgress). Per-day
  // completed/in_progress/not_completed outcome for the window, computed
  // from real logged meals (not the stale daily_stats.calories_consumed
  // column) against each day's calorie goal.
  async getGoalProgress(userId: string, query: JsonRecord) {
    const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 7;
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const today = todayInTz(tz);
    const startDate = shiftDateStr(today, -(days - 1));
    const startObj = momentTZ.tz(startDate, "YYYY-MM-DD", "UTC").toDate();
    const endObj = momentTZ.tz(today, "YYYY-MM-DD", "UTC").toDate();

    const [plan, rows, meals] = await Promise.all([
      commonService.getFromTable('user_nutrition_plans', { user_id: userId, is_active: true, is_deleted: false }, { orderBy: { version: "desc" } }),
      commonService.getManyFromTable('daily_stats', { user_id: userId, is_deleted: false, date: { gte: startObj, lte: endObj } }),
      commonService.getManyFromTable('meals', {
        user_id: userId,
        is_deleted: false,
        logged_at: { gte: momentTZ.tz(startDate, "YYYY-MM-DD", tz).startOf("day").toDate(), lte: momentTZ.tz(today, "YYYY-MM-DD", tz).endOf("day").toDate() },
      }),
    ]);
    const rowByDate = new Map<string, any>(rows.map((r: any) => [momentTZ(r.date).format("YYYY-MM-DD"), r]));
    const mealsByDay = new Map<string, number>();
    for (const m of meals) {
      const key = momentTZ(m.logged_at).tz(tz).format("YYYY-MM-DD");
      mealsByDay.set(key, (mealsByDay.get(key) ?? 0) + Number(m.calories));
    }

    let currentGoal = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const g = Math.round(Number(rows[i]?.goal_calories ?? 0));
      if (g > 0) {
        currentGoal = g;
        break;
      }
    }
    if (!currentGoal) currentGoal = Math.round(Number(plan?.calorie_target ?? 0)) || 0;

    const progress: JsonRecord[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = shiftDateStr(startDate, i);
      const row = rowByDate.get(date);
      const goal = Math.round(Number(row?.goal_calories ?? 0)) || currentGoal;
      const consumed = Math.round(mealsByDay.get(date) ?? 0);
      let status = "not_completed";
      if (goal > 0 && consumed >= goal) status = "completed";
      else if (consumed > 0) status = "in_progress";
      progress.push({ date, day: momentTZ(date).format("dddd"), goal_calories: goal, status });
    }

    return { selected_days: days, goal_calories: currentGoal, progress };
  }

  // ── Meals by type — response shape ported from foodDR's real
  // nutritionClientV2RecommendationsService.ts (formatV2Recommendation).
  // The real endpoint is AI-driven (fresh, diet/cuisine-aware suggestions,
  // anti-repeat) with a documented deterministic fallback when AI is
  // off — this checkout has no AI wiring at all, so it always takes that
  // fallback shape, sourced from the real food_catalog table instead of
  // the real system's plan-schedule fallback (no plan-schedule variety to
  // draw from here) — same field names/nesting either way, `source:
  // "catalog"` instead of `"ai"`/`"fallback"` to be honest about where the
  // suggestion actually came from.
  async getMealsByType(query: JsonRecord) {
    const mealType = typeof query.meal_type === "string" ? query.meal_type.toLowerCase() : undefined;
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
    const page = Math.max(1, Number(query.page) || 1);
    const where = { is_deleted: false, ...(mealType && mealType !== "all" ? { meal_type: mealType } : {}) };

    const [rows, total] = await Promise.all([
      commonService.getManyFromTable('food_catalog', where, { skip: (page - 1) * limit, take: limit, orderBy: { name: "asc" } }),
      commonService.countInTable('food_catalog', where),
    ]);

    return {
      recommended_meals: rows.map((r) => this.formatCatalogRecommendation(r)),
      total_pages: Math.max(1, Math.ceil(total / limit)),
      current_page: page,
    };
  }

  // ── Meal search / autocomplete (Quick Add Meal) ─────────────────────────
  // Plain substring search runs first, unchanged — existing behavior for
  // exact/prefix queries is never affected. Only when that finds nothing
  // does a real Gemini call (foodSearchService.ts, ported from
  // FoodDr/backend-node's interpretFoodSearchQuery) turn the natural-
  // language / partial / misspelled query into catalog-searchable
  // keywords, which are re-searched and merged — same fallback structure
  // as the real system's FoodCatalogService.search().
  async searchMeals(query: JsonRecord) {
    const term = typeof query.query === "string" ? query.query.trim() : "";
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
    if (!term) return [];

    const direct = await this.searchCatalogByTerm(term, limit);
    if (direct.length > 0) return direct.map((r) => this.formatCatalogRecommendation(r));

    const keywords = await interpretFoodSearchQuery(term).catch(() => null);
    if (!keywords || keywords.length === 0) return [];

    const resultsByKeyword = await Promise.all(
      keywords.map((keyword) => this.searchCatalogByTerm(keyword, limit).catch(() => [])),
    );
    const seen = new Set<string>();
    const merged: typeof direct = [];
    for (const row of resultsByKeyword.flat()) {
      const key = row.display_name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length >= limit) break;
    }
    return merged.map((r) => this.formatCatalogRecommendation(r));
  }

  private async searchCatalogByTerm(term: string, limit: number) {
    return commonService.getManyFromTable(
      'food_catalog',
      {
        is_deleted: false,
        OR: [{ name: { contains: term } }, { display_name: { contains: term } }],
      },
      { take: limit, orderBy: { name: "asc" } },
    );
  }

  private formatCatalogRecommendation(r: { display_name: string; meal_type: string | null; calories: number; protein_g: number; carbs_g: number; fat_g: number; fibre_g: number }) {
    const nutrition = {
      calories: Math.round(r.calories),
      carbs: Math.round(r.carbs_g),
      protein: Math.round(r.protein_g),
      fat: Math.round(r.fat_g),
      fibre: Math.round(r.fibre_g),
    };
    const dominant_nutrient = computeDominantNutrient(nutrition);
    // Deterministic macro-based health rating — the real system's own
    // fallback (rateHealthFromMacros) for when AI gives no rating; the
    // AI-rating / "unhealthy ingredient text" branches aren't reachable
    // without AI, so only this deterministic path applies here.
    const fatPct = nutrition.calories > 0 ? (nutrition.fat * 9) / nutrition.calories : 0;
    const rating = nutrition.calories <= 0 ? "yellow" : fatPct >= 0.45 ? "red" : (nutrition.fibre >= 3 || nutrition.protein >= 12) && fatPct <= 0.35 ? "green" : "yellow";
    const meal_recommendation =
      rating === "green"
        ? { status: "green", title: "Recommended", message: "This is a nutritious choice that fits well with your nutrition goals." }
        : rating === "red"
          ? { status: "red", title: "Choose Carefully", message: "This is high in calories or fat — best kept as an occasional treat." }
          : { status: "yellow", title: "Okay in Moderation", message: "This is fine occasionally — keep an eye on the portion size." };
    return {
      meal_type: pascalMealType(r.meal_type ?? "meal"),
      meal_name: r.display_name,
      time: null,
      description: [r.display_name],
      nutrition,
      dominant_nutrient,
      meal_recommendation,
      source: "catalog",
    };
  }

  // ── Logged meals by date (V1) — ported from foodDR's real
  // nutritionClientV1MealIntakeService.ts (loggedMealsByDate). Genuinely
  // different shape from what this method returned before: pagination is
  // over DISTINCT DATES that have logged meals (not individual meal rows),
  // each date grouping its own meals array with a friendly "Today"/
  // "Yesterday" label.
  async loggedMealsByDate(userId: string, query: JsonRecord, req: { protocol: string; get(name: string): string | undefined }) {
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
    const current = Math.max(1, Number(query.page) || 1);

    const allMeals = await commonService.getManyFromTable(
      'meals',
      { user_id: userId, is_deleted: false },
      { orderBy: { logged_at: "desc" } },
    );
    const datesWithMeals = [...new Set<string>(allMeals.map((m: any) => momentTZ(m.logged_at).tz(tz).format("YYYY-MM-DD")))];
    if (datesWithMeals.length === 0) {
      throw new AppError(ERROR_MESSAGE.NO_LOGGED_MEALS_FOUND, [], 404);
    }
    const totalPages = Math.max(1, Math.ceil(datesWithMeals.length / limit));
    const pagedDates = datesWithMeals.slice((current - 1) * limit, (current - 1) * limit + limit);

    const mealsByDate = new Map<string, typeof allMeals>();
    for (const m of allMeals) {
      const key = momentTZ(m.logged_at).tz(tz).format("YYYY-MM-DD");
      if (!mealsByDate.has(key)) mealsByDate.set(key, []);
      mealsByDate.get(key)!.push(m);
    }
    const today = todayInTz(tz);
    const yesterday = shiftDateStr(today, -1);

    return {
      logged_meals: pagedDates.map((date) => {
        const dayMeals = mealsByDate.get(date) ?? [];
        return {
          date,
          label: date === today ? "Today" : date === yesterday ? "Yesterday" : date,
          meals_logged_count: dayMeals.length,
          meals: dayMeals.map((m) => ({
            meal_id: toPublicMealId(m.id),
            meal_type: m.meal_type,
            logged_at: m.logged_at.toISOString(),
            meal_name: composeMealName(m.meal_name, m.meal_type),
            thumbnail_url: resolvedMealImageUrl(m.photo_url, req),
            nutrition: {
              calories: Math.round(Number(m.calories)),
              protein: Number(m.protein_g),
              carbs: Number(m.carbs_g),
              fat: Number(m.fat_g),
              fibre: Number(m.fibre_g ?? 0),
            },
          })),
        };
      }),
      total_pages: totalPages,
      current_page: current,
    };
  }

  // ── Delete meal — ported from foodDR's real nutritionClientV1MealIntakeService.ts.
  // Identifies the meal by its PUBLIC (hashed) id, matching the real
  // contract — not the raw internal UUID this method previously took.
  async deleteMeal(userId: string, publicMealId: number) {
    const meals = await commonService.getManyFromTable('meals', { user_id: userId, is_deleted: false });
    const meal = meals.find((m: any) => toPublicMealId(m.id) === publicMealId);
    if (!meal) {
      throw new AppError(ERROR_MESSAGE.MEAL_NOT_FOUND, [], 404);
    }
    await commonService.updateTable('meals', { id: meal.id }, { is_deleted: true });
    return { meal_id: publicMealId, deleted: true };
  }

  // ── Add meal (manual entry — no AI photo classification) ────────────────
  // A real write against the `meals` table for a directly-supplied
  // type/macro entry. Prod's equivalent also accepts a photo and runs it
  // through Gemini for classification; that path isn't wired into this
  // checkout (no vision-model integration here), so this only supports the
  // manual/macros-supplied case rather than faking a recognition result.
  //
  // Dispatches on `body.type`, matching foodDR's real contract (type 1 =
  // manual entry, type 2 = image upload, type 3 = catalog entry — see
  // meal-intake-v2.ts). type 1 is the default when `type` is omitted, for
  // backward compatibility with callers that never sent it.
  async addMeal(userId: string, orgId: number | null, body: JsonRecord, req: { protocol: string; get(name: string): string | undefined; file?: { buffer: Buffer } }) {
    const type = body.type === undefined ? 1 : Number(body.type);
    if (type === 3) {
      return this.addMealFromCatalog(userId, orgId, body, req);
    }
    if (type !== 1) {
      // type 2 (image upload) is handled by the controller as an honest 501
      // stub before this method is ever called — reaching here with any
      // other value is a genuine bad request.
      throw new AppError(ERROR_MESSAGE.ADD_MEAL_TYPE_INVALID, [], 400);
    }
    return this.addMealManual(userId, orgId, body, req);
  }

  private async addMealManual(userId: string, orgId: number | null, body: JsonRecord, req: { protocol: string; get(name: string): string | undefined; file?: { buffer: Buffer } }) {
    const mealType = typeof body.meal_type === "string" ? body.meal_type.toUpperCase() : undefined;
    const calories = Number(body.calories);
    if (!mealType || !Number.isFinite(calories) || calories <= 0) {
      throw new AppError(ERROR_MESSAGE.MEAL_TYPE_AND_CALORIES_REQUIRED, [], 400);
    }
    // Optional attached photo — stored and used as the meal's real image;
    // never sent through AI recognition (that's type 2's job). Falls back to
    // the demo placeholder in buildSavedMealResponse when no photo is sent.
    const photoUrl = req.file?.buffer ? await storeUploadedImage(req.file.buffer, req) : null;
    const now = new Date();
    const meal = await commonService.insertIntoTable('meals', {
      id: randomUUID(),
      user_id: userId,
      org_id: orgId,
      meal_type: mealType,
      logged_at: now,
      logged_date: now,
      calories,
      protein_g: Number(body.protein_g) || 0,
      carbs_g: Number(body.carbs_g) || 0,
      fat_g: Number(body.fat_g) || 0,
      fibre_g: Number(body.fibre_g) || 0,
      photo_url: photoUrl,
      meal_name: typeof body.meal_name === "string" ? body.meal_name : null,
      source: "manual",
      is_verified: true,
    });
    const ingredients = Array.isArray(body.ingredients)
      ? body.ingredients.map((i) => String(i)).filter(Boolean)
      : undefined;
    return buildSavedMealResponse(meal, req, {
      serving_size: Number(body.serving_size) || 1,
      serving_unit: typeof body.serving_unit === "string" && body.serving_unit.trim() ? body.serving_unit.trim() : "serving",
      ingredients,
      imageUrl: photoUrl ?? undefined,
    });
  }

  // ── Add Meal type 3 — catalog entry ──────────────────────────────────────
  // Real, ported from foodDR's FoodCatalogService.resolveMealNutrition:
  // nutrition is resolved from the local `food_catalog` table (never trusted
  // from the request body), scaled from its per-100g/100ml/piece basis by
  // quantity+unit. A catalog miss is an honest 404 rather than the real
  // service's AI-enrichment fallback (no AI wiring in this checkout).
  private async addMealFromCatalog(userId: string, orgId: number | null, body: JsonRecord, req: { protocol: string; get(name: string): string | undefined; file?: { buffer: Buffer } }) {
    const mealType = typeof body.meal_type === "string" ? body.meal_type.toLowerCase() : "";
    if (!["breakfast", "lunch", "snack", "dinner", "drinks"].includes(mealType)) {
      throw new AppError(ERROR_MESSAGE.MEAL_TYPE_INVALID_CATALOG, [], 400);
    }
    const name = typeof body.meal_name === "string" ? body.meal_name.trim() : "";
    if (!name) {
      throw new AppError(ERROR_MESSAGE.MEAL_NAME_REQUIRED, [], 400);
    }

    const unit = normalizeServingUnit(body.serving_unit);
    if (!unit) {
      throw new AppError(ERROR_MESSAGE.SERVING_UNIT_UNSUPPORTED, [], 400);
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new AppError(ERROR_MESSAGE.QUANTITY_MUST_BE_POSITIVE, [], 400);
    }
    const maxQty = maxQuantityFor(unit);
    if (maxQty != null && quantity > maxQty) {
      throw new AppError(`Quantity is too large. Enter at most ${maxQty} ${unit}.`, [], 400);
    }

    const requiredBasis = basisForCategory(unitCategoryFor(unit));
    const food = await findCatalogFoodByName(name);
    if (!food) {
      throw new AppError(`Could not find "${name}" in the food catalog.`, [], 404);
    }
    if (food.basis !== requiredBasis) {
      throw new AppError(`${food.display_name} is measured in ${food.serving_unit}, not ${unit}. Please use ${food.serving_unit}.`, [], 400);
    }

    const mult = basisMultiplier(quantity, unit)!;
    const calories = Math.round(food.calories * mult);
    const protein_g = round1(food.protein_g * mult);
    const carbs_g = round1(food.carbs_g * mult);
    const fat_g = round1(food.fat_g * mult);
    const fibre_g = round1(food.fibre_g * mult);

    // Optional attached photo — stored and used as the meal's real image;
    // nutrition is already fully resolved from the catalog, so (unlike type
    // 2) the photo is never sent through AI recognition — same rule as the
    // real system's own type-3 handler.
    const photoUrl = req.file?.buffer ? await storeUploadedImage(req.file.buffer, req) : null;

    const now = new Date();
    const meal = await commonService.insertIntoTable('meals', {
      id: randomUUID(),
      user_id: userId,
      org_id: orgId,
      meal_type: mealType.toUpperCase(),
      logged_at: now,
      logged_date: now,
      calories,
      protein_g,
      carbs_g,
      fat_g,
      fibre_g,
      meal_name: food.display_name,
      photo_url: photoUrl,
      // The real backend-node saveMeal() also uses 'manual' as the source
      // for catalog entries (see meal-intake-v2.ts type 3), not a separate
      // 'catalog' value — the meals table's CHECK constraint only allows
      // ('scanner', 'manual') anyway, confirmed against the live DB.
      source: "manual",
      is_verified: true,
    });
    return buildSavedMealResponse(meal, req, {
      serving_size: quantity,
      serving_unit: unit,
      ingredients: [food.display_name],
      imageUrl: photoUrl ?? undefined,
    });
  }

  // ── Add Meal type 2 — image upload ───────────────────────────────────────
  // Real Gemini vision recognition (mealRecognitionService.ts), genuinely
  // wired to GEMINI_API_KEY — ported from foodDR's meal-intake-v2.ts
  // (addMealV2Handler's type===2 branch). No isMealEligible preview mode
  // here (this checkout doesn't implement that branch for type 1/3 either,
  // for consistency — every successful call persists). A failed/empty
  // recognition is a genuine 422, not a fabricated meal.
  async addMealFromImage(
    userId: string,
    orgId: number | null,
    body: JsonRecord,
    imageBuffer: Buffer,
    req: { protocol: string; get(name: string): string | undefined },
    imageMimeType?: string,
  ) {
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const tz = profile.timezone || "Asia/Kolkata";

    let dietaryRestrictions: string[] = [];
    try {
      const parsed = profile.dietary_restrictions ? JSON.parse(profile.dietary_restrictions) : [];
      if (Array.isArray(parsed)) dietaryRestrictions = parsed.map(String);
    } catch {
      dietaryRestrictions = [];
    }
    const cuisinePreferences = routineCuisineKeys(profile.cuisine_preferences);

    const recognized = await recognizeMeal({
      imageBytes: imageBuffer,
      mimeType: imageMimeType,
      mealTypeHint: typeof body.meal_type === "string" ? body.meal_type : null,
      dietaryRestrictions,
      cuisinePreferences,
    });
    if (!recognized || recognized.items.length === 0) {
      throw new AppError(
        recognized?.clarification_question || "Could not identify the food. Please try a clearer photo.",
        [],
        422,
      );
    }

    const totals = recognized.items.reduce(
      (acc, item) => ({
        calories: acc.calories + item.calories,
        protein_g: acc.protein_g + item.protein_g,
        carbs_g: acc.carbs_g + item.carbs_g,
        fat_g: acc.fat_g + item.fat_g,
      }),
      { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    );
    // Gemini's item schema has no fibre_g field (matches the real prompt/schema
    // exactly — it was never asked for), so this checkout's meals table stores 0
    // for image-recognized meals, same as prod's own normalizeRecognizedItems.
    const fibre_g = 0;

    const mealType = resolveUploadMealType(recognized, mealTypeFromCurrentTime(tz));
    const mealName = recognized.meal_name || recognized.items[0]!.food_name;
    const confidenceBand = recognized.overall_confidence >= 0.8 ? "high" : recognized.overall_confidence >= 0.5 ? "medium" : "low";

    // Store the actual uploaded photo (downscaled to the same JPEG used for
    // recognition) so image_url is a real, servable photo — not the demo
    // placeholder — matching the real system's persisted meal photo.
    const photoUrl = await storeUploadedImage(imageBuffer, req);

    const now = new Date();
    const meal = await commonService.insertIntoTable('meals', {
      id: randomUUID(),
      user_id: userId,
      org_id: orgId,
      meal_type: mealType.toUpperCase(),
      logged_at: now,
      logged_date: now,
      calories: Math.round(totals.calories),
      protein_g: round1(totals.protein_g),
      carbs_g: round1(totals.carbs_g),
      fat_g: round1(totals.fat_g),
      fibre_g,
      meal_name: mealName,
      photo_url: photoUrl,
      detected_items_json: JSON.stringify(recognized.items),
      confirmed_items_json: JSON.stringify(recognized.items),
      ingredients: recognized.ingredients.length > 0 ? JSON.stringify(recognized.ingredients) : null,
      ai_confidence: confidenceBand,
      source: "scanner",
      is_verified: true,
      manual_edits_flag: false,
    });

    return buildSavedMealResponse(meal, req, {
      serving_size: 1,
      serving_unit: "serving",
      ingredients: recognized.ingredients.length > 0 ? recognized.ingredients : [mealName],
      imageUrl: photoUrl ?? undefined,
      aiDominantNutrient: recognized.dominant_nutrient,
      aiHealthRating: recognized.health_rating,
    });
  }

  // ── Update water consumption (V1) — ported from foodDR's real
  // nutritionClientV1SummaryService.ts. Real request field is
  // `water_consumed_ml` (an INCREMENT to add, not a running total); daily
  // cap is a fixed 11 L safe maximum, separate from the user's own target.
  async updateWaterConsumption(userId: string, body: JsonRecord) {
    const profile = await commonService.findOneInTable('user_nutrition_profiles', { id: userId });
    if (!profile) {
      throw new AppError(ERROR_MESSAGE.NUTRITION_PROFILE_NOT_FOUND, [], 404);
    }
    const amountMl = Number(body.water_consumed_ml ?? body.amount_ml ?? body.water_ml ?? body.amount);
    if (!Number.isFinite(amountMl) || amountMl <= 0) {
      throw new AppError(ERROR_MESSAGE.WATER_CONSUMED_ML_REQUIRED, [], 400);
    }
    const tz = profile.timezone || "Asia/Kolkata";
    const today = todayInTz(tz);
    const todayDate = momentTZ.tz(today, "YYYY-MM-DD", "UTC").toDate();
    const maxAllowedMl = 11000;

    const [existing, plan] = await Promise.all([
      commonService.findOneInTable('daily_stats', { user_id_date: { user_id: userId, date: todayDate } }),
      commonService.getFromTable('user_nutrition_plans', { user_id: userId, is_active: true, is_deleted: false }, { orderBy: { version: "desc" } }),
    ]);
    const previous = Math.round(existing?.water_consumed_ml ?? 0);
    if (previous >= maxAllowedMl) {
      throw new AppError(`Daily water consumption limit exceeded. The maximum is ${maxAllowedMl} ml (${maxAllowedMl / 1000} L) per day.`, [], 400);
    }
    const newTotal = Math.round(previous + amountMl);
    if (newTotal > maxAllowedMl) {
      throw new AppError(`Daily water consumption limit exceeded. You can add up to ${Math.max(0, maxAllowedMl - previous)} ml today (max ${maxAllowedMl / 1000} L per day).`, [], 400);
    }

    const planTarget = Number(plan?.water_target_ml ?? 0);
    const target = Math.trunc(planTarget > 0 ? planTarget : Number(profile.current_weight_kg ?? 70) * WATER_LITRES_PER_KG * 1000);

    await commonService.upsertInTable(
      'daily_stats',
      { user_id_date: { user_id: userId, date: todayDate } },
      { id: randomUUID(), user_id: userId, date: todayDate, water_consumed_ml: newTotal, water_logged_at: new Date() },
      { water_consumed_ml: newTotal, water_logged_at: new Date() },
    );

    return {
      water_consumed_ml: newTotal,
      water_target_ml: target,
      remaining_ml: Math.max(0, target - newTotal),
      progress_percentage: pct(newTotal, target),
    };
  }

  // ── Complete assessment (V1) ─────────────────────────────────────────────
  async completeAssessment(userId: string) {
    const profile = await commonService.updateTable('user_nutrition_profiles', { id: userId }, { onboarding_completed: true });
    return { onboarding_completed: profile.onboarding_completed };
  }
}

export default new NutritionControllerService();

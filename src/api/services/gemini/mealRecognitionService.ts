/**
 * Real Gemini vision meal-photo recognition for addMeal type 2 (image
 * upload) — ported from FoodDr/backend-node's gemini.adapter.ts
 * (recognizeMeal). Same prompt, same REST call shape, same model/params,
 * same response validation. This is genuinely wired to the Gemini API using
 * GEMINI_API_KEY from .env — not a stub, not fabricated output. Skipped
 * relative to the real adapter (documented, not hidden): the
 * dosa-ambiguity / generic-meal-name cosmetic guards, the response cache,
 * and the `nutrition_advice` field (needs a "Today" payload this checkout
 * doesn't have).
 */
import { Jimp } from "jimp";
import { toBase64 } from "../../utils/imageInput";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_VISION_MODEL = "gemini-3.6-flash";
const RECOGNITION_DOWNSCALE_PX = 768;

export interface RecognizedMealItem {
  food_name: string;
  quantity: number;
  unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  confidence: number;
}

export interface RecognizedMeal {
  items: RecognizedMealItem[];
  meal_name: string | null;
  meal_type: string | null;
  ingredients: string[];
  dominant_nutrient: { name: string; benefit: string } | null;
  health_rating: "green" | "yellow" | "red" | null;
  overall_confidence: number;
  clarification_question: string | null;
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  const match = cleaned.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)```\s*$/);
  if (match) return match[1]!.trim();
  if (cleaned.startsWith("```")) {
    const idx = cleaned.indexOf("\n");
    cleaned = idx >= 0 ? cleaned.slice(idx + 1) : cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

function buildPrompt(mealTypeHint: unknown, dietaryRestrictions: string[], cuisinePreferences: string[]): string {
  const restrictionsStr = dietaryRestrictions.join(", ") || "none";
  const cuisineStr = cuisinePreferences.join(", ") || "any";
  return (
    "You are a nutrition analysis AI. First decide whether the image contains visible edible food or a beverage.\n" +
    "Only analyze images that clearly show real food items. Reject non-food images such as posters, banners, documents, screenshots, mobile UI screenshots, human selfies, vehicles, buildings, animals, furniture, electronics, logos, random objects, or product packaging without visible food.\n\n" +
    "Return ONLY valid JSON (no markdown, no explanation) with this exact structure:\n" +
    '{\n  "items": [\n    {\n      "food_name": "Grilled Chicken Breast",\n      "quantity": 150,\n      "unit": "g",\n      "calories": 248,\n      "protein_g": 46.0,\n      "carbs_g": 0.0,\n      "fat_g": 5.4,\n      "confidence": 0.9\n    }\n  ],\n  "meal_name": "Grilled Chicken Plate",\n  "meal_type": "lunch",\n  "ingredients": ["Grilled Chicken Breast", "Mixed Greens", "Cherry Tomatoes"],\n  "dominant_nutrient": {"name": "Protein", "benefit": "Supports muscle repair and keeps you full."},\n  "health_rating": "green",\n  "overall_confidence": 0.85,\n  "clarification_question": null\n}\n\n' +
    "NAMING — THIS IS THE MOST IMPORTANT RULE:\n" +
    "- Name each item by its common DISH name, the way a person would order or describe it — e.g. 'Chicken Curry', 'Paneer Butter Masala', 'Masala Dosa', 'Veg Fried Rice', 'Margherita Pizza', 'Chicken Biryani'.\n" +
    "- NEVER use generic wellness/time names like 'Healthy Breakfast', 'Balanced Meal', 'Indian Lunch', 'Home-Packed Lunch', or 'Nutritious Plate' for meal_name or food_name. Name the visible food instead: 'Boiled Eggs and Milk', 'Rice with Potato Curry and Cucumber', 'Dosa with Sambar'.\n" +
    "- NEVER name an item after its raw ingredients or aromatics. Do NOT return items like 'Onion', 'Garlic', 'Green Chili', 'Ginger', 'Tomato', 'Oil', 'Salt', 'Spices', 'Coriander leaves' as separate foods. Those are components of a dish, not a dish.\n" +
    "- Prefer the simpler/plainer dish when two foods look nearly identical and the distinguishing filling or topping is not clearly visible.\n" +
    "- Dosa rule: return 'Masala Dosa' only when potato masala or another filling is visibly present. A folded/rolled dosa with no visible filling should be 'Plain Dosa' or 'Dosa', with medium or low confidence and a clarification_question if unsure.\n" +
    "- Treat ONE prepared dish as ONE item. A pan of curry with onion, garlic and chili in it is a single item (e.g. 'Onion Masala Curry' or 'Chicken Curry'), not three ingredient items.\n" +
    "- Only return multiple items when the image genuinely shows multiple DISTINCT dishes — e.g. a thali/plate with rice, dal, a sabzi, a curry and roti. List each DISH (not its ingredients).\n" +
    "- If you cannot identify the exact dish, give a short descriptive dish name ('Mixed Vegetable Curry', 'Grilled Fish', 'Vegetable Stir-fry'), never an ingredient list.\n\n" +
    "VISIBLE-EVIDENCE RULES:\n" +
    "- Do not invent hidden ingredients, garnishes, sauces, fillings, toppings, side dishes, or beverages that are NOT visible. This rule is about inventing things you cannot see — it does NOT mean you should omit toppings you CAN see.\n" +
    "- ALWAYS list every clearly VISIBLE topping / add-on in `ingredients`. For a topped bowl (noodles, ramen, salad, oats, pizza, curd rice), name the base AND each visible topping — e.g. for instant noodles topped with boiled egg, fried egg, tofu cubes, sauteed greens and crispy onions, return ingredients ['Instant Noodles', 'Boiled Egg', 'Fried Egg', 'Tofu', 'Sauteed Greens', 'Crispy Fried Onions']. Never return just ['Instant Noodles'] when toppings are visible.\n" +
    "- Reflect the visible toppings in `meal_name` too when they define the dish (e.g. 'Instant Noodles with Egg and Tofu'), and account for their calories/protein in the totals.\n" +
    "- Ingredients must be the main edible components a user would reasonably expect for that dish. Do not list oil, salt, spices, water, or tiny aromatics unless they are visibly dominant.\n" +
    "- If the dish is covered, blurry, cropped, or partially eaten, return the best generic dish name, lower item confidence to 0.5-0.7, and ask a clarification_question when the missing detail changes calories or ingredients.\n" +
    "- Quantity must describe only the visible edible portion. Do not estimate the original full plate if part of the food is already eaten or outside the frame.\n" +
    "- For countable foods, use piece count only when visible. Otherwise use grams for the visible portion.\n\n" +
    "RULES:\n- Use grams (g) for solid foods, ml for liquids, 'piece' for countable items (eggs, bread slices)\n- Estimate portion sizes from visual cues (plate size, hand comparison, depth of bowl)\n- Report nutrition (calories/protein/carbs/fat) for the WHOLE dish at its estimated portion, accounting for all its ingredients together\n- Use standard nutritional values per the estimated portion\n- confidence: 0.0-1.0 per item (0.9+ = clearly visible, 0.5-0.8 = partially visible/estimated, <0.5 = guessing)\n- overall_confidence: average of item confidences\n- meal_name: a SHORT overall name for the WHOLE meal, the way a person would call it (e.g. 'Chicken Biryani', 'Margherita Pizza', 'Masala Dosa'). For a single dish, use that dish name. For a mixed platter / thali with several dishes, use a CATEGORY name like 'Thali', 'Mixed Platter' or 'Combo Meal' — do NOT list the individual items here (the items array already has them).\n- meal_type: classify into exactly one of 'breakfast', 'lunch', 'snack', 'dinner', or 'drinks' based on WHAT THE FOOD IS, not the time of day. Use 'drinks' ONLY when the image shows purely a beverage / liquid with NO solid food — juice, smoothie, milkshake, shake, coffee, tea, lassi, buttermilk, soda, lemonade, water, etc. Breakfast dishes (idli, dosa, poha, upma, paratha, pancakes, cereal, oatmeal, eggs & toast) → 'breakfast'. Light/small solid bites (chips, fruit, nuts, biscuits, samosa) → 'snack'. Full rice/roti/curry plates → 'lunch' or 'dinner'. If it is a drink, it is ALWAYS 'drinks' (never 'snack'). If unclear, use 'lunch'.\n- ingredients: an array of the ACTUAL component foods that make up this meal — NOT the dish name. For a fruit salad list the fruits ('Mango', 'Strawberry', 'Kiwi', 'Pineapple'); for a sandwich list 'Bread', 'Cheese', 'Lettuce'; for a thali list each dish ('Rice', 'Dal', 'Paneer Sabzi', 'Roti'). Never repeat the overall meal_name here. If you genuinely cannot break it down, return the single best component name.\n- dominant_nutrient: the SINGLE most notable nutrient this meal is known for — a vitamin or mineral when one stands out (e.g. 'Vitamin C' for citrus/fruit salad, 'Iron' for spinach, 'Calcium' for dairy), otherwise a macronutrient ('Protein', 'Healthy Fats', 'Fibre', 'Carbohydrates'). Return {name, benefit} where benefit is ONE short sentence on why it helps.\n- health_rating: how healthy/recommended this meal is, exactly one of: 'green' (nutritious/recommended — fruit, salad, grilled lean protein, vegetables, nuts), 'yellow' (okay in moderation — white rice, refined carbs), 'red' (occasional treat — deep-fried, sugary, very high fat/calorie). Judge the FOOD itself, not the portion size.\n- clarification_question: ask if something is ambiguous (e.g. 'Is that white rice or cauliflower rice?'). null if clear.\n" +
    '- If the image does not clearly contain food, return exactly: {"items": [], "overall_confidence": 0.0, "clarification_question": "No food item detected in the uploaded image. Please upload a valid food image for meal analysis."}\n' +
    '- If food might be present but cannot be identified clearly, return: {"items": [], "overall_confidence": 0.0, "clarification_question": "Could not identify the food. Please try a clearer photo."}\n\n' +
    `Client meal type hint: ${mealTypeHint ?? "not specified"} (use only if the visible food could fit multiple slots; never override the food-based meal_type rules above)\n` +
    `User's dietary restrictions: ${restrictionsStr}\n` +
    `User's cuisine preferences: ${cuisineStr}\n`
  );
}

/** Downscale to ~768px JPEG before sending to Gemini — smaller upload, faster response, canonical mime. */
async function normalizeForRecognition(imageBytes: Buffer): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const img = await Jimp.fromBuffer(imageBytes);
    if (img.width > RECOGNITION_DOWNSCALE_PX) {
      const scale = RECOGNITION_DOWNSCALE_PX / img.width;
      img.resize({ w: RECOGNITION_DOWNSCALE_PX, h: Math.max(1, Math.round(img.height * scale)) });
    }
    const bytes = await img.getBuffer("image/jpeg");
    return { bytes, mime: "image/jpeg" };
  } catch {
    return null;
  }
}

export interface RecognizeMealArgs {
  imageBytes: Buffer;
  mimeType?: string;
  mealTypeHint?: unknown;
  dietaryRestrictions?: string[];
  cuisinePreferences?: string[];
}

/** Real Gemini vision call. Returns null when AI is unavailable/unconfigured/errors — callers must treat that as a genuine failure (this endpoint requires AI to work at all), not silently fall back to fabricated data. */
export async function recognizeMeal(args: RecognizeMealArgs): Promise<RecognizedMeal | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  if (args.imageBytes.length < 100) return null;

  const normalized = await normalizeForRecognition(args.imageBytes);
  const imageBytes = normalized?.bytes ?? args.imageBytes;
  const mimeType = normalized?.mime ?? args.mimeType ?? "image/jpeg";

  const prompt = buildPrompt(args.mealTypeHint, args.dietaryRestrictions ?? [], args.cuisinePreferences ?? []);

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: toBase64(imageBytes) } }],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 3072,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  let text: string | null = null;
  try {
    const response = await fetch(`${GEMINI_BASE}/${GEMINI_VISION_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      // A non-2xx here means Gemini itself rejected the call (bad/expired
      // GEMINI_API_KEY, rate limiting, a malformed request, etc.) — a real
      // backend problem, not "the AI couldn't see food in the photo". Log
      // it so that distinction is visible instead of silently collapsing
      // into the same generic "could not identify the food" user message.
      const errorBody = await response.text().catch(() => "");
      console.error(`[mealRecognitionService] Gemini call failed: ${response.status} ${response.statusText} — ${errorBody.slice(0, 500)}`);
      return null;
    }
    const data = (await response.json()) as Record<string, unknown>;
    const candidates = (data.candidates as Record<string, unknown>[] | undefined) ?? [];
    const content = candidates[0]?.content as Record<string, unknown> | undefined;
    const parts = (content?.parts as Record<string, unknown>[] | undefined) ?? [];
    text = String(parts[0]?.text ?? "") || null;
  } catch (err) {
    console.error("[mealRecognitionService] Gemini call threw:", err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!text) {
    console.error("[mealRecognitionService] Gemini returned no text content in its response");
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFences(text)) as Record<string, unknown>;
  } catch (err) {
    console.error("[mealRecognitionService] Failed to parse Gemini's response as JSON:", err, "raw text:", text.slice(0, 500));
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    console.error("[mealRecognitionService] Gemini's parsed response is missing an items array:", JSON.stringify(parsed).slice(0, 500));
    return null;
  }

  const items: RecognizedMealItem[] = [];
  for (const raw of parsed.items as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    if (!it.food_name) continue;
    items.push({
      food_name: String(it.food_name ?? "Unknown"),
      quantity: Math.max(0, Number(it.quantity ?? 1)),
      unit: String(it.unit ?? "serving"),
      calories: Math.max(0, Math.trunc(Number(it.calories ?? 0))),
      protein_g: Math.max(0, Math.round(Number(it.protein_g ?? 0) * 10) / 10),
      carbs_g: Math.max(0, Math.round(Number(it.carbs_g ?? 0) * 10) / 10),
      fat_g: Math.max(0, Math.round(Number(it.fat_g ?? 0) * 10) / 10),
      confidence: Math.min(1, Math.max(0, Number(it.confidence ?? 0.5))),
    });
  }

  const mt = String(parsed.meal_type ?? "").trim().toLowerCase();
  const meal_type = ["breakfast", "lunch", "snack", "dinner", "drinks"].includes(mt) ? mt : null;
  const dn = parsed.dominant_nutrient as Record<string, unknown> | undefined;
  const dnName = dn && typeof dn === "object" ? String(dn.name ?? "").trim() : "";
  const dominant_nutrient = dnName ? { name: dnName, benefit: String(dn!.benefit ?? "").trim() || "A key nutrient in this meal." } : null;
  const hr = String(parsed.health_rating ?? "").trim().toLowerCase();
  const health_rating = (["green", "yellow", "red"].includes(hr) ? hr : null) as "green" | "yellow" | "red" | null;
  const ingredients = Array.isArray(parsed.ingredients)
    ? (parsed.ingredients as unknown[]).map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];

  return {
    items,
    meal_name: (String(parsed.meal_name ?? "").trim() || null),
    meal_type,
    ingredients,
    dominant_nutrient,
    health_rating,
    overall_confidence: Math.min(1, Math.max(0, Number(parsed.overall_confidence ?? 0.5))),
    clarification_question: (String(parsed.clarification_question ?? "").trim() || null),
  };
}

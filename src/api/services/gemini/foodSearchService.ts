/**
 * Quick Add Meal — AI search fallback. Ported from FoodDr/backend-node's
 * gemini.adapter.ts (interpretFoodSearchQuery) + foodCatalogService.ts's
 * search() orchestration: plain substring search is ALWAYS tried first and
 * is never affected by this file — this is called ONLY when that returns
 * zero results, to turn a natural-language / partial / misspelled query
 * into catalog-searchable keywords. Returns null (never throws) when AI is
 * off, errors, or returns nothing usable — the caller then just keeps the
 * original empty result instead of guessing.
 */
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

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

export async function interpretFoodSearchQuery(query: unknown): Promise<string[] | null> {
  const raw = String(query ?? "").trim();
  if (!raw) return null;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt =
    `A user searched for a food/meal to log using this text: "${raw}"\n` +
    `This is either (a) a specific dish or food name, possibly misspelled or abbreviated ` +
    `("chkn" -> "chicken"), or (b) a broad diet/category description naming no specific dish ` +
    `("non veg" -> ["chicken","fish","egg","mutton"], "vegetarian" -> ["paneer","dal","vegetable","tofu"], ` +
    `"vegan" -> ["tofu","lentil","vegetable"], "high protein" -> ["chicken","paneer","egg","lentil"]).\n` +
    `Return up to 5 short, generic food or dish name keywords (1-2 words each) that would find ` +
    `matches in a food database via substring search — for (a) correct the typo/abbreviation, for ` +
    `(b) list several representative keywords for that category. Ignore quantities/units/filler words.\n` +
    `Return ONLY a valid JSON array of strings, e.g. ["chicken", "rice"]. ` +
    `If nothing food-related can be determined at all, return [].`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  let text: string | null = null;
  try {
    const response = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 150 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    const candidates = (data.candidates as Record<string, unknown>[] | undefined) ?? [];
    const content = candidates[0]?.content as Record<string, unknown> | undefined;
    const parts = (content?.parts as Record<string, unknown>[] | undefined) ?? [];
    text = String(parts[0]?.text ?? "") || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(text));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const keywords = parsed
    .map((k) => String(k ?? "").trim())
    .filter((k) => k.length > 0)
    .slice(0, 5);
  return keywords.length > 0 ? keywords : null;
}

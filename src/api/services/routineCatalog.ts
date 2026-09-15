/**
 * Upcoming Routine (V2) — deterministic 7-day meal catalog, ported verbatim
 * from FoodDr/backend-node's src/api/services/plan/planService.ts
 * (HEALTHY_FALLBACK_MEALS, MEAL_DISTRIBUTION, MEAL_TIME_SLOTS,
 * buildHealthyFallbackMealSlot's macro formula) and
 * nutritionClientV2RoutineService.ts's buildAiInsights.
 *
 * Confirmed via investigation of the real source (not assumed from the route
 * name) that the default `days=7` request path used by GET
 * /api/v2/getUpcomingRoutine is 100% deterministic — no AI/Gemini call.
 * Dish names come from this fixed, curated catalog (day-of-week indexed, no
 * repeats across 7 days); per-item macros are a fixed 24% protein / 25% fat /
 * remainder-carbs split of that slot's target calories, not a real
 * per-dish nutrition lookup. Only a `days` value other than 7 triggers a
 * real Gemini call in prod (with the same catalog as its fallback on
 * timeout/failure) — this checkout does not have that AI wiring, so any
 * `days` value here uses this same deterministic catalog (day index wraps
 * mod 7), which is exactly what prod itself falls back to when AI is
 * unavailable.
 */

export const ROUTINE_MEAL_TIME_SLOTS: Record<string, string> = {
  breakfast: "08:00",
  lunch: "13:00",
  snack: "16:30",
  dinner: "19:30",
};

export const ROUTINE_MEAL_DISTRIBUTION: Record<string, number> = {
  breakfast: 0.25,
  lunch: 0.3,
  snack: 0.15,
  dinner: 0.3,
};

const HEALTHY_FALLBACK_MEALS: Record<string, Record<string, Record<string, string[]>>> = {
  indian: {
    vegetarian: {
      breakfast: [
        "Moong dal chilla with mint chutney",
        "Ragi porridge with fruit",
        "Idli with sambar",
        "Besan vegetable cheela",
        "Vegetable upma with peas",
        "Poha with peanuts and curry leaves",
        "Rava idli with coconut chutney",
      ],
      lunch: [
        "Dal roti plate with cucumber salad",
        "Rajma brown rice bowl",
        "Sambar rice with vegetables",
        "Paneer tikka millet bowl",
        "Vegetable dal bowl",
        "Chole with brown rice",
        "Palak paneer with roti",
      ],
      snack: [
        "Fruit chaat with roasted chana",
        "Roasted makhana with fruit",
        "Sprout chaat with cucumber",
        "Apple with roasted peanuts",
        "Mixed fruit bowl",
        "Steamed dhokla with chutney",
        "Roasted peanut chaat",
      ],
      dinner: [
        "Moong dal khichdi with vegetables",
        "Lentil soup with roti",
        "Millet dal bowl",
        "Vegetable sambar with rice",
        "Masoor dal plate",
        "Palak dal with jeera rice",
        "Vegetable khichdi with curd",
      ],
    },
    vegan: {
      breakfast: [
        "Ragi porridge with fruit",
        "Idli with sambar",
        "Vegetable poha with peanuts",
        "Besan vegetable cheela",
        "Sprouted moong bowl",
        "Vegetable dalia porridge",
        "Rava idli with coconut chutney",
      ],
      lunch: [
        "Dal roti plate with cucumber salad",
        "Rajma brown rice bowl",
        "Sambar rice with vegetables",
        "Chana masala millet bowl",
        "Vegetable dal bowl",
        "Chole with brown rice",
        "Vegetable pulao with cucumber salad",
      ],
      snack: [
        "Fruit chaat with roasted chana",
        "Roasted makhana with fruit",
        "Sprout chaat with cucumber",
        "Apple with roasted peanuts",
        "Mixed fruit bowl",
        "Steamed dhokla with chutney",
        "Roasted peanut chaat",
      ],
      dinner: [
        "Moong dal khichdi with vegetables",
        "Lentil soup with roti",
        "Millet dal bowl",
        "Vegetable sambar with rice",
        "Masoor dal plate",
        "Palak dal with jeera rice",
        "Vegetable khichdi with coconut chutney",
      ],
    },
    non_vegetarian: {
      breakfast: [
        "Egg bhurji with whole wheat roti",
        "Masala omelette with vegetable poha",
        "Boiled eggs with upma",
        "Chicken keema dalia bowl",
        "Anda roti breakfast plate",
        "Chicken sausage paratha wrap",
        "Chicken keema paratha plate",
      ],
      lunch: [
        "Grilled chicken roti bowl",
        "Fish curry rice bowl",
        "Chicken tikka millet bowl",
        "Egg curry rice bowl",
        "Tandoori chicken dal plate",
        "Mutton curry with rice",
        "Prawn masala rice bowl",
      ],
      snack: [
        "Boiled eggs with fruit chaat",
        "Tandoori chicken salad",
        "Egg chaat with cucumber",
        "Chicken tikka cucumber bowl",
        "Egg masala bhurji bites",
        "Chicken seekh kebab bites",
        "Fish tikka with mint chutney",
      ],
      dinner: [
        "Chicken curry roti plate",
        "Fish tikka with rice and salad",
        "Egg bhurji roti plate",
        "Chicken dalia bowl",
        "Mutton soup with millet roti",
        "Prawn curry with rice",
        "Chicken keema with roti",
      ],
    },
  },
  western: {
    vegetarian: {
      breakfast: [
        "Greek yogurt oatmeal bowl",
        "Avocado toast with cottage cheese",
        "Vegetable tofu scramble with toast",
        "Berry yogurt smoothie bowl",
        "Whole grain toast with peanut butter",
        "Spinach feta breakfast wrap",
        "Overnight oats with berries",
      ],
      lunch: [
        "Quinoa bean salad bowl",
        "Vegetable soup with whole grain toast",
        "Chickpea avocado wrap",
        "Cottage cheese salad plate",
        "Lentil pasta vegetable bowl",
        "Caprese sandwich with side salad",
        "Grilled halloumi quinoa bowl",
      ],
      snack: [
        "Greek yogurt with berries",
        "Apple with peanut butter",
        "Cottage cheese cucumber bowl",
        "Carrot sticks with bean dip",
        "Berry smoothie",
        "Trail mix with dried fruit",
        "Veggie hummus wrap bites",
      ],
      dinner: [
        "Lentil soup with whole grain toast",
        "Quinoa vegetable bowl",
        "Bean and vegetable wrap",
        "Baked potato with cottage cheese",
        "Vegetable pasta protein bowl",
        "Stuffed bell peppers with quinoa",
        "Vegetable lasagna with side salad",
      ],
    },
    vegan: {
      breakfast: [
        "Oatmeal bowl with berries",
        "Avocado toast with seeds",
        "Tofu scramble with whole grain toast",
        "Berry oat smoothie bowl",
        "Peanut spread banana toast",
        "Chia seed pudding with berries",
        "Overnight oats with fruit and chia",
      ],
      lunch: [
        "Quinoa bean salad bowl",
        "Vegetable soup with whole grain toast",
        "Chickpea avocado wrap",
        "Lentil pasta vegetable bowl",
        "Tofu quinoa bowl",
        "Mediterranean hummus veggie wrap",
        "Falafel wrap with side salad",
      ],
      snack: [
        "Apple with roasted peanuts",
        "Carrot sticks with bean dip",
        "Berry oat smoothie",
        "Roasted chickpea snack bowl",
        "Banana with walnuts",
        "Trail mix with dried fruit",
        "Hummus veggie wrap bites",
      ],
      dinner: [
        "Lentil soup with whole grain toast",
        "Quinoa vegetable bowl",
        "Bean and vegetable wrap",
        "Baked potato with lentil topping",
        "Tofu vegetable pasta bowl",
        "Stuffed bell peppers with quinoa",
        "Vegetable lasagna with cashew sauce",
      ],
    },
    non_vegetarian: {
      breakfast: [
        "Egg white scramble with whole grain toast",
        "Chicken avocado breakfast wrap",
        "Turkey omelette with vegetables",
        "Boiled eggs with oatmeal",
        "Salmon egg toast",
        "Bacon and egg breakfast bowl",
        "Smoked salmon bagel plate",
      ],
      lunch: [
        "Grilled chicken quinoa salad",
        "Tuna whole grain sandwich",
        "Turkey avocado wrap",
        "Salmon vegetable bowl",
        "Chicken bean soup with toast",
        "Turkey club sandwich",
        "Grilled shrimp Caesar salad",
      ],
      snack: [
        "Boiled eggs with berries",
        "Turkey cucumber rollups",
        "Tuna salad lettuce cups",
        "Chicken yogurt dip with carrots",
        "Egg salad protein bowl",
        "Beef jerky with fruit",
        "Chicken salad lettuce wraps",
      ],
      dinner: [
        "Baked salmon with sweet potato",
        "Grilled chicken vegetable bowl",
        "Turkey meatball whole grain pasta",
        "Lean steak salad plate",
        "Chicken soup with whole grain toast",
        "Roast chicken with vegetables",
        "Grilled shrimp with quinoa",
      ],
    },
  },
  mediterranean: {
    vegetarian: {
      breakfast: [
        "Greek yogurt with fruit and nuts",
        "Feta vegetable toast",
        "Hummus whole wheat pita plate",
        "Mediterranean chickpea breakfast bowl",
        "Shakshuka with pita",
        "Labneh with olives and pita",
        "Spinach feta pastry plate",
      ],
      lunch: [
        "Falafel salad with hummus",
        "Greek lentil soup with pita",
        "Chickpea couscous bowl",
        "Feta quinoa salad",
        "Greek salad with pita",
        "Stuffed grape leaves plate",
        "Vegetable moussaka bowl",
      ],
      snack: [
        "Hummus with cucumber sticks",
        "Greek yogurt with berries",
        "Chickpea salad cups",
        "Olive feta cucumber bowl",
        "Marinated olives with feta",
        "Roasted red pepper hummus cups",
        "Yogurt with honey and walnuts",
      ],
      dinner: [
        "Lentil soup with pita",
        "Mediterranean chickpea stew",
        "Falafel quinoa plate",
        "Greek vegetable couscous bowl",
        "Vegetable moussaka plate",
        "Stuffed grape leaves with rice",
        "Spanakopita with side salad",
      ],
    },
    vegan: {
      breakfast: [
        "Hummus whole wheat pita plate",
        "Mediterranean chickpea breakfast bowl",
        "Tahini fruit oat bowl",
        "Olive avocado toast",
        "Chickpea flour socca with vegetables",
        "Za'atar flatbread with olive oil",
        "Fig and tahini toast",
      ],
      lunch: [
        "Falafel salad with hummus",
        "Greek lentil soup with pita",
        "Chickpea couscous bowl",
        "Tabbouleh hummus plate",
        "Vegetable moussaka bowl",
        "Stuffed grape leaves plate",
        "Roasted vegetable couscous bowl",
      ],
      snack: [
        "Hummus with cucumber sticks",
        "Chickpea salad cups",
        "Olive cucumber bowl",
        "Roasted chickpea snack plate",
        "Marinated olives with vegetables",
        "Roasted red pepper hummus cups",
        "Tahini date energy bites",
      ],
      dinner: [
        "Lentil soup with pita",
        "Mediterranean chickpea stew",
        "Falafel quinoa plate",
        "Vegetable couscous bowl",
        "Stuffed grape leaves with rice",
        "Vegetable tagine with couscous",
        "Chickpea and spinach stew",
      ],
    },
    non_vegetarian: {
      breakfast: [
        "Egg pita with Greek salad",
        "Chicken shawarma breakfast wrap",
        "Boiled eggs with hummus pita",
        "Turkey feta egg bowl",
        "Egg shakshuka with feta and pita",
        "Smoked salmon pita plate",
        "Chicken sausage breakfast wrap",
      ],
      lunch: [
        "Chicken shawarma salad bowl",
        "Grilled fish couscous plate",
        "Turkey hummus pita wrap",
        "Salmon Greek salad",
        "Lamb kofta with couscous",
        "Grilled shrimp Greek salad",
        "Chicken souvlaki plate",
      ],
      snack: [
        "Boiled eggs with hummus",
        "Chicken cucumber hummus cups",
        "Turkey pita bites",
        "Tuna cucumber salad",
        "Grilled shrimp skewers with tzatziki",
        "Chicken souvlaki bites",
        "Smoked salmon cucumber cups",
      ],
      dinner: [
        "Grilled fish with couscous",
        "Chicken kebab quinoa plate",
        "Turkey meatball pita bowl",
        "Salmon with Greek salad",
        "Lamb kofta with rice",
        "Grilled shrimp with couscous",
        "Chicken souvlaki with Greek salad",
      ],
    },
  },
  other: {
    vegetarian: {
      breakfast: [
        "High protein vegetable breakfast bowl",
        "Whole grain porridge with fruit",
        "Sprouted bean breakfast bowl",
        "Yogurt fruit protein bowl",
        "Vegetable stuffed paratha plate",
        "Paneer bhurji with multigrain toast",
        "Cottage cheese fruit bowl",
      ],
      lunch: [
        "Lentil grain bowl with salad",
        "Bean vegetable lunch bowl",
        "Tofu grain bowl with vegetables",
        "Cottage cheese salad plate",
        "Paneer vegetable stir-fry bowl",
        "Mixed bean grain bowl",
        "Vegetable quinoa power bowl",
      ],
      snack: [
        "Fruit with roasted nuts",
        "Yogurt with berries",
        "Vegetable sticks with bean dip",
        "Roasted chickpea snack bowl",
        "Cottage cheese vegetable bowl",
        "Trail mix with dried fruit",
        "Sprouted moong chaat",
      ],
      dinner: [
        "Lentil vegetable stew",
        "Tofu vegetable grain bowl",
        "Bean soup with whole grains",
        "Vegetable protein bowl",
        "Paneer vegetable curry bowl",
        "Mixed vegetable grain bowl",
        "Bean and vegetable chili",
      ],
    },
    vegan: {
      breakfast: [
        "Whole grain porridge with fruit",
        "Sprouted bean breakfast bowl",
        "Tofu breakfast bowl",
        "Peanut spread fruit toast",
        "Chia seed pudding with fruit",
        "Vegetable tofu scramble bowl",
        "Overnight oats with fruit and nuts",
      ],
      lunch: [
        "Lentil grain bowl with salad",
        "Bean vegetable lunch bowl",
        "Tofu grain bowl with vegetables",
        "Chickpea vegetable bowl",
        "Tofu vegetable stir-fry bowl",
        "Mixed bean grain bowl",
        "Vegetable quinoa power bowl",
      ],
      snack: [
        "Fruit with roasted nuts",
        "Vegetable sticks with bean dip",
        "Roasted chickpea snack bowl",
        "Banana with roasted peanuts",
        "Trail mix with dried fruit",
        "Sprouted moong chaat",
        "Roasted edamame snack bowl",
      ],
      dinner: [
        "Lentil vegetable stew",
        "Tofu vegetable grain bowl",
        "Bean soup with whole grains",
        "Vegetable protein bowl",
        "Tofu vegetable curry bowl",
        "Mixed vegetable grain bowl",
        "Bean and vegetable chili",
      ],
    },
    non_vegetarian: {
      breakfast: [
        "Egg breakfast bowl with vegetables",
        "Chicken breakfast grain bowl",
        "Boiled eggs with fruit",
        "Turkey egg breakfast plate",
        "Salmon breakfast bowl with vegetables",
        "Chicken sausage breakfast bowl",
        "Egg white veggie scramble bowl",
      ],
      lunch: [
        "Grilled chicken grain bowl",
        "Fish vegetable rice bowl",
        "Turkey bean salad bowl",
        "Egg protein lunch plate",
        "Salmon quinoa power bowl",
        "Shrimp vegetable grain bowl",
        "Chicken bean grain bowl",
      ],
      snack: [
        "Boiled eggs with fruit",
        "Chicken cucumber protein bowl",
        "Tuna vegetable cups",
        "Turkey rollups with salad",
        "Salmon cucumber protein cups",
        "Chicken jerky with fruit",
        "Egg white protein cups",
      ],
      dinner: [
        "Chicken vegetable grain bowl",
        "Fish soup with vegetables",
        "Turkey vegetable dinner plate",
        "Egg vegetable dinner bowl",
        "Salmon vegetable grain bowl",
        "Shrimp vegetable curry bowl",
        "Turkey chili with beans",
      ],
    },
  },
};

/** dietary_preference (any casing, e.g. "NON_VEGETARIAN") -> catalog diet key, default "vegetarian". */
export function routineDietKey(rawPreference: unknown): "vegetarian" | "vegan" | "non_vegetarian" {
  const normalized = String(rawPreference ?? "").trim().toLowerCase();
  if (normalized === "vegan") return "vegan";
  if (normalized === "non_vegetarian" || normalized === "non-vegetarian" || normalized === "nonveg") return "non_vegetarian";
  return "vegetarian";
}

/** cuisine_preferences (JSON array string, any casing/free text) -> catalog cuisine keys, default ["other"]. */
export function routineCuisineKeys(rawCuisinePreferences: unknown): string[] {
  let values: unknown[] = [];
  if (typeof rawCuisinePreferences === "string" && rawCuisinePreferences.trim()) {
    try {
      const parsed = JSON.parse(rawCuisinePreferences);
      if (Array.isArray(parsed)) values = parsed;
    } catch {
      values = [rawCuisinePreferences];
    }
  } else if (Array.isArray(rawCuisinePreferences)) {
    values = rawCuisinePreferences;
  }
  const normalized = values
    .map((value): string | null => {
      const text = String(value ?? "").trim().toLowerCase();
      if (!text) return null;
      if (text.includes("indian")) return "indian";
      if (text.includes("western") || text.includes("american") || text.includes("continental") || text.includes("european")) return "western";
      if (text.includes("mediterranean") || text.includes("middle_eastern") || text.includes("middle eastern")) return "mediterranean";
      return "other";
    })
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set<string>(normalized)];
  return unique.length > 0 ? unique : ["other"];
}

export interface RoutineMealItem {
  name: string;
  quantity: number;
  unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface RoutineMealSlot {
  meal_type: string;
  label: string;
  time: string;
  target_calories: number;
  suggested_food: string;
  items: RoutineMealItem[];
  total_calories: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  total_fibre_g: number;
}

function formatLabel(mealType: string): string {
  return mealType.charAt(0).toUpperCase() + mealType.slice(1);
}

function fallbackMealOptions(mealType: string, dietKey: string, cuisineKeys: string[]): string[] {
  const options: string[] = [];
  for (const cuisineKey of cuisineKeys) {
    options.push(...(HEALTHY_FALLBACK_MEALS[cuisineKey]?.[dietKey]?.[mealType] ?? []));
  }
  if (options.length > 0) return options;
  return HEALTHY_FALLBACK_MEALS.other?.[dietKey]?.[mealType] ?? [];
}

/** Same 25%/30%/15%/30% split as the real system's targetMealSlots(). */
export function routineTargetMealSlots(calorieTarget: number): { meal_type: string; label: string; time: string; target_calories: number }[] {
  return Object.keys(ROUTINE_MEAL_DISTRIBUTION).map((mealType) => ({
    meal_type: mealType,
    label: formatLabel(mealType),
    time: ROUTINE_MEAL_TIME_SLOTS[mealType] as string,
    target_calories: Math.round(calorieTarget * (ROUTINE_MEAL_DISTRIBUTION[mealType] as number)),
  }));
}

/**
 * Same day-of-week-indexed, no-repeat-across-7-days catalog pick as the real
 * system's buildHealthyFallbackMealSlot, including its exact macro formula
 * (24% protein / 25% fat / remainder carbs of the slot's target calories —
 * not a real per-dish nutrition lookup, matching prod's own fallback math).
 */
export function buildRoutineMealSlot(
  slot: { meal_type: string; label: string; time: string; target_calories: number },
  dietKey: string,
  cuisineKeys: string[],
  dayIndex: number,
): RoutineMealSlot {
  const options = fallbackMealOptions(slot.meal_type, dietKey, cuisineKeys);
  const index = options.length > 0 ? dayIndex % options.length : 0;
  const title = options[index] ?? `${slot.label} meal`;
  const calories = Math.max(1, Math.round(slot.target_calories) || 300);
  const protein = Math.max(1, Math.round((calories * 0.24) / 4));
  const fat = Math.max(1, Math.round((calories * 0.25) / 9));
  const carbs = Math.max(1, Math.round((calories - protein * 4 - fat * 9) / 4));
  return {
    meal_type: slot.meal_type,
    label: slot.label,
    time: slot.time,
    target_calories: slot.target_calories,
    suggested_food: title,
    items: [
      { name: title, quantity: 1, unit: "serving", calories, protein_g: protein, carbs_g: carbs, fat_g: fat },
    ],
    total_calories: calories,
    total_protein_g: protein,
    total_carbs_g: carbs,
    total_fat_g: fat,
    total_fibre_g: Math.max(3, Math.round(calories / 180)),
  };
}

/** Title Case for display (e.g. "Egg bhurji with whole wheat roti" -> "Egg Bhurji With Whole Wheat Roti"). */
export function routineTitleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/** Ported verbatim from nutritionClientV2RoutineService.ts's buildAiInsights — deterministic, goal-aware, no AI call. */
export function buildRoutineAiInsights(goalType: unknown): { id: string; icon_type: string; icon_bg_color: string; accent_color: string; text: string }[] {
  const goal = String(goalType ?? "maintain");
  const lead =
    goal === "loss"
      ? "Your calorie target supports steady, sustainable weight loss. Focus on whole foods and consistent portions to keep your health score climbing."
      : goal === "gain"
        ? "Your plan is set for a gradual surplus. Prioritise protein at each meal to support lean gains over time."
        : "Your plan is balanced for maintenance. Keep your routine steady and log consistently to hold your progress.";
  return [
    { id: "insight_001", icon_type: "star", icon_bg_color: "#FFF4D6", accent_color: "#F2B705", text: lead },
    {
      id: "insight_002",
      icon_type: "star",
      icon_bg_color: "#E1F7E3",
      accent_color: "#2ECC71",
      text: "Small, consistent daily actions — logging meals and hitting your water goal — make the biggest long-term difference.",
    },
  ];
}

/** "16:30" -> "4:30 PM" (matches the real to12Hour(slot.time) used for this endpoint's static HH:MM slot times). */
export function routineTo12Hour(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  let h = Number(hStr);
  const m = Number(mStr) || 0;
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${period}`;
}

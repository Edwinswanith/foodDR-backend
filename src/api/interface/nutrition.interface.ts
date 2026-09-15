/** A JSON-ish request/response body whose exact shape isn't otherwise typed. */
export type JsonRecord = Record<string, unknown>;

export interface NutritionProfileReq {
    age: number;
    gender: "MALE" | "FEMALE" | "OTHER";

    height: string;
    height_unit: "CM" | "FT";

    weight: string;
    weight_unit: "KG" | "LB";

    // Optional: same unit as `weight_unit`. Defaults to the current weight
    // (maintain) when omitted — this checkout doesn't replicate backend-node's
    // full goal-vs-weight cross-field validation (N_V2-005/006/007).
    goal_weight?: string;

    // No dedicated column for this in the real schema (confirmed via
    // `prisma db pull`) — echoed back in the response only, never persisted.
    body_type?: string;

    // The real `fooddr.user_nutrition_profiles` table (confirmed via
    // `prisma db pull` against the live DB) stores activity level as a plain
    // string column, not a foreign key into a lookup table — there is no
    // `activity_level_id`/`nutrition_masters` relationship for it. Matches
    // the ACTIVITY_MULTIPLIERS keys in nutritionControllerService.ts.
    activity_level: "sedentary" | "light" | "moderate" | "active" | "very_active";

    diet_type?: "VEGETARIAN" | "VEGAN" | "EGGETARIAN" | "NON_VEGETARIAN";

    food_preferences?: string;

    primary_goal?:
    | "WEIGHT_LOSS"
    | "MUSCLE_GAIN"
    | "BALANCED_NUTRITION"
    | "MEDICAL_RECOVERY"
    | "ENERGY_BOOST";

    secondary_goal?:
    | "WEIGHT_LOSS"
    | "MUSCLE_GAIN"
    | "BALANCED_NUTRITION"
    | "MEDICAL_RECOVERY"
    | "ENERGY_BOOST"
    | "IMPROVE_SLEEP"
    | "STRESS_REDUCTION";

    health_conditions?: string;
    energy_level?: number;
    meals_per_day?: number;
    water_intake?: string;
    water_intake_unit?: "LTR" | "ML";
}

/** GET /api/v2/getWeightHistory?page=1&limit=10 */
export interface GetWeightHistoryReq {
    page?: number;
    limit?: number;
}

export interface WeightHistoryEntry {
    id: string;
    date: string;
    weight: number;
    weight_unit: "KG" | "LB";
}

export interface WeightHistoryRes {
    current_weight: number;
    weight_unit: "KG" | "LB";
    history: WeightHistoryEntry[];
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    current_page: number;
}

/** GET /api/v2/getNutritionTimeLineByDate?date={{v2_date}}&page=1&limit=30 */
export interface GetNutritionTimelineReq {
    date: string; // required YYYY-MM-DD
    page?: number;
    limit?: number;
}

export interface NutritionTimelineEntry {
    id: number;
    title: string;
    subtitle: string;
    time: string;
    date: string;
    calories: number;
    unit: string;
}

export interface NutritionTimelineRes {
    date: string;
    items: NutritionTimelineEntry[];
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    current_page: number;
}
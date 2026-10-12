import moment from "moment-timezone";
import commonService from "./commonService";
import AppError from "../core/error-handler";
import { ERROR_MESSAGE } from "../constants";
import { computeHealthScore, consistencyScore, nutritionScore } from "./nutritionScore";

const defaultSchedule = [
  { meal_type: "breakfast", time: "08:00" },
  { meal_type: "lunch", time: "13:00" },
  { meal_type: "snack", time: "17:00" },
  { meal_type: "dinner", time: "20:00" },
];

/** Reuse the reference backend's 75/25 formula, reading authoritative meals.
 * No score writes or background jobs are needed, so edits/deletions take effect
 * on the next GET and both API views share the same result.
 */
export async function liveNutritionScores(userId: string, profile: any, start: string, end: string, suppliedPlan?: any) {
  const tz = profile.timezone || "Asia/Kolkata";
  const [plan, stats, meals] = await Promise.all([
    suppliedPlan ? Promise.resolve(suppliedPlan) : commonService.getFromTable("user_nutrition_plans", { user_id: userId, is_active: true, is_deleted: false }, { orderBy: { version: "desc" } }),
    commonService.getManyFromTable("daily_stats", { user_id: userId, is_deleted: false, date: { gte: moment.utc(start).toDate(), lte: moment.utc(end).toDate() } }),
    // History is needed for the pause-never-reset streak. Select only scoring
    // fields; exclude photos, recognition JSON and all soft-deleted meals.
    commonService.getManyFromTable("meals", { user_id: userId, is_deleted: false, logged_at: { lte: moment.tz(end, "YYYY-MM-DD", tz).endOf("day").toDate() } }, {
      select: { logged_at: true, meal_type: true, calories: true, protein_g: true, carbs_g: true, fat_g: true },
    }),
  ]);
  if (!plan) throw new AppError(ERROR_MESSAGE.NUTRITION_PLAN_NOT_FOUND, [], 404);

  let schedule = defaultSchedule;
  try {
    const parsed = JSON.parse(plan.meal_schedule_json || "null");
    if (Array.isArray(parsed) && parsed.length) {
      const slots = parsed.map(slot => ({ meal_type: String(slot.meal_type || "").toLowerCase(), time: String(slot.scheduled_time || slot.time || "") }))
        .filter(slot => slot.meal_type && /^\d{2}:\d{2}$/.test(slot.time));
      if (slots.length) schedule = slots;
    }
  } catch { /* Older plans may have no valid schedule; use plan-generation slots. */ }

  const mealsByDate = new Map<string, any[]>();
  for (const meal of meals) {
    const date = moment(meal.logged_at).tz(tz).format("YYYY-MM-DD");
    if (!mealsByDate.has(date)) mealsByDate.set(date, []);
    mealsByDate.get(date)!.push(meal);
  }
  const activeDates = [...mealsByDate.keys()].sort();
  const rows = new Map<string, any>(stats.map(row => [moment.utc(row.date).format("YYYY-MM-DD"), row]));
  const dates = new Set([...rows.keys(), ...activeDates.filter(date => date >= start), end]);
  const now = moment.tz(tz);
  const finite = (value: any) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return [...dates].sort().map(date => {
    const row = rows.get(date) || {};
    const dayMeals = mealsByDate.get(date) || [];
    const sum = (key: string) => dayMeals.reduce((total, meal) => total + finite(meal[key]), 0);
    const types = new Set(dayMeals.map(meal => String(meal.meal_type).toLowerCase()));
    let due = 0;
    let completed = 0;
    for (const slot of schedule) {
      if (types.has(slot.meal_type)) { completed++; due++; }
      else if (now.isSameOrAfter(moment.tz(`${date} ${slot.time}`, "YYYY-MM-DD HH:mm", tz).add(1, "hour"))) due++;
    }
    const weekStart = moment.utc(date).subtract(6, "days").format("YYYY-MM-DD");
    const activeDays = activeDates.filter(day => day >= weekStart && day <= date).length;
    // The reference rule pauses on inactive days instead of resetting. Only
    // seven active days affect the score; actual meal history replaces stale counters.
    const streak = activeDates.filter(day => day <= date).length;
    const target = (stored: string, current: string) => finite(row[stored]) > 0 ? finite(row[stored]) : finite(plan[current]);
    const health = computeHealthScore(nutritionScore(
      sum("calories"), target("goal_calories", "calorie_target"),
      [sum("protein_g"), sum("carbs_g"), sum("fat_g")],
      [target("protein_min_g", "protein_target_g"), target("carbs_min_g", "carbs_target_g"), target("fat_min_g", "fat_target_g")],
      completed, due,
    ), consistencyScore(streak, activeDays), Boolean(row.is_recovery_day ?? profile.recovery_is_active));
    return { ...row, date: moment.utc(date).toDate(), health_score: health.health_score,
      adherence_score: health.health_score / 100, score_breakdown_json: JSON.stringify(health.breakdown),
      status_pill_state: health.status_pill, streak_day: streak, meaningful_action_count: dayMeals.length };
  });
}

import { Request, Response } from "express";
import Responser from "../core/responser";
import AppError from "../core/error-handler";
import logsService from "../services/logsService";
import nutritionControllerService from "../services/nutritionControllerService";
import * as scanMealService from "../services/scanMealService";
import { ERROR_MESSAGE, SUCCESS_MESSAGES } from "../constants";
import type {
  NutritionProfileReq,
  GetWeightHistoryReq,
  GetNutritionTimelineReq,
  JsonRecord,
} from "../interface/nutrition.interface";

function queryNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// The real user id (fooddr.user_nutrition_profiles.id) is a string/UUID, not
// a number — confirmed via `npx prisma db pull` against the live database.
// The original `Number(req.body.authUserId)` cast here would silently
// produce NaN for any real id; every handler in this file reads it as a
// plain string instead.
function requireUserId(req: Request): string {
  const userId = req.body.authUserId || req.body.userId;
  if (!userId || typeof userId !== "string") {
    throw new AppError(ERROR_MESSAGE.AUTH_USER_ID_REQUIRED, [], 401);
  }
  return userId;
}

function queryOrBody(req: Request): JsonRecord {
  return { ...(req.query as JsonRecord), ...(req.body as JsonRecord) };
}

/**
 * Throws a clear, honest 501 for a route whose implementation depends on
 * infrastructure this partial checkout genuinely doesn't have (AI/vision
 * model wiring, partner-SSO session secrets) — see this repo's CLAUDE.md:
 * "don't 'fix' missing-module errors by guessing at their contents; ask for
 * the missing files if a task requires them." Using a non-500 status code is
 * required for the message to survive — AppError overwrites the message with
 * ERROR_MESSAGE.GENERAL_ERROR whenever statusCode is left at its 500 default
 * (see core/error-handler.ts).
 */
function notImplemented(feature: string, reason: string): never {
  throw new AppError(`${feature} is not implemented in this partial checkout — ${reason}`, [], 501);
}

class NutritionController {
  // ── POST /api/v2/generatePersonalizedNutritionPlan ──────────────────────
  async generatePersonalizedNutritionPlan(req: Request, res: Response) {
    let body: NutritionProfileReq | undefined;
    try {
      const userId = requireUserId(req);
      const orgId = req.body.orgId ? Number(req.body.orgId) : null;
      body = req.body as NutritionProfileReq;

      const data = await nutritionControllerService.generatePlan(userId, orgId, body);

      const payload = await logsService.getPayloadInput(
        body,
        "generatePersonalizedNutritionPlan",
        "",
        req,
        "",
        "success",
        SUCCESS_MESSAGES.NUTRITION_PLAN_GENERATED_SUCCESSFULLY,
      );
      await logsService.createLog(payload);

      Responser.success(res, true, SUCCESS_MESSAGES.NUTRITION_PLAN_GENERATED_SUCCESSFULLY, data, 200);
    } catch (error) {
      const payload = await logsService.getPayloadInput(
        body,
        "generatePersonalizedNutritionPlan",
        body || null,
        req,
        error,
      );
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── GET /api/v2/getWeightHistory?page=1&limit=10 ────────────────────────
  async getWeightHistory(req: Request, res: Response) {
    try {
      const userId = requireUserId(req);
      const query: GetWeightHistoryReq = {
        page: queryNumber(req.query.page, 1),
        limit: queryNumber(req.query.limit, 10),
      };

      const data = await nutritionControllerService.getWeightHistory(userId, query);

      const payload = await logsService.getPayloadInput(
        null,
        "getWeightHistory",
        "",
        req,
        "",
        "success",
        SUCCESS_MESSAGES.NUTRITION_WEIGHT_HISTORY_FETCHED_SUCCESSFULLY,
      );
      await logsService.createLog(payload);

      Responser.success(res, true, SUCCESS_MESSAGES.NUTRITION_WEIGHT_HISTORY_FETCHED_SUCCESSFULLY, data, 200);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "getWeightHistory", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── GET /api/v2/getNutritionTimeLineByDate?date=&page=1&limit=30 ────────
  async getNutritionTimeLineByDate(req: Request, res: Response) {
    try {
      const userId = requireUserId(req);
      const date = queryString(req.query.date);
      if (!date) {
        throw new AppError(ERROR_MESSAGE.DATE_REQUIRED, [], 400);
      }
      const query: GetNutritionTimelineReq = {
        date,
        page: queryNumber(req.query.page, 1),
        limit: queryNumber(req.query.limit, 30),
      };

      const { items, total_pages, current_page } = await nutritionControllerService.getTimeline(userId, query);

      const payload = await logsService.getPayloadInput(
        null,
        "getNutritionTimeLineByDate",
        "",
        req,
        "",
        "success",
        SUCCESS_MESSAGES.NUTRITION_TIMELINE_FETCHED_SUCCESSFULLY,
      );
      await logsService.createLog(payload);

      // Real system's shape for this one endpoint: `data` is the raw items
      // array; total_pages/current_page are top-level siblings, not nested
      // inside data (see core/responser.ts's doc comment on the `extra` param).
      Responser.success(res, true, SUCCESS_MESSAGES.NUTRITION_TIMELINE_FETCHED_SUCCESSFULLY, items, 200, {
        total_pages,
        current_page,
      });
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "getNutritionTimeLineByDate", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 3. Add Meal (V2) — manual / catalog / real image-recognition entry ──
  async addMeal(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const orgId = req.body.orgId ? Number(req.body.orgId) : null;
      // type 2 is multipart/form-data (it carries a file) — multer runs
      // before this handler (see routes/index.ts), so req.body.type and
      // req.file are already populated by the time we get here.
      const type = Number(req.body.type ?? req.query.type ?? 1);
      if (type === 2) {
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file?.buffer) {
          throw new AppError("image is required for type 2 (image upload).", [], 400);
        }
        const data = await nutritionControllerService.addMealFromImage(userId, orgId, req.body as JsonRecord, file.buffer, req);
        const payload = await logsService.getPayloadInput(null, "addMealV2", "", req, "", "success", SUCCESS_MESSAGES.MEAL_SAVED);
        await logsService.createLog(payload);
        Responser.success(res, true, SUCCESS_MESSAGES.MEAL_SAVED, data, 201);
        return;
      }
      const data = await nutritionControllerService.addMeal(userId, orgId, req.body as JsonRecord, req);
      const payload = await logsService.getPayloadInput(null, "addMealV2", "", req, "", "success", SUCCESS_MESSAGES.MEAL_SAVED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.MEAL_SAVED, data, 201);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "addMealV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 5. Update Weight (V2) ─────────────────────────────────────────────────
  // Real write against user_nutrition_profiles + daily_stats; does not
  // replicate prod's change-tolerance window / plan-recalculation-on-update
  // (see nutritionControllerService.ts's updateWeight doc comment).
  async updateWeight(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.updateWeight(userId, req.body as JsonRecord);
      const payload = await logsService.getPayloadInput(req.body, "updateWeightV2", "", req, "", "success", SUCCESS_MESSAGES.WEIGHT_V2_UPDATED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.WEIGHT_V2_UPDATED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(req.body, "updateWeightV2", req.body || null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 2. Nutrition Dashboard (V2): plan + today's stats + logged meals ────
  async getNutritionSummaryByDate(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.getNutritionSummaryByDate(userId, queryOrBody(req), req);
      const payload = await logsService.getPayloadInput(null, "getNutritionSummaryByDateV2", "", req, "", "success", SUCCESS_MESSAGES.NUTRITION_DASHBOARD_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.NUTRITION_DASHBOARD_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "getNutritionSummaryByDateV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 8. Progress (V2) ────────────────────────────────────────────────────────
  async getProgressByDate(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.getProgressByDate(userId, queryOrBody(req), req);
      const payload = await logsService.getPayloadInput(null, "getProgressByDateV2", "", req, "", "success", SUCCESS_MESSAGES.PROGRESS_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.PROGRESS_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "getProgressByDateV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 11. Nutrition Health Score (V2) ─────────────────────────────────────────
  // Reads daily_stats' precomputed health_score/score_breakdown_json rather
  // than recomputing an independent scoring algorithm.
  async fetchNutritionHealthScore(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.getHealthScore(userId, req.query as JsonRecord);
      const payload = await logsService.getPayloadInput(null, "fetchNutritionHealthScoreV2", "", req, "", "success", SUCCESS_MESSAGES.HEALTH_SCORE_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.HEALTH_SCORE_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "fetchNutritionHealthScoreV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 9. Upcoming Routine (V2) ─────────────────────────────────────────────
  // Read-only passthrough of any already-generated `routines` row — no AI
  // routine generation (see nutritionControllerService.ts's doc comment).
  async getUpcomingRoutine(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.getUpcomingRoutine(userId, req.query as JsonRecord);
      const payload = await logsService.getPayloadInput(null, "getUpcomingRoutineV2", "", req, "", "success", SUCCESS_MESSAGES.UPCOMING_ROUTINE_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.UPCOMING_ROUTINE_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "getUpcomingRoutineV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 10. Nutrition Achievements (V2) — real achievements table ───────────────
  async fetchNutritionAchievements(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.getAchievements(userId);
      const payload = await logsService.getPayloadInput(null, "fetchNutritionAchievementsV2", "", req, "", "success", SUCCESS_MESSAGES.ACHIEVEMENTS_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.ACHIEVEMENTS_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "fetchNutritionAchievementsV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── 11. Get Meals By Type (V2) — food_catalog lookup, no AI matching ────────
  async getMealsByType(this: void, req: Request, res: Response): Promise<void> {
    try {
      requireUserId(req);
      const data = await nutritionControllerService.getMealsByType(req.query as JsonRecord);
      const payload = await logsService.getPayloadInput(null, "getMealsByTypeV2", "", req, "", "success", SUCCESS_MESSAGES.MEALS_BY_TYPE_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.MEALS_BY_TYPE_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "getMealsByTypeV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── Meal search / autocomplete ────────────────────────────────────────────
  async searchMeals(this: void, req: Request, res: Response): Promise<void> {
    try {
      const data = await nutritionControllerService.searchMeals(req.query as JsonRecord);
      const payload = await logsService.getPayloadInput(null, "searchMealsV2", "", req, "", "success", SUCCESS_MESSAGES.MEALS_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.MEALS_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "searchMealsV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── Goal Progress ──────────────────────────────────────────────────────────
  async getGoalProgress(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.getGoalProgress(userId, req.query as JsonRecord);
      const payload = await logsService.getPayloadInput(null, "getGoalProgressV2", "", req, "", "success", SUCCESS_MESSAGES.GOAL_PROGRESS_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.GOAL_PROGRESS_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "getGoalProgressV2", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── POST /updateWaterConsumption ────────────────────────────────────────
  async updateWaterConsumption(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.updateWaterConsumption(userId, req.body as JsonRecord);
      const payload = await logsService.getPayloadInput(req.body, "updateWaterConsumptionV1", "", req, "", "success", SUCCESS_MESSAGES.WATER_CONSUMPTION_V1_UPDATED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.WATER_CONSUMPTION_V1_UPDATED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(req.body, "updateWaterConsumptionV1", req.body || null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── POST /completeAssessment ────────────────────────────────────────────
  async completeAssessment(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.completeAssessment(userId);
      const payload = await logsService.getPayloadInput(null, "completeAssessmentV1", "", req, "", "success", SUCCESS_MESSAGES.ASSESSMENT_V1_COMPLETED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.ASSESSMENT_V1_COMPLETED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "completeAssessmentV1", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── POST|DELETE /deleteMeal ─────────────────────────────────────────────
  // meal_id is the PUBLIC (hashed) id here, matching the real contract —
  // e.g. the meal_id returned by loggedMealsByDate/getProgressByDate/the
  // dashboard's logged_meals, not the raw internal UUID.
  async deleteMeal(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const rawMealId = req.body.meal_id ?? req.query.meal_id;
      const mealId = Number(rawMealId);
      if (!rawMealId || !Number.isSafeInteger(mealId) || mealId <= 0) {
        throw new AppError("meal_id is required and must be a positive integer (the public meal id).", [], 400);
      }
      const data = await nutritionControllerService.deleteMeal(userId, mealId);
      const payload = await logsService.getPayloadInput(req.body, "deleteMealV1", "", req, "", "success", SUCCESS_MESSAGES.MEAL_V1_DELETED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.MEAL_V1_DELETED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(req.body, "deleteMealV1", req.body || null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── POST /scanMeal ───────────────────────────────────────────────────────
  // Real barcode-scan implementation (see scanMealService.ts's header comment
  // for why this is a barcode scanner, not an AI photo classifier, and why it
  // is response-only / never persists a meal row — both match the real
  // FoodDr/backend-node source, read and ported deliberately, not guessed).
  async scanMeal(this: void, req: Request, res: Response): Promise<void> {
    try {
      const data = await scanMealService.scanMeal(req);
      const payload = await logsService.getPayloadInput(null, "scanMealV1", "", req, "", "success", SUCCESS_MESSAGES.SCAN_MEAL_V1_ANALYZED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.SCAN_MEAL_V1_ANALYZED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "scanMealV1", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

  // ── GET /loggedMealsByDate ───────────────────────────────────────────────
  async loggedMealsByDate(this: void, req: Request, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req);
      const data = await nutritionControllerService.loggedMealsByDate(userId, req.query as JsonRecord, req);
      const payload = await logsService.getPayloadInput(null, "loggedMealsByDateV1", "", req, "", "success", SUCCESS_MESSAGES.MEALS_BY_TYPE_V2_FETCHED);
      await logsService.createLog(payload);
      Responser.success(res, true, SUCCESS_MESSAGES.MEALS_BY_TYPE_V2_FETCHED, data);
    } catch (error) {
      const payload = await logsService.getPayloadInput(null, "loggedMealsByDateV1", null, req, error);
      await logsService.createLog(payload);
      Responser.error(res, false, error);
    }
  }

}

export default new NutritionController();

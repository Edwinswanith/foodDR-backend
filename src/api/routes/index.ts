import express from 'express';
import multer from 'multer';
import { ROUTE, routePath } from "../constants/index";
import validationRequest from '../middleware/validationRequest';
import customAuth from '../middleware/custom-auth';
import auth from '../middleware/auth';
import nutritionController from '../controller/nutritionController';

const router = express.Router();

// Memory storage, shared by scanMeal and addMeal (type 2): images are
// decoded/recognized in-process, never written to disk. Placed BEFORE
// auth.verifyJwt on the routes below: for a multipart request, express.json()
// (mounted globally in server.ts) never populates req.body, so multer must
// run first to parse it — auth.verifyJwt only adds `authUserId` onto the
// body multer already built; the opposite order would have multer's
// multipart parsing wipe out whatever auth had just set. Harmless no-op for
// addMeal's type 1/3 JSON requests — multer only touches multipart bodies.
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

/** middleware for open api's */
router.use(customAuth.customAuthMiddleware);

/** Validation */
router.use(validationRequest.validation);

/** nutrition routes — ported from foodDR's V2 nutrition-client endpoints */
router.post(routePath(ROUTE.GENERATE_NUTRITION_PLAN), auth.verifyJwt, nutritionController.generatePersonalizedNutritionPlan);
router.get(routePath(ROUTE.GET_WEIGHT_HISTORY), auth.verifyJwt, nutritionController.getWeightHistory);
router.get(routePath(ROUTE.GET_NUTRITION_TIMELINE), auth.verifyJwt, nutritionController.getNutritionTimeLineByDate);
router.post(routePath(ROUTE.ADD_MEAL), imageUpload.single("image"), auth.verifyJwt, nutritionController.addMeal);
router.post(routePath(ROUTE.UPDATE_WEIGHT), auth.verifyJwt, nutritionController.updateWeight);
router.get(routePath(ROUTE.GET_NUTRITION_SUMMARY_BY_DATE), auth.verifyJwt, nutritionController.getNutritionSummaryByDate);
router.get(routePath(ROUTE.GET_PROGRESS_BY_DATE), auth.verifyJwt, nutritionController.getProgressByDate);
router.get(routePath(ROUTE.FETCH_NUTRITION_HEALTH_SCORE), auth.verifyJwt, nutritionController.fetchNutritionHealthScore);
router.get(routePath(ROUTE.GET_UPCOMING_ROUTINE), auth.verifyJwt, nutritionController.getUpcomingRoutine);
router.get(routePath(ROUTE.FETCH_NUTRITION_ACHIEVEMENTS), auth.verifyJwt, nutritionController.fetchNutritionAchievements);
router.get(routePath(ROUTE.GET_MEAL_BY_TYPE), auth.verifyJwt, nutritionController.getMealsByType);
router.get(routePath(ROUTE.SEARCH_MEALS), auth.verifyJwt, nutritionController.searchMeals);
router.get(routePath(ROUTE.GOAL_PROGRESS), auth.verifyJwt, nutritionController.getGoalProgress);
router.post(routePath(ROUTE.UPDATE_WATER_CONSUMPTION), auth.verifyJwt, nutritionController.updateWaterConsumption);
router.post(routePath(ROUTE.COMPLETE_ASSESSMENT), auth.verifyJwt, nutritionController.completeAssessment);
router.post(routePath(ROUTE.DELETE_MEAL), auth.verifyJwt, nutritionController.deleteMeal);
router.post(routePath(ROUTE.SCAN_MEAL), imageUpload.single("image"), auth.verifyJwt, nutritionController.scanMeal);
// GET, matching prod's equivalent V1_LOGGED_MEALS_BY_DATE (backend-node) — this
// was POST, an inconsistency found and fixed as part of the prod-vs-local
// comparison (see docs/PROD_VS_LOCAL_API_COMPARISON.md, Finding 3).
router.get(routePath(ROUTE.LOGGED_MEALS_BY_DATE), auth.verifyJwt, nutritionController.loggedMealsByDate);



export default router;

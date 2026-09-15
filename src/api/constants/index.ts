/** Open-API skip list (static `token` header). Empty — nutrition routes use JWT. */
export const EXCLUDE_APIS: string[] = [];

/** Strip dummy query examples from ROUTE values so Express matches the path only. */
export const routePath = (route: string): string => route.split("?")[0];

export enum ROUTE {
  /** nutrition routes — query strings below are dummy examples of required params, not part of the Express path */
  GENERATE_NUTRITION_PLAN = "/api/v2/generatePersonalizedNutritionPlan",
  GET_WEIGHT_HISTORY = "/api/v2/getWeightHistory?page=1&limit=10",
  GET_NUTRITION_TIMELINE = "/api/v2/getNutritionTimeLineByDate?date={{v2_date}}&page=1&limit=30",
  ADD_MEAL ="/api/v2/addMeal",
  UPDATE_WEIGHT ="/api/v2/updateWeight",
  GET_NUTRITION_SUMMARY_BY_DATE ="/api/v2/getNutritionSummaryByDate?date={{today}}&page=1&limit=30",
  GET_PROGRESS_BY_DATE ="/api/v2/getProgressByDate?date={{today}}&include_benefits=false",
  FETCH_NUTRITION_HEALTH_SCORE ="/api/v2/fetchNutritionHealthScore?range=7",
  GET_UPCOMING_ROUTINE ="/api/v2/getUpcomingRoutine?days=7",
  FETCH_NUTRITION_ACHIEVEMENTS ="/api/v2/fetchNutritionAchievements",
  GET_MEAL_BY_TYPE ="/api/v2/getMealsByType?meal_type=lunch&page=1&limit=10",
  SEARCH_MEALS ="/api/v2/meals/search?meal_type=lunch&query=rice&limit=10",
  GOAL_PROGRESS ="/api/v2/reports/goal-progress?days=7",
  UPDATE_WATER_CONSUMPTION ="/api/updateWaterConsumption",
  COMPLETE_ASSESSMENT ="/api/completeAssessment",
  DELETE_MEAL="/api/deleteMeal",
  SCAN_MEAL="/api/scanMeal",
  LOGGED_MEALS_BY_DATE="/api/loggedMealsByDate?page=1&limit=10",
}

export enum SUCCESS_MESSAGES {
  TOKEN_VALIDATED_SUCCESSFULLY = "Token validated successfully",

  NUTRITION_PLAN_GENERATED_SUCCESSFULLY = "Nutrition plan generated successfully",
  NUTRITION_WEIGHT_HISTORY_FETCHED_SUCCESSFULLY = "Weight history fetched successfully",
  NUTRITION_TIMELINE_FETCHED_SUCCESSFULLY = "Nutrition timeline fetched successfully",

  MEAL_SAVED = "Meal saved successfully",
  WEIGHT_V2_UPDATED = "Weight updated successfully",
  NUTRITION_DASHBOARD_V2_FETCHED = "Nutrition dashboard fetched successfully",
  PROGRESS_V2_FETCHED = "Progress fetched successfully",
  HEALTH_SCORE_V2_FETCHED = "Nutrition health score fetched successfully",
  UPCOMING_ROUTINE_V2_FETCHED = "Upcoming routine fetched successfully",
  ACHIEVEMENTS_V2_FETCHED = "Achievements fetched successfully",
  MEALS_BY_TYPE_V2_FETCHED = "Meals fetched successfully",
  MEALS_FETCHED = "Meals fetched successfully",
  GOAL_PROGRESS_V2_FETCHED = "Goal progress fetched successfully",
  WATER_CONSUMPTION_V1_UPDATED = "Water consumption updated successfully",
  ASSESSMENT_V1_COMPLETED = "Assessment completed successfully",
  MEAL_V1_DELETED = "Meal deleted successfully",
  SCAN_MEAL_V1_ANALYZED = "Meal scanned successfully",
}

export enum ERROR_MESSAGE {
  USER_ACTIVE_IN_ANOTHER_DEVICE = "User is active in another device.",
  NO_ACTIVE_DEVICE = "No active device found for this user. Please log in again.",
  GENERAL_ERROR = "Something Went Wrong.",
  UNAUTHORIZED = "Unauthorized access",
  AUTH_USER_ID_REQUIRED = "Authenticated user ID is required for this operation.",
  DATE_REQUIRED = "date query param is required (YYYY-MM-DD).",

  NUTRITION_PROFILE_NOT_FOUND = "Nutrition profile not found. Complete onboarding before generating a plan.",
  NUTRITION_PLAN_NOT_FOUND = "Nutrition plan not found. Generate a plan first.",
  INVALID_DATE_FORMAT = "Invalid date format. Expected YYYY-MM-DD.",

  // Scan Meal (V1) — ported verbatim from FoodDr/backend-node's messages.ts
  SCAN_IMAGE_REQUIRED = "Image is required to scan a meal. Please upload a valid image file.",
  FOOD_IMAGE_REQUIRED = "Image is required for meal analysis. Please upload a valid food image.",
  SCAN_BARCODE_INVALID = "Please scan a valid barcode and try again",
  SCAN_SERVICE_BUSY = "Our servers are currently busy. Please try again in a few moments",
  SCAN_BARCODE_PRODUCT_NOT_FOUND = "We couldn't find information for this barcode. Please try another barcode",
  BARCODE_FORMAT_INVALID_SHORT = "Invalid barcode format.",
  BARCODE_NOT_DETECTED = "Unable to detect a valid barcode from the uploaded image.",
  BARCODE_REQUIRED = "barcode is required.",
  BARCODE_FORMAT_INVALID = "Invalid barcode format. Use EAN-13, EAN-8, UPC-A, UPC-E, Code-128, or Code-39.",
  BARCODE_LENGTH_INVALID = "Invalid barcode length. Numeric barcodes must be EAN-13, EAN-8, UPC-A, UPC-E, or GTIN compatible.",
  PRODUCT_LOOKUP_UNAVAILABLE = "Product lookup service is temporarily unavailable. Please try again.",
  PRODUCT_LOOKUP_TIMED_OUT = "Product lookup service timed out. Please try again.",
  FILE_TOO_LARGE = "Image is too large. Please upload a file under 8MB.",
}

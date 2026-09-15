import { Response } from "express";
import AppError from "./error-handler";
import { ERROR_MESSAGE } from "../constants";

/**
 * Envelope shape restored to the previous/legacy contract at explicit user
 * request: {success, status_code, message, data}. This checkout's real
 * FoodDr/backend-node sibling uses {status, message, data} instead (that
 * was this file's shape until this change) — that mismatch is intentional
 * and known, not an oversight. Every other behavior (internal-field
 * stripping, pagination via the `extra` param merged as top-level siblings)
 * is unchanged.
 *
 * `success()`'s `extra` param: getNutritionTimeLineByDate's controller calls
 * `Responser.success(res, true, msg, items, 200, { total_pages, current_page })`
 * with `data` as the raw items ARRAY and pagination merged at the top level
 * as siblings, not nested inside `data`.
 */
const INTERNAL_RESPONSE_FIELDS = new Set([
  "created_by",
  "fibre_min_g",
  "fibre_target_g",
  "is_deleted",
  "nutrition_log_id",
  "org_id",
  "unix_timestamp",
  "user_nutrition_profiles_id",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

export function sanitizeApiData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeApiData);
  if (!isPlainObject(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (INTERNAL_RESPONSE_FIELDS.has(key)) continue;
    sanitized[key] = sanitizeApiData(childValue);
  }
  return sanitized;
}

class Responser {
  static success(
    res: Response,
    status: boolean,
    message: string,
    data: any = [],
    statusCode = 200,
    extra: Record<string, unknown> = {},
  ) {
    return res
      .status(statusCode)
      .json({ success: status, status_code: statusCode, message, data: sanitizeApiData(data ?? {}), ...extra });
  }

  static error(res: Response, status: boolean, error: any) {
    const isAppError = error instanceof AppError;
    const statusCode = (isAppError && error.statusCode) || 500;
    const errorData = isAppError ? error.data : undefined;

    // Same fallback chain as the real system's Responser.error: a specific
    // message if the caught value has one, else the generic fallback —
    // never lets `message` come out as literal `undefined` for a thrown
    // non-Error value (a plain string/object, which JS allows).
    const message =
      (isAppError && error.message) ||
      (error instanceof Error && error.message) ||
      ERROR_MESSAGE.GENERAL_ERROR;

    const responseData: any = { success: status, status_code: statusCode, message };
    // Null-safe, unlike the previous `typeof error.data === "object"` check
    // (typeof null === "object" in JS — that would have thrown inside
    // Object.keys(null) if any AppError were ever built with data: null;
    // latent, never actually hit since every current call site passes []).
    if (errorData !== undefined && errorData !== null && !(Array.isArray(errorData) && errorData.length === 0)) {
      responseData.data = sanitizeApiData(errorData);
    }
    return res.status(statusCode).json(responseData);
  }
}

export default Responser;

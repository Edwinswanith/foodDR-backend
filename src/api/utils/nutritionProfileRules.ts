import AppError from "../core/error-handler";

// Matches the existing SQL Server CK__users__birth_yea constraint.
export const MIN_BIRTH_YEAR = 1920;
export const MAX_BIRTH_YEAR = 2020;

export function nutritionAgeLimits() {
  const year = new Date().getUTCFullYear();
  return { minimum: Math.max(1, year - MAX_BIRTH_YEAR), maximum: Math.min(120, year - MIN_BIRTH_YEAR) };
}

export function validateNutritionAge(age: unknown): void {
  const { minimum, maximum } = nutritionAgeLimits();
  if (typeof age !== "number" || !Number.isInteger(age) || age < minimum || age > maximum) {
    throw new AppError(`Age must be a whole number between ${minimum} and ${maximum}.`, [], 400);
  }
}

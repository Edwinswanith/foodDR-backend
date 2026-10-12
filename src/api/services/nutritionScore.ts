/**
 * Health score composition — verbatim port of backend/app/services/score_service.py.
 * Phase 2: workout removed (info-only). Sleep removed in Phase 1.
 * Weights: nutrition 75 + consistency 25 = 100.
 */

const clamp = (v: number, low = 0, high = 1): number => Math.max(low, Math.min(high, v));

export function calorieAdherence(consumed: number, target: number): number {
  if (target <= 0) return 1;
  return clamp(1 - Math.abs(consumed - target) / target);
}

export function macroAdherence(consumed: number[], targets: number[]): number {
  const values: number[] = [];
  const len = Math.min(consumed.length, targets.length);
  for (let i = 0; i < len; i += 1) {
    const target = targets[i] ?? 0;
    const current = consumed[i] ?? 0;
    if (target <= 0) values.push(1);
    else values.push(clamp(1 - Math.abs(current - target) / target));
  }
  return values.length === 0 ? 1 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function mealScheduleCompletion(completedDue: number, dueCount: number): number {
  if (dueCount <= 0) return 1;
  return clamp(completedDue / dueCount);
}

export function nutritionScore(
  consumedCalories: number,
  calorieTarget: number,
  consumedMacros: number[],
  targetMacros: number[],
  completedDueSlots: number,
  dueSlots: number,
): number {
  return (
    0.5 * calorieAdherence(consumedCalories, calorieTarget) +
    0.3 * macroAdherence(consumedMacros, targetMacros) +
    0.2 * mealScheduleCompletion(completedDueSlots, dueSlots)
  );
}

export function consistencyScore(currentStreak: number, activeDaysLast7: number): number {
  const streakFactor = 0.7 * clamp(Math.min(currentStreak, 7) / 7);
  const activeFactor = 0.3 * clamp(activeDaysLast7 / 7);
  return streakFactor + activeFactor;
}

export type StatusPill = 'recover_today' | 'slightly_off' | 'on_track';

export function scoreToStatus(score: number, recoveryActive: boolean): StatusPill {
  if (recoveryActive || score < 45) return 'recover_today';
  if (score < 75) return 'slightly_off';
  return 'on_track';
}

export interface HealthScoreResult {
  health_score: number;
  status_pill: StatusPill;
  breakdown: { nutrition: number; consistency: number };
  ratios: { nutrition: number; consistency: number };
}

export function computeHealthScore(
  nutritionComponent: number,
  consistencyComponent: number,
  recoveryActive: boolean,
): HealthScoreResult {
  const nutritionPoints = Math.round(nutritionComponent * 75);
  const consistencyPoints = Math.round(consistencyComponent * 25);
  const total = Math.min(100, nutritionPoints + consistencyPoints);
  return {
    health_score: Math.trunc(total),
    status_pill: scoreToStatus(Math.trunc(total), recoveryActive),
    breakdown: { nutrition: nutritionPoints, consistency: consistencyPoints },
    ratios: { nutrition: nutritionComponent, consistency: consistencyComponent },
  };
}

export class ScoreService {
  calorieAdherence = calorieAdherence;
  macroAdherence = macroAdherence;
  mealScheduleCompletion = mealScheduleCompletion;
  nutritionScore = nutritionScore;
  consistencyScore = consistencyScore;
  scoreToStatus = scoreToStatus;
  computeHealthScore = computeHealthScore;
}

/** Module singleton — ScoreService takes no constructor arguments, so the composition
 * root does not need to build it. The class stays exported for tests that want
 * their own instance. */
export default new ScoreService();

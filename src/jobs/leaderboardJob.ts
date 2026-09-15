/**
 * LOCAL DEV STUB — all no-ops. startLeaderboardCron/startEodNotificationCron
 * are cron-gated (see challengeReminderJob.ts); processUserChallengeNotifications
 * and getUserIdByExternalId are also called directly from server.ts's
 * /test/challenge-notifications debug routes — kept as safe inert defaults
 * (no lookup, no notification) rather than guessing the real logic.
 */
export function startLeaderboardCron(): void {
  console.log("[stub] startLeaderboardCron — no-op, real job not present in this checkout");
}

export function startEodNotificationCron(): void {
  console.log("[stub] startEodNotificationCron — no-op, real job not present in this checkout");
}

export async function processUserChallengeNotifications(_userId: number, _bypass?: boolean): Promise<void> {
  console.log("[stub] processUserChallengeNotifications — no-op, real job not present in this checkout");
}

export async function getUserIdByExternalId(_externalId: string): Promise<number | null> {
  return null;
}

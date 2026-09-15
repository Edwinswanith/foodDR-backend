/**
 * LOCAL DEV STUB — no-op. Only started when config.enableWellnessCron
 * === "true" (default "false" in config/config.ts's dev stub), so this
 * never actually runs locally unless explicitly enabled.
 */
export function startChallengeReminderJob(): void {
  console.log("[stub] startChallengeReminderJob — no-op, real job not present in this checkout");
}

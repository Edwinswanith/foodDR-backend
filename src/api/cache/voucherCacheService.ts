/** LOCAL DEV STUB — no-ops. warmVoucherCache runs at boot; the refresh
 * functions are called unconditionally in server.ts (not cron-gated), but
 * doing nothing is safe — no cache means voucher endpoints (not present in
 * this checkout anyway) would just miss, not crash. */
export async function warmVoucherCache(): Promise<void> {
  console.log("[stub] warmVoucherCache — no-op, real service not present in this checkout");
}

export function startVoucherCacheRefresh(): void {
  // no-op
}

export function stopVoucherCacheRefresh(): void {
  // no-op
}

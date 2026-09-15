/**
 * LOCAL DEV STUB. `d1` is one half of the shared secret custom-auth.ts
 * bcrypt-compares against a client-sent `token` header, but only for routes
 * listed in EXCLUDE_APIS — none of the 3 nutrition routes are in that list,
 * so this value is never actually exercised by them. Placeholder only.
 */
export const d1 = process.env.CUSTOM_AUTH_D1 || "dev-local-d1-placeholder";

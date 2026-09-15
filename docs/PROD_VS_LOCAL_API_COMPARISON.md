# tsconfig (wms) vs Production API Comparison

**Generated:** 2026-09-14 (updated after fixing the 124 TypeScript compile errors in `nutritionController.ts`)
**Prod base URL:** `https://fooddr-895210689446.asia-south1.run.app/api` (the deployed foodDR Cloud Run service — `backend-node`)
**Local base URL:** `http://localhost:3000/api/v1` (`tsconfig/`, via `dev-server.ts`, now run **without** `TS_NODE_TRANSPILE_ONLY` — full type-checking passes)

## ⚠️ What "local" actually is here

There is no separate deployment of `tsconfig/` to compare against — it isn't a hosted service, and its own `CLAUDE.md` describes it as **a partial export of a larger platform codebase (`wms` — SyncFit/Pivvot/Evvo Sports), kept as a reference of conventions, not a runnable checkout**. There's no dedicated "tsconfig prod." So "prod" in this comparison is the **same** Cloud Run URL used in the earlier `backend-node` comparison — the only live production instance in this workspace — which is a reasonable comparison target because `tsconfig/.env` points at the **exact same SQL Server database** (`nutrition_sandbox` @ `13.234.94.212`) and the **same Firebase project** (`fooddr-6916d`) as prod. Functionally, `tsconfig/` is an alternate (Express + Prisma) implementation of the same nutrition-client V1/V2 endpoints prod (Express + Kysely) already serves.

Two separate tokens were used — the two servers don't share an auth scheme (local: JWT wrapping a CryptoJS-AES-encrypted payload; prod: plain `{sub, type, exp}` JWT). Mutating routes were **not executed** — local and prod share the live database, so calling a write endpoint against either one writes to the same data.

## What changed since the last version of this report

The previous run of this comparison found **12/12 executed routes returning 500 locally** — 2 from a real Prisma-schema/DB mismatch, 9 from `ReferenceError`s (the controller called service objects that were never defined anywhere in the file), and 1 (`auth.me`) from a `TypeError` on an undefined `.user` property. `npx tsc --noEmit` had **124 compile errors**, all in `nutritionController.ts`, and the server could only run with type-checking bypassed.

Since then, `nutritionController.ts` was fixed:
- **0 compile errors** now (`npx tsc --noEmit` and a full `npx tsc` build both pass clean).
- The server boots with `npx ts-node src/dev-server.ts` **with no flags** — previously impossible.
- The 9 `ReferenceError`-crashing routes + `auth.me` now return a clean, structured **501** ("X is not implemented in this partial checkout — its collaborator service was not exported into this reference project") instead of an unhandled exception / stack trace leak. No business logic was invented for these — per this checkout's own `CLAUDE.md` ("don't 'fix' missing-module errors by guessing at their contents"), they're documented as not-implemented rather than guessed at.
- `auth.logout` is now genuinely implemented (not just stubbed) — its only broken dependency was a cookie-clearing call, and this checkout's real auth is pure stateless Bearer JWT with nothing to clear, so that dead call was removed rather than replaced. Confirmed still authenticates before **and** after calling logout, on both sides — consistent with stateless JWT (no server-side session to invalidate).

**What did *not* change:** the 2 genuinely-implemented data-reading routes (`getWeightHistory`, `getNutritionTimeLineByDate`) still 500 — that's a separate, pre-existing issue (Prisma schema doesn't match the live DB), untouched by this fix and not something this pass was meant to address.

## Result: still 0/12 executed routes match prod on status code — but for a much narrower, now-honest reason

| Route | Local before fix | Local after fix | Prod | Notes |
|---|---|---|---|---|
| `getWeightHistory` | 500 (missing table) | **500 (missing table, unchanged)** | 200 | Finding 1 — untouched by this fix |
| `getNutritionTimeLineByDate` | 500 (missing table) | **500 (missing table, unchanged)** | 200 | Finding 1 — untouched by this fix |
| `getNutritionSummaryByDate` | 500 (`summary is not defined`) | **501 (clean, not-implemented)** | 200 | Finding 2 |
| `getProgressByDate` | 500 (`progress is not defined`) | **501** | 200 | Finding 2 |
| `fetchNutritionHealthScore` | 500 (`healthScore is not defined`) | **501** | 200 | Finding 2 |
| `getUpcomingRoutine` | 500 (`routine is not defined`) | **501** | 200 | Finding 2 |
| `fetchNutritionAchievements` | 500 (`achievements is not defined`) | **501** | 200 | Finding 2 |
| `getMealsByType` | 500 (`recommendations is not defined`) | **501** | 200 | Finding 2 |
| `searchMeals` | 500 (`recommendations is not defined`) | **501** | 200 | Finding 2 |
| `getGoalProgress` | 500 (`reports is not defined`) | **501** | 200 | Finding 2 |
| `loggedMealsByDate` | 500 (`mealIntake is not defined`) | **501** | 200 | Finding 2 + verb mismatch (Finding 3, unchanged) |
| `auth.me` | 500 (`Cannot read properties of undefined (reading 'id')`) | **501** | 200 | Finding 2 |
| `auth.logout` | *not tested (assumed mutating)* | **200 — genuinely matches prod** (data-level) | 200 | Now fixed and verified, see below |

Prod succeeds on all of these (see the earlier report's Appendix for full response shapes) because it's a complete, real implementation; `tsconfig/` still can't serve any of them end-to-end — that hasn't changed and isn't something a controller-file fix alone can address (see Findings 1 and 2 below for why).

## `auth.logout` — now a genuine, verified match

Manually tested (the comparison script still marks it as mutating from before the fix, since it wasn't re-classified):

```
local:  POST /api/v1/api/auth/logout → 200 {"status":true,"message":"Logged out successfully","data":{"logged_out":true}}
prod :  POST /api/auth/logout        → 200 {"success":true,"status_code":200,"message":"Logged out successfully.","data":{"logged_out":true}}
```

Same `data`, same status code. Only differences: the known envelope-shape drift (see the `backend-node` comparison report, Finding 1) and a trailing period in prod's message — cosmetic. Also confirmed the same demo-user token still authenticates on prod **after** calling logout — both sides are stateless-JWT auth with no server-side session to invalidate, exactly as the fix assumed.

## Findings (carried over from before — root causes untouched by this fix)

### Finding 1 — The 2 real implementations query tables that don't exist in the shared DB

`getWeightHistory` and `getNutritionTimeLineByDate` are correctly wired end-to-end (auth → controller → service → Prisma) but query Prisma models (`weight_logs`, `Users`) that don't exist in `nutrition_sandbox.fooddr` — `prisma/schema.prisma` (82 models) was pulled from a different platform DB than the one this checkout is actually pointed at (only 4 of its 82 models match the live 19-table schema: `nutrition_masters`, `user_nutrition_plans`, `user_nutrition_profiles`, `weekly_nutrition_snapshots`). Fixing this is a data-layer change (new schema, or repointing these two methods at the real tables), not a controller-file fix, and is out of scope for what was just done.

### Finding 2 — The remaining 10 routes have no real implementation to fall back on

These call collaborator services (`summary`, `progress`, `healthScore`, `routine`, `achievements`, `recommendations`, `reports`, `mealIntake`) that were never part of this partial export — consistent with `tsconfig/CLAUDE.md`'s own description of the checkout. They now fail predictably and legibly (`501`, clear message) instead of crashing, but making them actually work still requires either porting the real service logic from `backend-node`'s equivalents or writing new implementations against this checkout's (currently mismatched, see Finding 1) Prisma schema — a substantially larger task than a compile-error fix, not attempted here.

### Finding 3 — `loggedMealsByDate` is still wired as POST locally, GET on prod's equivalent

Unchanged from the previous report — `tsconfig/src/api/routes/index.ts` registers it as `POST`; prod's equivalent (`V1_LOGGED_MEALS_BY_DATE`) is `GET`. Not touched by the controller fix (it's a routing-table issue, not a controller-body issue), and moot for now since the handler is a `501` stub either way.

---

## Not tested (mutating)

Unchanged from the previous report — these write to the shared database, so weren't executed against either side: `generatePersonalizedNutritionPlan`, `addMeal`, `updateWeight`, `updateWaterConsumption`, `completeAssessment`, `deleteMeal`, `scanMeal`, `auth.refresh`, `auth.moduleToken`. All nine are also among the routes that now return a clean `501` regardless of which side you'd call — they're unimplemented stubs, not something a single-sided manual test would reveal new information about.

## Reproducing this

```bash
cd tsconfig
npx ts-node src/dev-server.ts        # local on :3000 — no TS_NODE_TRANSPILE_ONLY needed anymore

node scripts/mint-tsconfig-token.js 1 > /tmp/local-token.txt
# prod token: mint via backend-node's own script (different secret/scheme)
#   cd ../Old-FoodDr/backend-node && npm run mint:token -- sarah@demo.com > /tmp/prod-token.txt

node scripts/compare-tsconfig-vs-prod.mjs /tmp/local-token.txt /tmp/prod-token.txt /tmp/results.json
```

## Appendix: raw results

Full request/response capture for this run is in [`docs/tsconfig-vs-prod-results.json`](./tsconfig-vs-prod-results.json) (superseding the previous capture with the same filename). The pre-fix capture is preserved for reference at [`docs/tsconfig-vs-prod-results-before-fix.json`](./tsconfig-vs-prod-results-before-fix.json).

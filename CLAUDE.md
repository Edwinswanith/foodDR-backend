# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is a **partial export** of a larger Express + TypeScript backend (`package.json` name: `wms`) for a corporate wellness / sports platform (branding references in the code: SyncFit, Pivvot, Evvo Sports). Only a slice of the real codebase is present here — `src/server.ts` and several files under `src/api/` `import` from modules (`./config/*`, `./jobs/*`, `./api/queues/*`, `./api/cache/*`, `./api/notifyListener/*`, `./api/lib/crash-proof-system`, most of `./api/controller/*`, most of `./api/services/*`, `./api/utils/*`) that **do not exist in this directory**. Treat this as a reference/sample of conventions, not a runnable checkout — don't "fix" missing-module errors by guessing at their contents; ask for the missing files if a task requires them.

What *is* present: `src/server.ts`, the Prisma schema, and the `src/api/{constants,controller,core,interface,middleware,routes,services,validations}` folders (only `authController.ts` / `authControllerService.ts` are included as controller/service examples).

## Commands

All scripts are run from the project root (`npm run <script>`).

- `npm run prisma:setup` — runs `src/prisma-setup.ts` before every other Prisma command (not present in this checkout).
- `npm run prisma:generate` — generate the Prisma client for the default (SQL Server) schema at `prisma/schema.prisma`.
- `npm run prisma:generate2` — generate the client for the second schema at `./prisma-postgres/schema.prisma` (Postgres — not present in this checkout).
- `npm run prisma:migrate` / `prisma:push` / `prisma:pull` / `prisma:studio` / `prisma:reset` / `prisma:deploy` — standard Prisma workflows against the SQL Server schema; suffix `2` targets the Postgres schema.
- `npm run dev` — run the server with `nodemon` + `ts-node` against `src/server.ts` (`nodemon.json`, not present here, controls the watch config).
- `npm run build` — clean `dist/` and compile with `tsc`.
- `npm run start:dev` — clean build, `tsc -w` plus `nodemon` on the compiled output.
- `npm run start` / `npm run deploy` — run the compiled server from `dist/server.js`.
- `npm test` — `jest --coverage` (lcov reporter, configured inline in `package.json`).
- `npm run seed` — `ts-node src/seedData/seed.ts` (seed script not present in this checkout).

There's no lint script wired up in `package.json` despite `eslint`/`typescript-eslint` being devDependencies.

## Architecture

### Startup sequence (`src/server.ts`)

The server does **not** import config/DB/route modules at the top of the file. Startup is sequenced deliberately inside an async `startServer()`:

1. `loadSecrets()` from AWS Secrets Manager runs first and must succeed (`areSecretsLoaded()` is checked) before anything else.
2. Only after secrets are loaded does the file dynamically `await import(...)` everything that depends on config/env — routes, Prisma clients, cron jobs, queues, session store, etc. This ordering matters: any new top-level (non-dynamic) import that touches `config/config` will break the "secrets first" guarantee.
3. Background job/queue initialization (`sahhaQueue`, `smartRingQueue`) is gated on `config.redisUrl && NODE_ENV === 'production'`; locally these are skipped.
4. Cron jobs (challenge reminders, leaderboard, wellness prompts, xoxoday token refresh, event reminders, voucher cache refresh) only start if `config.enableWellnessCron === "true"`.

### Dual database access

Two separate persistence paths are used side by side for the same SQL Server database:

- **Prisma** — two generated clients, exported from `src/server.ts`: `prismaSqlServer` (schema at `prisma/schema.prisma`, provider `sqlserver`) and `prismaPostgres` (second schema, Postgres). Services import a scoped client, e.g. `import prisma from "../../config/sqlServerClient"`.
- **Raw `mssql` pool** — despite the name, `connectToMySQLDatabase()` (from `./config/mysqlConnection`) returns an SQL Server connection pool (via `mssql`/`tedious`), used for hand-written parameterized queries (`pool.request().input(...).query(...)`). This is the dominant pattern in `authControllerService.ts` for anything beyond simple CRUD — pagination queries, multi-table joins, dynamic filters — because Prisma's SQL Server support doesn't cover everything needed. Always bind values with `request.input(name, value)` / `@name` placeholders; never string-interpolate untrusted input into these queries (some legacy methods in this file do interpolate directly — don't copy that pattern in new code).

### Request pipeline

Registered in `src/api/routes/index.ts`, mounted at `/api/v1` in `server.ts`:

1. `customAuth.customAuthMiddleware` (global) — for routes listed in `EXCLUDE_APIS` (`src/api/constants/index.ts`), requires a static `token` header that bcrypt-compares against a hardcoded app secret (`d1 + d2` from `src/api/utils/connection` / `exception`, not present here). All other routes pass through untouched by this middleware.
2. `validationRequest.validation` (global) — looks up the current route in a `Map<ROUTE, AjvSchema>` built in `src/api/middleware/validationRequest.ts` and runs the matching AJV schema (`ajv` + `ajv-errors`) against `req.body`. Routes not in the map, or explicitly listed in `routesThatSkipValidation`, pass through unvalidated. **When adding a new route with a request body, register its schema in that Map** (or add it to the skip-list only if it genuinely has no body to validate).
3. Per-route `auth.verifyJwt` (`src/api/middleware/auth.ts`, exported as `Authentication`) — applied selectively at the route-definition level, not globally. Verifies the JWT, decrypts the AES-encrypted payload (`decryptPayload`, key from `config.cryptoPayloadSecretKey`), and enforces device/session rules: single-active-device checks for wearables and mobile, invite-code expiry, refresh-vs-access token type. On success it stashes `userId`/`authUserId`/`orgId` onto `req.body` for controllers to read — controllers pull the authenticated user id from the body, not from a separate `req.user`.

### Routing conventions

- All route paths live as string enum members on `ROUTE` in `src/api/constants/index.ts` — never hardcode a path string in a router or in the validation Map; add a `ROUTE` member and reference it everywhere (route registration, the validation Map key, `EXCLUDE_APIS`/skip-lists).
- User-facing strings are centralized the same way: `SUCCESS_MESSAGES` and `ERROR_MESSAGE` enums in the same file. Controllers throw `AppError(ERROR_MESSAGE.X, data, statusCode)` and respond with `Responser.success(res, true, SUCCESS_MESSAGES.X, data, statusCode)`.

### Response/error conventions

- `src/api/core/responser.ts` (`Responser`) is the only place that shapes HTTP JSON responses: `Responser.success(res, status, message, data, statusCode)` and `Responser.error(res, status, error)`. Controllers should always route through these rather than calling `res.json`/`res.status` directly.
- `src/api/core/error-handler.ts` (`AppError`) is the thrown-error type controllers/services use: `new AppError(message, data, statusCode)`. If `statusCode` is left at the 500 default, the message is overwritten with `ERROR_MESSAGE.GENERAL_ERROR` regardless of what was passed — don't rely on a custom message surviving on an unhandled/500 error; give it an explicit non-500 status if the message matters.
- Controller methods follow a consistent try/catch shape: do the work, log via `logsService.getPayloadInput(...)` + `logsService.createLog(...)` (both on success and failure paths), then respond via `Responser`. Follow this shape for new controller methods for consistency, even though `logsService` isn't included in this checkout.

### Validation and typing

- Request schemas are hand-written AJV JSON Schemas per module in `src/api/validations/*.validation.ts`, imported into the central Map in `validationRequest.ts`.
- Request/response shapes also get a parallel hand-written TypeScript interface per module in `src/api/interface/*.interface.ts` (e.g. `CreateUserReq`, `GetUserReq` in `auth.Interface.ts`), imported into controllers for `req.body` typing. When adding a field to a validation schema, add/update the matching interface too — they aren't generated from each other.

### Prisma schema shape (`prisma/schema.prisma`)

- Single SQL Server datasource, `@@map`/`map:` used extensively because table/constraint names were reverse-engineered from an existing DB (`db pull`), not modeled fresh — expect inconsistent casing across models (`Users.userId` vs `activity.user_id`, `Teams` vs `challenge_results`, etc.). Match whatever casing convention the specific table already uses; don't normalize it as part of an unrelated change.
- Soft deletes are the norm (`isDeleted` / `is_deleted` boolean columns) — don't hard-delete rows; filter them out in queries instead. A few models are explicitly `@@ignore`d (`TrainingCountData`, `TrainingLocationData`, `TrainingCountDataLive`) because they lack a usable unique identifier for Prisma; access those via the raw `mssql` pool, not Prisma.
- Domain areas modeled: users/roles/org multi-tenancy (`Users`, `Organization`, `Roles`, `Role_Module_Mapping`, `Multiple_Roles_Table`), training/attendance (`Trainings`, `RecurringTrainings`, `user_training_mapping`), challenges/leaderboard/vouchers (`Challenge`, `challenge_results`, `challenge_voucher_mapping`, `voucher_master`, `xoxoday_token`), wellness (`wellness_tips`, `WellnessPromptRule`/`WellnessPromptLog`, `health_metrics`), social/clubs (`clubs`, `club_posts`, `activity`, `activity_post_likes/comments`), and device/wearable integration (`Devices`, `FCM_Tokens`, `wearableAppTokens`, `SahhaDetails`).

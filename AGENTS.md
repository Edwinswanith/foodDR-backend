# Repository Guidelines

## Project Structure & Module Organization

This TypeScript/Express nutrition backend is a partial wellness-platform export. `src/api/` separates routes, controllers, services, middleware, validations, interfaces, and utilities. Keep business logic in services and HTTP handling in controllers.

`src/dev-server.ts` runs the nutrition API locally; `src/server.ts` is the broader platform entrypoint. Vercel uses `api/index.ts` and `src/vercelApp.ts`. Database configuration lives in `src/config/`, with the SQL Server Prisma schema in `prisma/schema.prisma`. `assets/` contains the demo meal image; `postman/`, `scripts/`, and `docs/` hold API collections, comparison utilities, and historical reports.

## Build, Test, and Development Commands

Use Node.js 24.x; run commands from the repository root:

- `npm ci`: install dependencies from the lockfile.
- `npm start` or `npm run dev:nutrition`: run the nutrition server with automatic restarts. The default port is 3000; `/health` checks startup, and routes mount under `/api/v1`.
- `npm run tsc -- --noEmit`: check TypeScript without generating output.
- `npm run build`: clean `dist/` and compile TypeScript.
- `npm test`: run Jest with LCOV coverage reporting.

This is a partial checkout: legacy scripts reference missing files, including `nodemon.json`, `src/prisma-setup.ts`, and the seed script. Do not invent replacement modules to silence build errors. Check current source before following older `CLAUDE.md` or comparison-report examples.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, and the surrounding file's quote style. Use camelCase for functions and variables, PascalCase for classes and interfaces, and existing suffixes such as `*.interface.ts` and `*.validation.ts`. ESLint dependencies exist, but no lint script or formatter configuration is provided.

Register routes through `ROUTE` and `routePath`; update AJV schemas and TypeScript interfaces together. Use `Responser` and `AppError` for controller responses and errors. Bind SQL parameters instead of interpolating input.

## Testing Guidelines

No tests or coverage threshold are checked in. Jest is configured, but TypeScript transformation is not; configure it before adding TypeScript tests. Prefer `*.test.ts` names and mock external services. Use the Postman collection for endpoint checks; verify historical comparison fixtures against current routes before reuse.

## Commit & Pull Request Guidelines

Follow recent imperative commit subjects, such as `Fix daily stats workout status default`. Keep commits focused. PRs should describe the behavior change, link relevant issues, list validation performed and blockers, and include request/response examples for API changes.

## Security & Configuration

Keep credentials in ignored `.env` files. Never commit tokens or sensitive response captures. Confirm database targets before migrations or mutating endpoint checks; historical documentation describes shared production data.

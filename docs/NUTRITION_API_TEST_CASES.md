# Nutrition API regression cases

Scope: this Vercel project. IDs refer to `Nutrition API Testing.csv`.

## Run automated route tests

From `vercel/`, using Node.js 24 and installed dependencies:

```bash
npm run test:nutrition
npm run tsc -- --noEmit
```

The tests send HTTP requests through the actual Express routes, validation,
controllers and services. Authentication, database, logging and AI dependencies
are mocked. They do not contact a deployment or shared database. They verify
response codes, response content, mutation effects and rejected-request writes.
Authentication, database transactions and AI classification need integration QA.

## Test cases

Use a dedicated QA account with an active nutrition plan. For cases requiring
historical dates or stored weights, prepare fixtures in an isolated test database.
Dates and weekly boundaries use the profile's timezone; date-only database values
retain their calendar date rather than being shifted by UTC offsets.

| Bug | API / scenario | Expected result | Coverage |
| --- | --- | --- | --- |
| 1, 5, 6, 7 | Generate plan using `birthYear`, legacy height/weight fields, `Pound`, `goalWeight`, aggressiveness and body-fat percentage | 200; units converted; target and legacy profile values saved | Automated |
| 2 | Generate plan with age 0, -1, 121, 20.5, boolean, null or nonnumeric text | 400 before database writes, clear age error | Automated |
| 3 | Height 0 or 11 feet; 49, 49.9, 300.1 or 301 cm; nonnumeric height | 400 before writes; rounding cannot admit an out-of-range height | Automated |
| 4 | Weight 0, negative, nonnumeric, below 30 kg or above 300 kg, including values just beyond bounds | 400 before saving; no Prisma overflow message | Automated |
| 8 | Water 0, negative or nonnumeric | 400 and no write | Automated |
| 8 | Existing water 10,500 ml; add 600 ml | 400; message states 500 ml remaining | Automated |
| 9 | Upload a non-food photo, an unclear food photo, then a clear food photo | Distinct non-food/unclear-food responses; recognized food saved only for valid food | Manual AI integration |
| 10, 11 | Update 70 kg to 71 kg exactly seven calendar days after last update | 200; updated plan and confirmation returned | Automated |
| 11 | Repeat update same day, next day, or day six | 409: once per week; no writes | Automated |
| 11 | Negative UTC-offset profile with last update six local dates ago | 409; date-only value must not shift to the previous date | Automated |
| 12 | Change 70 kg to 66.99 or 73.01, even when weekly lock also applies | 400 with 3 kg limit message; no writes | Automated |
| 12 | Change 70 kg to exactly 67 or 73 after seven days | 200 | Automated |
| 12 | Update using `lbs`; repeat with unsupported `stone` | Pounds converted correctly; unsupported unit rejected | Automated |
| 13, 16 | Fetch health score for 7/30/90 days and summary before/after meal changes | Both use the reference 75/25 formula, include today and ignore stale stored scores | Automated |
| 14 | Read a group for October 5, 2026 | `date` and historical `label`: `05-10-2026`; no `date_iso` field | Automated |
| 15 | Log 200 ml then 300 ml; fetch timeline | Two separate water entries | Automated |
| 17 | Fetch report, add a meal reaching target, fetch again, delete meal and fetch again | Current date changes to `completed`, then `not_logged`; responses use `private, no-store` | Automated |
| 16–18 | Save/delete in the app without manually refreshing | Frontend refetches affected queries; updated response displayed | Frontend integration needed |
| 18 | Add first meal, fetch achievements, delete meal, fetch again | First-meal badge and points appear then disappear | Automated |
| 18 | Stored first-meal badge has no remaining meal; unrelated weight badge exists | Obsolete meal badge removed from response; weight badge retained | Automated |
| 18 | Qualifying meal older than 30 days | Historical first-meal badge remains earned | Automated |
| 18 | Two meals each day on three consecutive dates; remove one qualifying meal | Meal-streak badge unlocked then revoked | Automated |
| 18 | Hit plan water target | Hydration badge unlocked on next GET | Automated |
| 18 | Two meals total the calorie target and water target is met, despite stale stored meal totals | Perfect-day badge earned from live meals; deletion removes it if no other date qualifies | Automated |
| 19 | Gain target below/equal current weight; loss target above/equal current weight; maintain target different | 400 before writes | Automated |
| 19 | Gain target above, loss below, maintain equal | 200 | Automated |
| 20 | Time authenticated GET requests on the intended deployment, first and repeated requests | Each successful response under 5,000 ms; also test concurrent traffic separately | Deployment smoke script; not measured locally |
| 21 | Reports for 7/30/90 days: past partial, no log, target reached | `incomplete`, `not_completed`, `completed` respectively | Automated |
| 22 | Today without meals, with partial meals, then target reached | `not_logged`, `in_progress`, `completed` respectively | Automated |
| 23 | Search `chai` when a catalogue row has that alias | Matching meal returned without AI fallback | Automated |
| 23 | Search the product-approved list of meal varieties | Required entries exist with verified nutrition and serving units | Catalogue data required; no fabricated entries added |
| 24 | Delete a previous-date meal | 400; meal unchanged | Automated |
| 24 | Delete today's own meal / nonexistent or another user's meal | 200 / 404 | Automated |

## Deployment smoke checks

The script makes GET requests only and reports HTTP status, elapsed time and
cache headers. It does not prove score calculations, catalogue completeness,
authentication security or frontend refresh behavior. Prepare an account with
logged meals and an active plan so empty-data 404 responses are not mistaken for
regressions. First requests are not guaranteed to be cold starts.

Set environment variables through your normal secret manager or shell setup:

- `NUTRITION_API_BASE_URL`: the explicit deployment origin, no trailing API path.
- `NUTRITION_API_HEADERS`: JSON object containing the deployment's required auth headers.
- `NUTRITION_API_DATE`: optional date in `YYYY-MM-DD` (defaults to today in Asia/Kolkata).
- `NUTRITION_API_TIMEZONE`: optional timezone for the default date.
- `NUTRITION_API_BUDGET_MS`: optional response budget, default 5000.

```bash
node scripts/nutrition-api-smoke.mjs
```

Exit code 1 means a request failed the status, freshness or timing check. Header
values and response bodies are never printed. Live checks were not run as part
of the local regression suite.

## Remaining decisions and limitations

- Age is an integer whose calculated birth year must satisfy the existing database
  constraint of 1920–2020 (ages 6–106 in 2026, within the API's 1–120 outer bounds).
  Legacy birth-year inputs use the same constraint. Numeric strings are accepted;
  booleans, arrays, hexadecimal and scientific-notation strings are rejected.
  Height remains 50–300 cm and is checked before rounding. Feet input is decimal
  feet: 5.7 ft means 5.7 × 30.48 cm, not 5 feet 7 inches. Malformed numeric inputs
  are rejected, and feet range errors explain the cm limit and approximate ft
  equivalent. Route capitalization and trailing slashes cannot bypass validation.
- Health scoring now reuses the reference backend's `scoreService.ts` formula:
  nutrition = 75 × (50% calorie adherence + 30% macro adherence + 20% due-meal
  completion); consistency = 25 × (70% capped streak / 7 + 30% active days / 7).
  Components round independently. A logged meal makes a day active; missed days
  pause the streak. Both APIs calculate from nondeleted meals on each GET.
  Historical calorie/macro targets use daily_stats when available and otherwise
  fall back to the current active plan. Historical meal schedules are not stored
  per day here, so scoring uses the active plan's schedule.
- Meal, hydration and perfect-day achievements are derived on GET from all
  available nondeleted history. Generic activity-streak, weight and comeback
  badges retain their stored state; their awarding/revocation rules are not
  supplied in this checkout. Historical water targets fall back to the active
  plan because historical per-day water targets are not stored here.
- Automatic app updates still require client-side query refetch/invalidation.
  `no-store` prevents stale HTTP caching; it does not push new data to a screen.
- Search now includes aliases and its AI fallback has a 2-second timeout.
  This is not a verified all-endpoint latency fix. Missing catalogue foods need
  approved data; database contents were not changed.
- Logged-meal `date` uses `DD-MM-YYYY`; historical labels use the same format,
  with `Today`/`Yesterday` retained. The response omits `date_iso`.
  Request date parameters and `logged_at` timestamps remain ISO.

## Goal progress report statuses

The same rules apply to `days=7`, `days=30` and `days=90`. Dates are grouped
in the user's profile timezone. Only non-deleted meal logs count; stale
`daily_stats` totals do not count as an existing meal log.

| Date | Actual meal records | API status | Display text |
| --- | --- | --- | --- |
| Today | No active logs | `not_logged` | Not Logged |
| Today | Logged below the day's calorie target | `in_progress` | In Progress |
| Past | No active logs | `not_completed` | Not Completed |
| Past | Logged below the day's calorie target | `incomplete` | Incomplete |
| Any | Logged and reached the day's calorie target | `completed` | Completed |

A zero-calorie log still counts as a log. If no positive calorie target is
available, a logged day remains partial. Completion compares the actual total
without rounding (1999.6 kcal against 2000 kcal remains partial). Historical
SQL DATE target keys retain their UTC calendar date to avoid a server-timezone
shift. Regression tests cover all windows, deleted logs, stale totals, zero
calories, fractional totals and historical targets in a negative UTC offset.

## Global dish-name search suggestions

`GET /api/v2/meals/search?meal_type=lunch&query=tea&limit=10` now merges
existing database catalogue foods with all 500,000 names supplied in
`500000_Global_Food_Dishes.docx`. Exact names rank first, then name prefixes,
word matches and substrings. For example, Tea ranks ahead of Steamed Dumplings.
Catalogue alias matches remain supported; catalogue records take precedence
over document suggestions with the same name. The limit defaults to 10 and is
capped at 50. Search remains cross-category, so drinks can be found at lunch.

The document supplies names only, including unverified combinations. It does
not supply serving sizes, recipes or nutrition. These results use the selected
meal type as their logging context, not as a verified food classification:

```json
{
  "meal_type": "Lunch",
  "meal_name": "Accra Tea",
  "time": null,
  "description": ["Accra Tea"],
  "nutrition": null,
  "nutrition_status": "unavailable",
  "requires_nutrition_input": true,
  "serving_unit": null,
  "dominant_nutrient": null,
  "meal_recommendation": null,
  "source": "document"
}
```

Clients must handle nullable nutrition, show “Nutrition unavailable”, and
request manual nutrition entry before logging a document suggestion. Do not
display zeros or a nutritional rating for these items. Existing catalogue
results retain their numeric nutrition and response structure. A type-3
catalogue log of a name-only suggestion returns HTTP 400 with a message directing
the client to manual meal entry (type 1). No database foods are inserted and no
existing nutrition is overwritten.

The compressed asset is included by Vercel's existing `assets/**` packaging.
Regenerate it with `python scripts/import-food-name-suggestions.py /path/to/500000_Global_Food_Dishes.docx`.
The adjacent manifest records source and asset SHA-256 checksums and name counts.

Automated coverage verifies all 500,000 unique names, asset checksum, case-insensitive
search, relevance ranking, limits, empty/no-match queries, missing nutrition,
database precedence, aliases and rejection of logging without nutrition.
Frontend integration still needs to verify rendering and manual-entry selection.

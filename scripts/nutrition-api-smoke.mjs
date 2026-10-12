// Explicitly targeted GET-only deployment checks. Never prints auth headers.
const base = process.env.NUTRITION_API_BASE_URL;
if (!base) throw new Error('Set NUTRITION_API_BASE_URL to the deployment to test.');
const url = new URL(base);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
  throw new Error('Use an HTTP(S) base URL without embedded credentials.');
}
const headers = JSON.parse(process.env.NUTRITION_API_HEADERS || '{}');
const budgetMs = Number(process.env.NUTRITION_API_BUDGET_MS || 5000);
if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('NUTRITION_API_BUDGET_MS must be positive.');
const date = process.env.NUTRITION_API_DATE || new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.NUTRITION_API_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('NUTRITION_API_DATE must be YYYY-MM-DD.');
const paths = [
  '/api/v2/fetchNutritionHealthScore?range=7',
  '/api/v2/fetchNutritionHealthScore?range=30',
  `/api/v2/getNutritionSummaryByDate?date=${date}&page=1&limit=30`,
  `/api/v2/getNutritionTimeLineByDate?date=${date}&page=1&limit=30`,
  '/api/v2/fetchNutritionAchievements',
  ...[7, 30, 90].map(days => `/api/v2/reports/goal-progress?days=${days}`),
  '/api/v2/meals/search?query=tea&limit=10',
  '/api/loggedMealsByDate?page=1&limit=10',
];
let failures = 0;
for (const path of paths) {
  // Measure a first and repeat request; neither guarantees a cold start.
  for (const attempt of [1, 2]) {
    const started = performance.now();
    try {
      const response = await fetch(base.replace(/\/$/, '') + path, {
        headers, redirect: 'error', signal: AbortSignal.timeout(Math.max(10000, budgetMs * 2)),
      });
      const body = await response.json();
      const elapsedMs = Math.round(performance.now() - started);
      const fresh = response.headers.get('cache-control')?.includes('no-store') === true;
      const passed = response.status === 200 && body.status === true && elapsedMs < budgetMs && fresh;
      if (!passed) failures += 1;
      const serverTiming = response.headers.get('server-timing');
      const region = response.headers.get('x-vercel-id')?.split('::').slice(0, -1).join('::');
      console.log(JSON.stringify({ path, attempt, status: response.status, elapsedMs, serverTiming, region, noStore: fresh, passed }));
    } catch {
      failures += 1;
      console.log(JSON.stringify({ path, attempt, passed: false, error: 'Request failed, timed out, redirected, or returned non-JSON.' }));
    }
  }
}
process.exitCode = failures ? 1 : 0;

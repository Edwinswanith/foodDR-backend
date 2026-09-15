// Compares the `tsconfig/` (wms) local checkout against the deployed
// foodDR Cloud Run instance (prod), route-by-route. Unlike the earlier
// backend-node vs prod comparison, this pair does NOT share a route table or
// an auth scheme:
//   - tsconfig/dev-server.ts mounts nutrition routes at /api/v1, and the
//     ROUTE enum values themselves already start with "/api/..." -> every
//     effective local path is doubled: /api/v1/api/v2/getWeightHistory etc.
//   - tsconfig's JWT wraps a CryptoJS-AES-encrypted payload; prod's JWT is a
//     plain {sub,type,exp} token. Different secrets, different shape -> two
//     separate tokens, one per side.
// So each case carries its own localPath/prodPath and the two calls use
// different bearer tokens.

import { readFileSync, writeFileSync } from 'fs';

const PROD = 'https://fooddr-895210689446.asia-south1.run.app/api';
const LOCAL = 'http://localhost:3000/api/v1';
const LOCAL_TOKEN = readFileSync(process.argv[2], 'utf-8').trim();
const PROD_TOKEN = readFileSync(process.argv[3], 'utf-8').trim();
const TODAY = '2026-09-14';

const LOCAL_AUTH = { authorization: `Bearer ${LOCAL_TOKEN}` };
const PROD_AUTH = { authorization: `Bearer ${PROD_TOKEN}` };

// executed: false => not called (mutating); still recorded with the mapped
// paths so the report can list route-table coverage without hitting it.
const CASES = [
  { label: 'generatePersonalizedNutritionPlan', method: 'POST', localPath: '/api/v2/generatePersonalizedNutritionPlan', prodPath: '/v2/generatePersonalizedNutritionPlan', executed: false, reason: 'mutating (writes a plan) — shared DB with prod' },
  { label: 'getWeightHistory', method: 'GET', localPath: '/api/v2/getWeightHistory?page=1&limit=10', prodPath: '/v2/getWeightHistory?page=1&limit=10', executed: true },
  { label: 'getNutritionTimeLineByDate', method: 'GET', localPath: `/api/v2/getNutritionTimeLineByDate?date=${TODAY}&page=1&limit=30`, prodPath: `/v2/getNutritionTimeLineByDate?date=${TODAY}&page=1&limit=30`, executed: true },
  { label: 'addMeal', method: 'POST', localPath: '/api/v2/addMeal', prodPath: '/v2/addMeal', executed: false, reason: 'mutating (writes a meal log)' },
  { label: 'updateWeight', method: 'POST', localPath: '/api/v2/updateWeight', prodPath: '/v2/updateWeight', executed: false, reason: 'mutating (writes a weight log)' },
  { label: 'getNutritionSummaryByDate', method: 'GET', localPath: `/api/v2/getNutritionSummaryByDate?date=${TODAY}&page=1&limit=30`, prodPath: `/v2/getNutritionSummaryByDate?date=${TODAY}&page=1&limit=30`, executed: true },
  { label: 'getProgressByDate', method: 'GET', localPath: `/api/v2/getProgressByDate?date=${TODAY}&include_benefits=false`, prodPath: `/v2/getProgressByDate?date=${TODAY}&include_benefits=false`, executed: true },
  { label: 'fetchNutritionHealthScore', method: 'GET', localPath: '/api/v2/fetchNutritionHealthScore?range=7', prodPath: '/v2/fetchNutritionHealthScore?range=7', executed: true },
  { label: 'getUpcomingRoutine', method: 'GET', localPath: '/api/v2/getUpcomingRoutine?days=7', prodPath: '/v2/getUpcomingRoutine?days=7', executed: true },
  { label: 'fetchNutritionAchievements', method: 'GET', localPath: '/api/v2/fetchNutritionAchievements', prodPath: '/v2/fetchNutritionAchievements', executed: true },
  { label: 'getMealsByType', method: 'GET', localPath: '/api/v2/getMealsByType?meal_type=lunch&page=1&limit=10', prodPath: '/v2/getMealsByType?meal_type=lunch&page=1&limit=10', executed: true },
  { label: 'searchMeals', method: 'GET', localPath: '/api/v2/meals/search?meal_type=lunch&query=rice&limit=10', prodPath: '/v2/meals/search?meal_type=lunch&query=rice&limit=10', executed: true },
  { label: 'getGoalProgress', method: 'GET', localPath: '/api/v2/reports/goal-progress?days=7', prodPath: '/v2/reports/goal-progress?days=7', executed: true },
  { label: 'updateWaterConsumption', method: 'POST', localPath: '/api/updateWaterConsumption', prodPath: '/updateWaterConsumption', executed: false, reason: 'mutating (writes water intake)' },
  { label: 'completeAssessment', method: 'POST', localPath: '/api/completeAssessment', prodPath: '/completeAssessment', executed: false, reason: 'mutating (writes onboarding/assessment)' },
  { label: 'deleteMeal', method: 'POST', localPath: '/api/deleteMeal', prodPath: '/deleteMeal', executed: false, reason: 'mutating (deletes a meal)' },
  { label: 'scanMeal', method: 'POST', localPath: '/api/scanMeal', prodPath: '/scanMeal', executed: false, reason: 'mutating (writes a meal + spends AI budget)' },
  // tsconfig wires this as POST (routes/index.ts); prod wires the equivalent
  // V1_LOGGED_MEALS_BY_DATE as GET. Read-only either way (no write in the
  // handler), so still safe to execute despite the HTTP-verb mismatch.
  { label: 'loggedMealsByDate', method: 'POST', prodMethod: 'GET', localPath: '/api/loggedMealsByDate?page=1&limit=10', prodPath: '/loggedMealsByDate?page=1&limit=10', executed: true, note: 'tsconfig wires this route as POST; prod wires its equivalent as GET (see Finding: HTTP verb mismatch)' },
  { label: 'auth.refresh', method: 'POST', localPath: '/api/auth/refresh', prodPath: '/auth/refresh', executed: false, reason: 'mutating (issues new tokens/session)' },
  { label: 'auth.moduleToken', method: 'POST', localPath: '/api/auth/module-token', prodPath: '/auth/module-token', executed: false, reason: 'mutating (issues a session)' },
  { label: 'auth.logout', method: 'POST', localPath: '/api/auth/logout', prodPath: '/auth/logout', executed: false, reason: 'mutating (invalidates session)' },
  { label: 'auth.me', method: 'GET', localPath: '/api/auth/me', prodPath: '/auth/me', executed: true },
];

const VOLATILE_KEYS = new Set(['request_id', 'requestId', 'timestamp', 'server_time', 'trace_id']);

function diff(a, b, basePath = '') {
  const out = [];
  if (a === b) return out;
  const key = basePath.split(/[.[]/).pop()?.replace(']', '');
  if (VOLATILE_KEYS.has(key)) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.push({ path: basePath || '<root>', prod: a, local: b });
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push({ path: basePath || '<root>', prod: a, local: b });
      return out;
    }
    for (let i = 0; i < a.length; i += 1) out.push(...diff(a[i], b[i], `${basePath}[${i}]`));
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (VOLATILE_KEYS.has(k)) continue;
    out.push(...diff(a[k], b[k], basePath ? `${basePath}.${k}` : k));
  }
  return out;
}

async function call(base, method, path, headers) {
  const url = `${base}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { __raw: text.slice(0, 500) };
    }
    return { ok: true, status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

async function main() {
  const results = [];
  for (const c of CASES) {
    if (!c.executed) {
      results.push({ ...c, skipped: true });
      console.error(`${c.label.padEnd(30)} SKIPPED — ${c.reason}`);
      continue;
    }
    const [local, prod] = await Promise.all([
      call(LOCAL, c.method, c.localPath, LOCAL_AUTH),
      call(PROD, c.prodMethod ?? c.method, c.prodPath, PROD_AUTH),
    ]);

    let dataDiffs = [];
    if (prod.ok && local.ok) {
      const prodData = prod.body && typeof prod.body === 'object' && 'data' in prod.body ? prod.body.data : prod.body;
      const localData = local.body && typeof local.body === 'object' && 'data' in local.body ? local.body.data : local.body;
      dataDiffs = diff(prodData, localData);
    }

    results.push({ ...c, prod, local, dataDiffs, skipped: false });
    console.error(
      `${c.label.padEnd(30)} prod=${prod.ok ? prod.status : 'ERR'}  local=${local.ok ? local.status : 'ERR'}  ` +
        `statusMatch=${prod.ok && local.ok && prod.status === local.status}`,
    );
  }

  writeFileSync(process.argv[4], JSON.stringify(results, null, 2));
  console.error(`\nWrote ${process.argv[4]}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Real HTTP routing, validation, controllers and services; no external writes.
jest.mock('../src/api/services/commonService', () => ({ __esModule: true, default: {
  findOneInTable: jest.fn(), getFromTable: jest.fn(), getManyFromTable: jest.fn(),
  updateTable: jest.fn(), updateManyInTable: jest.fn(), upsertInTable: jest.fn(), insertIntoTable: jest.fn(),
  countInTable: jest.fn(),
} }));
jest.mock('../src/api/services/logsService', () => ({ __esModule: true, default: {
  getPayloadInput: jest.fn(), createLog: jest.fn(),
} }));
jest.mock('../src/api/middleware/auth', () => ({ __esModule: true, default: {
  verifyJwt: (req, _res, next) => { req.body = { ...req.body, authUserId: 'test-user' }; next(); },
} }));
jest.mock('../src/api/middleware/custom-auth', () => ({ __esModule: true, default: {
  customAuthMiddleware: (_req, _res, next) => next(),
} }));
jest.mock('../src/api/services/scanMealService', () => ({}));
jest.mock('../src/api/services/gemini/mealRecognitionService', () => ({ recognizeMeal: jest.fn() }));
jest.mock('../src/api/services/gemini/foodSearchService', () => ({ interpretFoodSearchQuery: jest.fn().mockResolvedValue(null) }));
jest.mock('jimp', () => ({ Jimp: {} }));

const express = require('express');
const db = require('../src/api/services/commonService').default;
const router = require('../src/api/routes/index').default;
let server, base, profile, plan, stats, meals, achievements;
const today = '2026-10-12';
const validPlan = { age: 30, gender: 'MALE', height: '170', height_unit: 'CM', weight: '70', weight_unit: 'KG', activity_level: 'moderate' };

test.each([1, 5, 107, 120, '0x20', '3.2e1', [32]])('#2 rejects age %s that cannot map to a valid database birth year', async age => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, age });
  expect(r.status).toBe(400);
  expect(r.body.message).toBe('Age must be a whole number between 6 and 106.');
  expect(db.findOneInTable).not.toHaveBeenCalled();
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test.each([6, 106, '32'])('#2 accepts valid age boundary or numeric string %s', async age => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, age });
  expect(r.status).toBe(200);
  expect(profile.birth_year).toBe(2026 - Number(age));
});
test.each([1919, 2021, 2000.5, [2000], true, '0x7d0'])('#2 rejects invalid legacy birth year %s', async birthYear => {
  const { age, ...body } = validPlan;
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...body, birthYear });
  expect(r.status).toBe(400);
  expect(r.body.message).toBe('Birth year must be a whole number between 1920 and 2020.');
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test.each(['1.64', '9.843', '0x5', '5e0', '5.7.1', [5], true])('#3 rejects malformed or out-of-range feet height %s', async height => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, height, height_unit: 'ft' });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/height/i);
  expect(r.body.message).not.toMatch(/Prisma|constraint|upsert/i);
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test.each(['1.64', '9.85'])('#3 feet boundary error provides usable two-decimal endpoints for %s', async height => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, height, height_unit: 'ft' });
  expect(r.status).toBe(400);
  expect(r.body.message).toBe('Height must be between 50 and 300 cm (use 1.65 to 9.84 ft when entering two decimal places).');
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test.each([['1.641', 50], ['1.65', 50], ['5.7', 174], ['9.84', 300], ['9.842', 300]])('#3 converts valid decimal feet %s before storage', async (height, height_cm) => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, height, height_unit: 'feet' });
  expect(r.status).toBe(200);
  expect(profile.height_cm).toBe(height_cm);
});
test.each(['/api/v2/generatePersonalizedNutritionPlan/', '/API/V2/GENERATEPERSONALIZEDNUTRITIONPLAN'])('#2 #3 validation cannot be bypassed through route %s', async path => {
  expect((await api(path, { ...validPlan, age: 5 })).status).toBe(400);
  expect((await api(path, { ...validPlan, height: [5], height_unit: 'ft' })).status).toBe(400);
  expect(db.findOneInTable).not.toHaveBeenCalled();
  expect(db.upsertInTable).not.toHaveBeenCalled();
});

test('generated Prisma profile defaults contain values, not SQL literal syntax', () => {
  const { Prisma } = require('@prisma/client');
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === 'user_nutrition_profiles');
  const defaults = Object.fromEntries(model.fields.filter(f => f.hasDefaultValue).map(f => [f.name, f.default]));
  expect(defaults).toMatchObject({ goal_aggressiveness: 'moderate', user_type: 'common',
    cuisine_preferences: '[]', weight_unit: 'kg', completed_tours: '[]', dismissed_nudges_json: '{}', height_unit: 'cm' });
});

async function api(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use("/api/v1", router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
  jest.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  profile = { id: 'test-user', timezone: 'Asia/Kolkata', current_weight_kg: 70, weight_unit: 'kg', height_cm: 170, birth_year: 1996, gender: 'MALE', activity_level: 'moderate', onboarding_completed: true, last_weight_update_date: new Date('2026-10-05T00:00:00Z') };
  plan = { id: 'plan', calorie_target: 2000, water_target_ml: 2000, protein_target_g: 100, carbs_target_g: 250, fat_target_g: 60, fibre_target_g: 25 };
  stats = [];
  meals = [];
  achievements = [];
  db.findOneInTable.mockImplementation(async (model, where) => model === 'user_nutrition_profiles' ? { ...profile } : stats.find(s => +s.date === +where.user_id_date.date) ?? null);
  db.getFromTable.mockImplementation(async model => model === 'user_nutrition_plans' ? plan : null);
  db.getManyFromTable.mockImplementation(async (model, where) => {
    let rows = model === 'meals' ? meals.filter(m => !m.is_deleted) : model === 'daily_stats' ? stats : model === 'achievements' ? achievements : [];
    const field = model === 'meals' ? 'logged_at' : 'date';
    if (where[field]?.gte) rows = rows.filter(r => r[field] >= where[field].gte);
    if (where[field]?.lte) rows = rows.filter(r => r[field] <= where[field].lte);
    return rows;
  });
  db.updateTable.mockImplementation(async (model, where, data) => {
    const target = model === 'user_nutrition_profiles' ? profile : model === 'meals' ? meals.find(m => m.id === where.id) : plan;
    Object.assign(target, data); return target;
  });
  db.updateManyInTable.mockImplementation(async (_model, where, data) => {
    if (+where.last_weight_update_date !== +profile.last_weight_update_date || where.current_weight_kg !== profile.current_weight_kg) return { count: 0 };
    Object.assign(profile, data);
    return { count: 1 };
  });
  db.upsertInTable.mockImplementation(async (model, where, create, update) => {
    if (model === 'user_nutrition_profiles') return Object.assign(profile, update);
    let row = stats.find(s => +s.date === +where.user_id_date.date);
    if (row) Object.assign(row, update); else { row = create; stats.push(row); }
    return row;
  });
  db.insertIntoTable.mockImplementation(async (model, data) => { if (model === 'meals') meals.push(data); return data; });
});
afterEach(() => jest.useRealTimers());

test.each([0, -1, 121, 20.5, 'invalid', true, false, null])('#2 rejects invalid age %s before database access', async age => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, age });
  expect(r.status).toBe(400);
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test.each([['0', 'FT'], ['11', 'FT'], ['49', 'CM'], ['49.9', 'CM'], ['300.1', 'CM'], ['301', 'CM'], ['abc', 'FT']])('#3 rejects height %s %s', async (height, height_unit) => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, height, height_unit });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/height/i);
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test('#1 #5 #6 #7 accepts legacy fields, pounds and goalWeight', async () => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', {
    birthYear: 1996, gender: 'male', current_height: 5.7, height_unit: 'ft', current_weight: 154.3,
    weight_unit: 'Pound', goalWeight: 143.3, activity_level: 'intense', goal: 'lose_weight',
    aggressiveness: 'moderate', body_fat_percentage: 18, preferred_cuisines: ['indian'],
  });
  expect(r.status).toBe(200);
  expect(profile).toMatchObject({ current_weight_kg: 70, goal_weight_kg: 65, height_cm: 174, goal_aggressiveness: 'moderate', body_fat_percent: 18 });
});
test.each([['WEIGHT_LOSS', '75'], ['WEIGHT_LOSS', '70'], ['MUSCLE_GAIN', '70'], ['MUSCLE_GAIN', '65'], ['BALANCED_NUTRITION', '65'], ['WEIGHT_GAIN', '65']])('#19 rejects conflicting %s target %s', async (primary_goal, goal_weight) => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, primary_goal, goal_weight });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/goal weight/i);
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test.each([['WEIGHT_LOSS', '65'], ['MUSCLE_GAIN', '75'], ['BALANCED_NUTRITION', '70']])('#19 accepts consistent %s target %s', async (primary_goal, goal_weight) => {
  expect((await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, primary_goal, goal_weight })).status).toBe(200);
});
test.each(['', '/api/v1'])('#19 exact reported gain payload is rejected at prefix %s', async prefix => {
  const body = {
    age: 32, gender: 'FEMALE', height: '170', height_unit: 'CM', weight: '70', weight_unit: 'KG',
    goal_weight: '65', primary_goal: 'WEIGHT_GAIN', aggressiveness: 'moderate',
    activity_level: 'very_active', diet_type: 'NON_VEGETARIAN', food_preferences: 'INDIAN',
    health_conditions: null, energy_level: 7, meals_per_day: 4, water_intake: '2', water_intake_unit: 'LTR',
  };
  const r = await api(`${prefix}/api/v2/generatePersonalizedNutritionPlan`, body);
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ status: false, message: 'Goal weight must be higher than current weight for weight gain.' });
  expect(db.upsertInTable).not.toHaveBeenCalled();
  expect(db.insertIntoTable).not.toHaveBeenCalled();
  const valid = await api(`${prefix}/api/v2/generatePersonalizedNutritionPlan`, { ...body, goal_weight: '75' });
  expect(valid.status).toBe(200);
  expect(valid.body.data.daily_targets.calories.value).toBe(valid.body.data.daily_targets.tdee.value + 400);
  expect(profile.primary_goal).toBe('MUSCLE_GAIN');
});
test.each(['2026-10-12', '2026-10-11', '2026-10-06'])('#11 rejects another update within seven calendar days (%s)', async last => {
  profile.last_weight_update_date = new Date(last + 'T00:00:00Z');
  const r = await api('/api/v2/updateWeight', { weight: 71 });
  expect(r.status).toBe(409);
  expect(r.body.message).toMatch(/once per week/);
  expect(db.updateTable).not.toHaveBeenCalled();
  expect(db.updateManyInTable).not.toHaveBeenCalled();
});
test('#10 #11 allows exactly seven days, recalculates plan, then rejects another update', async () => {
  const r = await api('/api/v2/updateWeight', { weight: 71 });
  expect(r.status).toBe(200);
  expect(r.body.message).toBe('Nutrition Plan has been updated.');
  expect(r.body.data.plan_updated).toBe(true);
  expect((await api('/api/v2/updateWeight', { weight: 72 })).status).toBe(409);
});
test('#11 date-only weekly boundary works in a negative UTC offset', async () => {
  profile.timezone = 'America/Los_Angeles';
  profile.last_weight_update_date = new Date('2026-10-06T00:00:00Z');
  expect((await api('/api/v2/updateWeight', { weight: 71 })).status).toBe(409);
});
test.each([66.9, 73.1, 73.01, 66.99])('#12 rejects >3kg change (%s), even on the same day', async weight => {
  profile.last_weight_update_date = new Date(today + 'T00:00:00Z');
  const r = await api('/api/v2/updateWeight', { weight });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/3 kg/);
  expect(db.updateTable).not.toHaveBeenCalled();
  expect(db.updateManyInTable).not.toHaveBeenCalled();
});
test.each([67, 73])('#12 accepts exactly 3kg change (%s)', async weight => {
  expect((await api('/api/v2/updateWeight', { weight })).status).toBe(200);
});
test('weight updates normalize pounds and reject unsupported units', async () => {
  expect((await api('/api/v2/updateWeight', { weight: 156.5, weight_unit: 'lbs' })).status).toBe(200);
  expect(profile.current_weight_kg).toBe(71);
  expect((await api('/api/v2/updateWeight', { weight: 71, weight_unit: 'stone' })).status).toBe(400);
});
test.each([7, 30, 90].flatMap(days => ['', '/api/v1'].map(prefix => [days, prefix])))('#21 #22 report statuses for %s days at prefix %s distinguish partial, empty and completed dates', async (days, prefix) => {
  meals = [
    { logged_at: new Date('2026-10-11T10:00:00Z'), calories: 1000 },
    { logged_at: new Date('2026-10-10T10:00:00Z'), calories: 2000 },
    { logged_at: new Date('2026-10-08T10:00:00Z'), calories: 0 },
  ];
  const r = await api(`${prefix}/api/v2/reports/goal-progress?days=${days}`);
  const byDate = Object.fromEntries(r.body.data.progress.map(row => [row.date, row.status]));
  expect(r.status).toBe(200);
  expect(byDate).toMatchObject({ '2026-10-12': 'not_logged', '2026-10-11': 'incomplete', '2026-10-10': 'completed', '2026-10-09': 'not_completed', '2026-10-08': 'incomplete' });
});
test('#17 current report changes immediately after meal add/delete on the next GET', async () => {
  const added = await api('/api/v2/addMeal', { type: 1, meal_type: 'lunch', calories: 2000, meal_name: 'Lunch' });
  expect(added.status).toBe(201);
  const first = await api('/api/v2/reports/goal-progress?days=7');
  expect(first.body.data.progress[0].status).toBe('completed');
  expect(first.headers.get('cache-control')).toContain('no-store');
  expect(first.headers.get('server-timing')).toMatch(/^app;dur=\d+\.\d$/);
  const logged = await api('/api/loggedMealsByDate');
  const meal_id = logged.body.data.logged_meals[0].meals[0].meal_id;
  expect((await api('/api/deleteMeal', { meal_id })).status).toBe(200);
  const second = await api('/api/v2/reports/goal-progress?days=7');
  expect(second.body.data.progress[0].status).toBe('not_logged');
});

test.each([7, 30, 90])('#21 #22 reports use live logs and do not round partial completion for %s days', async days => {
  stats = [{ date: new Date(today + 'T00:00:00Z'), goal_calories: 2000, calories_consumed: 2000, meal_count: 4 }];
  meals = [
    { logged_at: new Date(today + 'T09:00:00Z'), calories: 2000, is_deleted: true },
    { logged_at: new Date('2026-10-11T10:00:00Z'), calories: 1999.6 },
    { logged_at: new Date('2026-10-10T10:00:00Z'), calories: 2000 },
    { logged_at: new Date('2026-10-09T10:00:00Z'), calories: 0 },
  ];
  const r = await api(`/api/v2/reports/goal-progress?days=${days}`);
  const byDate = Object.fromEntries(r.body.data.progress.map(row => [row.date, row.status]));
  expect(r.body.data.progress).toHaveLength(days);
  expect(byDate).toMatchObject({ [today]: 'not_logged', '2026-10-11': 'incomplete',
    '2026-10-10': 'completed', '2026-10-09': 'incomplete', '2026-10-08': 'not_completed' });
  meals.push({ logged_at: new Date(today + 'T09:30:00Z'), calories: 0 });
  const logged = await api(`/api/v2/reports/goal-progress?days=${days}`);
  expect(logged.body.data.progress[0].status).toBe('in_progress');
});

test('#21 reports preserve historical target dates when the server timezone is behind UTC', async () => {
  const moment = require('moment-timezone');
  moment.tz.setDefault('America/Los_Angeles');
  try {
    profile.timezone = 'America/Los_Angeles';
    stats = [
      { date: new Date('2026-10-10T00:00:00Z'), goal_calories: 1000 },
      { date: new Date('2026-10-11T00:00:00Z'), goal_calories: 2000 },
    ];
    meals = [{ logged_at: new Date('2026-10-10T10:00:00Z'), calories: 1000 }];
    const r = await api('/api/v2/reports/goal-progress?days=30');
    expect(r.body.data.progress.find(row => row.date === '2026-10-10')).toMatchObject({
      goal_calories: 1000, status: 'completed',
    });
  } finally {
    moment.tz.setDefault();
  }
});
test.each(['', '/api/v1'])('#14 #24 formats dates and blocks deleting past meals at prefix %s', async prefix => {
  meals = [{ id: 'old-meal', logged_at: new Date('2026-10-05T10:00:00Z'), meal_type: 'LUNCH', calories: 500 }];
  const logged = await api('/api/loggedMealsByDate');
  const group = logged.body.data.logged_meals[0];
  expect(group).toMatchObject({ date: '05-10-2026', label: '05-10-2026' });
  expect(group).not.toHaveProperty('date_iso');
  const r = await api(`${prefix}/api/deleteMeal`, { meal_id: group.meals[0].meal_id });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/today/);
  expect(db.updateTable).not.toHaveBeenCalled();
});
test.each([0, -1, 'invalid'])('#8 rejects invalid water intake %s', async water_consumed_ml => {
  expect((await api('/api/updateWaterConsumption', { water_consumed_ml })).status).toBe(400);
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test('#8 water cap reports the remaining amount', async () => {
  stats = [{ date: new Date(today + 'T00:00:00Z'), water_consumed_ml: 10500 }];
  const r = await api('/api/updateWaterConsumption', { water_consumed_ml: 600 });
  expect(r.status).toBe(400);
  expect(r.body.message).toContain('500 ml');
});
test('#15 water updates remain separate timeline events', async () => {
  expect((await api('/api/updateWaterConsumption', { water_consumed_ml: 200 })).status).toBe(200);
  expect((await api('/api/updateWaterConsumption', { water_consumed_ml: 300 })).status).toBe(200);
  const r = await api(`/api/v2/getNutritionTimeLineByDate?date=${today}`);
  expect(r.status).toBe(200);
  expect(r.body.data.items.filter(item => item.title === 'Water')).toHaveLength(2);
});

const badgesById = response => Object.fromEntries(response.body.data.categories.flatMap(c => c.badges).map(b => [b.id, b]));
test('#18 first-meal badge and points appear and disappear with the qualifying meal', async () => {
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).first_meal_logged.is_unlocked).toBe(false);
  await api('/api/v2/addMeal', { type: 1, meal_type: 'lunch', calories: 500 });
  const afterAdd = await api('/api/v2/fetchNutritionAchievements');
  expect(badgesById(afterAdd).first_meal_logged).toMatchObject({ is_unlocked: true, unlocked_date: today });
  expect(afterAdd.body.data.level.total_points).toBe(10);
  const logged = await api('/api/loggedMealsByDate');
  await api('/api/deleteMeal', { meal_id: logged.body.data.logged_meals[0].meals[0].meal_id });
  const afterDelete = await api('/api/v2/fetchNutritionAchievements');
  expect(badgesById(afterDelete).first_meal_logged).toMatchObject({ is_unlocked: false, unlocked_date: null });
  expect(afterDelete.body.data.level.total_points).toBe(0);
});
test('#18 removes stored badges when their qualifying activity no longer exists', async () => {
  achievements = [
    { achievement_type: 'first_meal_logged', unlocked_at: new Date('2026-09-01') },
    { achievement_type: 'first_1kg_lost', unlocked_at: new Date('2026-09-01') },
  ];
  const badges = badgesById(await api('/api/v2/fetchNutritionAchievements'));
  expect(badges.first_meal_logged.is_unlocked).toBe(false);
  expect(badges.first_1kg_lost.is_unlocked).toBe(false);
});
test('#18 older qualifying meals retain their badges outside the 30-day window', async () => {
  meals = [{ id: 'old', logged_at: new Date('2026-01-01T12:00:00Z'), meal_type: 'lunch', calories: 500 }];
  const badges = badgesById(await api('/api/v2/fetchNutritionAchievements'));
  expect(badges.first_meal_logged).toMatchObject({ is_unlocked: true, unlocked_date: '2026-01-01' });
});
test('#18 consecutive meal badges require consecutive dates and two meals per day', async () => {
  meals = ['2026-10-10', '2026-10-11', today].flatMap(date => ['lunch', 'dinner'].map(meal_type => ({ logged_at: new Date(date + 'T10:00:00Z'), meal_type, calories: 500 })));
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).meal_streak_3.is_unlocked).toBe(true);
  meals[2].is_deleted = true;
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).meal_streak_3.is_unlocked).toBe(false);
});
test('#18 hydration badge uses the plan water target', async () => {
  const before = await api('/api/v2/fetchNutritionAchievements');
  expect(badgesById(before).water_first_day.is_unlocked).toBe(false);
  await api('/api/updateWaterConsumption', { water_consumed_ml: 2000 });
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).water_first_day.is_unlocked).toBe(true);
});
test('#18 perfect-day badge uses live meal totals, not stale daily_stats totals', async () => {
  stats = [{ date: new Date(today + 'T00:00:00Z'), calories_consumed: 0, meal_count: 0, water_consumed_ml: 2000, goal_calories: 2000 }];
  meals = ['lunch', 'dinner'].map(meal_type => ({ logged_at: new Date(today + 'T10:00:00Z'), meal_type, calories: 1000 }));
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).perfect_day_first.is_unlocked).toBe(true);
  meals[0].is_deleted = true;
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).perfect_day_first.is_unlocked).toBe(false);
});
test('#23 search includes catalogue aliases without requiring an AI request', async () => {
  const food = { display_name: 'Masala Tea', meal_type: 'drinks', calories: 80, protein_g: 2, carbs_g: 10, fat_g: 3, fibre_g: 0 };
  db.getManyFromTable.mockImplementation(async (model, where) => model === 'food_catalog' && where.OR.some(c => c.aliases?.contains === 'chai') ? [food] : []);
  const r = await api('/api/v2/meals/search?query=chai&limit=10');
  expect(r.status).toBe(200);
  expect(JSON.stringify(r.body.data)).toContain('Masala Tea');
  expect(require('../src/api/services/gemini/foodSearchService').interpretFoodSearchQuery).not.toHaveBeenCalled();
});

test('meal search supplies document names for lunch with explicitly unavailable nutrition', async () => {
  const r = await api('/api/v2/meals/search?meal_type=lunch&query=tea&limit=10');
  expect(r.status).toBe(200);
  expect(r.body.data).toHaveLength(10);
  expect(r.body.data[0]).toMatchObject({ meal_name: 'Tea', meal_type: 'Lunch', source: 'document',
    nutrition: null, nutrition_status: 'unavailable', requires_nutrition_input: true,
    serving_unit: null, meal_recommendation: null, dominant_nutrient: null });
  expect(r.body.data.every(row => /\btea\b/i.test(row.meal_name))).toBe(true);
  expect(db.insertIntoTable).not.toHaveBeenCalled();
  expect(require('../src/api/services/gemini/foodSearchService').interpretFoodSearchQuery).not.toHaveBeenCalled();
});

test('exact catalogue tea retains nutrition and is not duplicated by a document suggestion', async () => {
  const tea = { display_name: 'Tea', meal_type: 'drinks', calories: 25, protein_g: 1, carbs_g: 4, fat_g: 0, fibre_g: 0 };
  const steamed = { ...tea, display_name: 'Chicken Steamed Dumplings' };
  db.getManyFromTable.mockImplementation(async (model, where) => model !== 'food_catalog' ? [] :
    where.OR.some(c => c.name?.equals === 'tea') ? [tea] : [steamed]);
  const r = await api('/api/v2/meals/search?meal_type=lunch&query=tea&limit=10');
  expect(r.body.data).toHaveLength(10);
  expect(r.body.data[0]).toMatchObject({ meal_name: 'Tea', source: 'catalog', nutrition: { calories: 25 } });
  expect(r.body.data.filter(row => row.meal_name.toLowerCase() === 'tea')).toHaveLength(1);
});

test('document suggestions cannot be logged as catalogue foods without nutrition', async () => {
  const r = await api('/api/v2/addMeal', { type: 3, meal_type: 'lunch', meal_name: 'Pan-Fried Apricot Payasam', quantity: 100, serving_unit: 'g' });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/Nutrition is unavailable/);
  expect(db.insertIntoTable).not.toHaveBeenCalled();
});

test.each(['0', '-1', 'abc', '29.99', '300.01'])('#4 rejects invalid weight %s before persistence', async weight => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, weight });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/weight/i);
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test('#11 concurrent updates permit only one successful weekly update', async () => {
  const responses = await Promise.all([
    api('/api/v2/updateWeight', { weight: 71 }),
    api('/api/v2/updateWeight', { weight: 72 }),
  ]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(db.upsertInTable).toHaveBeenCalledTimes(1);
});
test('#11 an atomic write conflict returns 409 before updating history or plan', async () => {
  db.updateManyInTable.mockResolvedValueOnce({ count: 0 });
  expect((await api('/api/v2/updateWeight', { weight: 71 })).status).toBe(409);
  expect(db.upsertInTable).not.toHaveBeenCalled();
  expect(db.updateTable).not.toHaveBeenCalled();
});
test('#22 today with a partial meal returns in_progress', async () => {
  meals = [{ logged_at: new Date(today + 'T10:00:00Z'), calories: 500 }];
  const r = await api('/api/v2/reports/goal-progress?days=7');
  expect(r.body.data.progress[0].status).toBe('in_progress');
});
test('#24 nonexistent or inaccessible meal ID returns 404 without a write', async () => {
  const r = await api('/api/deleteMeal', { meal_id: 123 });
  expect(r.status).toBe(404);
  expect(db.updateTable).not.toHaveBeenCalled();
});
test('#24 meal deletion uses the local date across UTC midnight', async () => {
  meals = [{ id: 'local-today', logged_at: new Date('2026-10-11T20:00:00Z'), meal_type: 'LUNCH', calories: 500 }];
  const logged = await api('/api/loggedMealsByDate');
  expect(logged.body.data.logged_meals[0]).toMatchObject({ date: '12-10-2026', label: 'Today' });
  expect(logged.body.data.logged_meals[0]).not.toHaveProperty('date_iso');
  expect((await api('/api/deleteMeal', { meal_id: logged.body.data.logged_meals[0].meals[0].meal_id })).status).toBe(200);
});

test.each([undefined, null])('new profile with aggressiveness %s explicitly defaults to moderate', async aggressiveness => {
  db.findOneInTable.mockResolvedValueOnce(null);
  db.upsertInTable.mockImplementationOnce(async (_model, _where, create) => create);
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, aggressiveness });
  expect(r.status).toBe(200);
  expect(db.upsertInTable.mock.calls[0][2].goal_aggressiveness).toBe('moderate');
});
test('omitting aggressiveness preserves the existing profile preference', async () => {
  profile.goal_aggressiveness = 'aggressive';
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', validPlan);
  expect(r.status).toBe(200);
  expect(db.upsertInTable.mock.calls[0][3]).not.toHaveProperty('goal_aggressiveness');
  expect(profile.goal_aggressiveness).toBe('aggressive');
});
test.each(['mild', 'moderate', 'aggressive', ' AGGRESSIVE '])('valid aggressiveness %s is normalized and saved', async aggressiveness => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, aggressiveness });
  expect(r.status).toBe(200);
  expect(profile.goal_aggressiveness).toBe(aggressiveness.trim().toLowerCase());
});
test.each(['extreme', "N'moderate'", '', 123, true])('invalid aggressiveness %s returns a clear 400 before database access', async aggressiveness => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, aggressiveness });
  expect(r.status).toBe(400);
  expect(r.body.message).toBe('Aggressiveness must be mild, moderate or aggressive.');
  expect(db.findOneInTable).not.toHaveBeenCalled();
  expect(db.upsertInTable).not.toHaveBeenCalled();
});

function perfectMeals(date) {
  return ['breakfast', 'lunch', 'snack', 'dinner'].map((meal_type, index) => ({
    id: `${date}-${index}`, logged_at: new Date(date + 'T08:00:00Z'), meal_type,
    calories: 500, protein_g: 25, carbs_g: 62.5, fat_g: 15, fibre_g: 5,
  }));
}
test.each([7, 30, 90])('#13 live health score for %s days uses meals even without stored stats', async range => {
  meals = perfectMeals(today);
  const r = await api(`/api/v2/fetchNutritionHealthScore?range=${range}`);
  expect(r.status).toBe(200);
  expect(r.body.data.score_breakdown.nutrition.value).toBe(75);
  expect(r.body.data.score_breakdown.streak.value).toBe(4);
  expect(r.body.data.health_score.value).toBe(79);
  expect(r.body.data.summary_stats.adherence_percentage).toBe(79);
  expect(r.body.data.chart.series.find(s => s.key === 'score').data.some(p => p.value > 0)).toBe(true);
});
test('#13 seven perfect days earn 100 and the summary matches the health score API', async () => {
  meals = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', today].flatMap(perfectMeals);
  const health = await api('/api/v2/fetchNutritionHealthScore?range=7');
  expect(health.body.data.health_score.value).toBe(100);
  expect(health.body.data.score_breakdown.streak.value).toBe(25);
  const summary = await api(`/api/v2/getNutritionSummaryByDate?date=${today}`);
  expect(summary.status).toBe(200);
  expect(summary.body.data.today_timeline.health_score_percentage).toBe(100);
  expect(summary.body.data.insights.find(i => i.type === 'health_score').achieved).toBe(100);
});
test('#13 #16 removing meals recomputes both APIs instead of returning stale stored scores', async () => {
  stats = [{ date: new Date(today + 'T00:00:00Z'), health_score: 99, adherence_score: .99, streak_day: 50,
    score_breakdown_json: '{"nutrition":75,"consistency":24}' }];
  meals = perfectMeals(today);
  expect((await api('/api/v2/fetchNutritionHealthScore?range=7')).body.data.health_score.value).toBe(79);
  meals.forEach(meal => { meal.is_deleted = true; });
  const health = await api('/api/v2/fetchNutritionHealthScore?range=7');
  expect(health.body.data.health_score.value).toBe(0);
  expect(health.body.data.chart.series.find(s => s.key === 'score').data.at(-1).value).toBe(0);
  const summary = await api(`/api/v2/getNutritionSummaryByDate?date=${today}`);
  expect(summary.body.data.insights.find(i => i.type === 'health_score').achieved).toBe(0);
});
test('#13 calorie and macro adherence use the reference 50/30/20 nutrition weights', async () => {
  meals = [perfectMeals(today)[1]];
  const r = await api('/api/v2/fetchNutritionHealthScore?range=7');
  // 25% calories, 25% macros, one of two due slots: nutrition 23, consistency 4.
  expect(r.body.data.score_breakdown.nutrition.value).toBe(23);
  expect(r.body.data.health_score.value).toBe(27);
});
test('#13 historical summary respects its date and excludes later meals', async () => {
  meals = [...perfectMeals('2026-10-11'), ...perfectMeals(today)];
  const summary = await api('/api/v2/getNutritionSummaryByDate?date=2026-10-11');
  expect(summary.status).toBe(200);
  expect(summary.body.data.insights.find(i => i.type === 'health_score').achieved).toBe(79);
});
test('#13 local-date grouping includes meals before UTC midnight in today score', async () => {
  meals = perfectMeals(today).map(m => ({ ...m, logged_at: new Date('2026-10-11T20:00:00Z') }));
  const r = await api('/api/v2/fetchNutritionHealthScore?range=7');
  expect(r.body.data.health_score.value).toBe(79);
  expect(r.body.data.chart.series.find(s => s.key === 'score').data.at(-1).value).toBe(79);
});


test('regenerating a plan preserves weight update date and does not create weight history', async () => {
  const last = profile.last_weight_update_date;
  expect((await api('/api/v2/generatePersonalizedNutritionPlan', validPlan)).status).toBe(200);
  expect(profile.last_weight_update_date).toEqual(last);
  expect(db.upsertInTable.mock.calls.filter(([model]) => model === 'daily_stats')).toHaveLength(0);
});
test('plan generation cannot bypass weekly weight updates', async () => {
  const r = await api('/api/v2/generatePersonalizedNutritionPlan', { ...validPlan, weight: '71' });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/updateWeight/);
  expect(profile.current_weight_kg).toBe(70);
  expect(db.upsertInTable).not.toHaveBeenCalled();
});
test('weight history uses explicit logs and profile current weight on every page', async () => {
  db.getManyFromTable.mockResolvedValueOnce([{id:'old-update', date:new Date('2026-10-01'), weight_kg:69, weight_logged_at:new Date('2026-10-01')}]);
  db.countInTable.mockResolvedValueOnce(2);
  const r = await api('/api/v2/getWeightHistory?page=2&limit=1');
  expect(r.status).toBe(200);
  expect(r.body.data.current_weight).toBe(70);
  expect(db.getManyFromTable).toHaveBeenCalledWith('daily_stats', expect.objectContaining({weight_logged_at:{not:null}}), expect.any(Object));
  expect(db.getManyFromTable.mock.calls[0][1]).not.toHaveProperty('OR');
});
test('health charts expose a separate kilogram axis for weights above 100', async () => {
  stats = [{ date:new Date(today), weight_kg:150 }];
  const r = await api('/api/v2/fetchNutritionHealthScore?range=7');
  expect(r.body.data.chart.y_axes.weight.max).toBeGreaterThanOrEqual(150);
  expect(r.body.data.chart.y_axes.score.max).toBe(100);
  expect(r.body.data.chart.series.find(s=>s.key==='weight').y_axis_key).toBe('weight');
});
test('weight milestone badges disappear when the qualifying update is removed', async () => {
  profile.goal_type = 'loss'; profile.goal_weight_kg = 65;
  stats = [{date:new Date('2026-10-01'), weight_kg:70}, {date:new Date(today), weight_kg:69, weight_logged_at:new Date(today)}];
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).first_1kg_lost.is_unlocked).toBe(true);
  stats.pop();
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).first_1kg_lost.is_unlocked).toBe(false);
});
test('general streak badges recalculate from live activity rather than stored streak counters', async () => {
  stats = [{ date: new Date(today), streak_day:30 }];
  meals = ['2026-10-10','2026-10-11',today].map(date=>({logged_at:new Date(date+'T10:00:00Z'),calories:100,meal_type:'lunch'}));
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).streak_3.is_unlocked).toBe(true);
  meals.pop();
  expect(badgesById(await api('/api/v2/fetchNutritionAchievements')).streak_3.is_unlocked).toBe(false);
});

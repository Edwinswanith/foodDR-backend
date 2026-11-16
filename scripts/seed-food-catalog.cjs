// Seed the `food_catalog` table with common foods.
//
// Why this exists: V2 `GET /api/v2/meals/search` and `addMeal` type 3 (catalog
// entry) read nutrition deterministically from this table. Unlike the upstream
// foodDR backend, this checkout has NO AI enrich-and-store fallback, so a food
// that is absent from the catalog makes addMeal type 3 return 404 and meal
// search return empty. An empty `food_catalog` is the usual reason a client
// reports "type 3 / meal search not working". Run this once per environment.
//
// Safe + idempotent: inserts only rows whose normalized `name` is not already
// present (is_deleted = false). It never updates or deletes existing rows.
//
// Run: node scripts/seed-food-catalog.cjs
//
// Ported from foodDR/FoodDr/backend-node/scripts/migrate-add-food-catalog.ts.
// The `name` written here is normalized to match findCatalogFoodByName()
// (trim -> lowercase -> collapse whitespace) so seeded rows are found at lookup.

require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('node:crypto');

const p = new PrismaClient();

// display_name, meal_type (null = any slot), serving_unit, basis,
// [calories, protein_g, carbs_g, fat_g, fibre_g] per basis, aliases[]
const SEED = [
  // Weight foods (per 100 g, entered in kg/g)
  ['White Rice', null, 'kg', '100g', [130, 2.7, 28, 0.3, 0.4], ['rice', 'steamed rice', 'plain rice']],
  ['Jeera Rice', null, 'kg', '100g', [150, 3, 30, 2.5, 0.6], ['cumin rice']],
  ['Curd Rice', 'lunch', 'kg', '100g', [120, 3.5, 18, 3, 0.5], ['thayir sadam']],
  ['Lemon Rice', null, 'kg', '100g', [160, 3, 30, 3.5, 0.8], []],
  ['Tomato Rice', null, 'kg', '100g', [155, 3, 29, 3, 0.9], []],
  ['Fried Rice', null, 'kg', '100g', [170, 4, 28, 4.5, 1], ['veg fried rice']],
  ['Chicken Fried Rice', 'lunch', 'kg', '100g', [185, 8, 26, 5.5, 1], []],
  ['Veg Pulao', null, 'kg', '100g', [150, 3.5, 27, 3, 1.2], ['pulao', 'vegetable pulao']],
  ['Chicken Biryani', null, 'kg', '100g', [165, 8, 20, 5, 1], ['biryani', 'chicken briyani']],
  ['Mutton Biryani', null, 'kg', '100g', [185, 9, 20, 8, 1], ['mutton briyani']],
  ['Vegetable Biryani', null, 'kg', '100g', [150, 4, 24, 4, 1.5], ['veg biryani', 'vegetable briyani']],
  ['Dal', null, 'kg', '100g', [110, 6, 15, 2.5, 3], ['dal tadka', 'daal', 'lentil curry']],
  ['Sambar', null, 'kg', '100g', [85, 4, 12, 2, 3], ['sambhar']],
  ['Mixed Vegetable Curry', null, 'kg', '100g', [95, 3, 10, 4.5, 3], ['veg curry', 'sabzi', 'mixed veg']],
  ['Chicken Curry', null, 'kg', '100g', [150, 12, 5, 9, 1], []],
  ['Paneer Butter Masala', null, 'kg', '100g', [230, 8, 10, 18, 1.5], ['paneer curry']],
  ['Vegetable Meals', 'lunch', 'kg', '100g', [140, 4, 22, 4, 2.5], ['veg meals', 'south indian meals', 'meals']],
  ['Oats', 'breakfast', 'kg', '100g', [95, 3.5, 16, 2, 2.5], ['oatmeal', 'cooked oats']],
  ['Vegetable Upma', 'breakfast', 'kg', '100g', [130, 3, 22, 3.5, 1.5], ['upma']],
  ['Pongal', 'breakfast', 'kg', '100g', [140, 4, 22, 4, 1], ['ven pongal']],
  ['Poha', 'breakfast', 'kg', '100g', [130, 2.5, 24, 3, 1], ['aval', 'flattened rice']],
  // Volume foods (per 100 ml, entered in ml)
  ['Tea', 'snack', 'ml', '100ml', [40, 1, 6, 1.5, 0], ['chai', 'milk tea']],
  ['Coffee', 'snack', 'ml', '100ml', [45, 1.2, 6, 1.8, 0], ['filter coffee']],
  ['Milk', null, 'ml', '100ml', [62, 3.2, 4.8, 3.3, 0], ['whole milk']],
  ['Buttermilk', 'snack', 'ml', '100ml', [30, 1.5, 3, 1, 0], ['chaas', 'moru']],
  ['Coconut Water', 'snack', 'ml', '100ml', [19, 0.7, 3.7, 0.2, 1.1], ['tender coconut', 'coconut juice', 'nariyal pani']],
  ['Lime Juice', 'snack', 'ml', '100ml', [23, 0.2, 6, 0.1, 0.3], ['nimbu pani', 'lemon juice', 'lemonade']],
  ['Orange Juice', 'snack', 'ml', '100ml', [45, 0.7, 10, 0.2, 0.2], ['mosambi juice']],
  // Countable foods (per piece)
  ['Chapati', null, 'piece', 'piece', [104, 3, 18, 2.5, 3], ['roti', 'phulka', 'chappati']],
  ['Idli', 'breakfast', 'piece', 'piece', [58, 2, 12, 0.4, 0.6], ['idly']],
  ['Dosa', 'breakfast', 'piece', 'piece', [133, 3, 18, 5, 1], ['plain dosa', 'thosai']],
  ['Vadai', 'breakfast', 'piece', 'piece', [97, 3.5, 12, 4, 1.5], ['vada', 'medu vada']],
  ['Boiled Egg', null, 'piece', 'piece', [78, 6.3, 0.6, 5.3, 0], ['egg', 'boiled eggs']],
  ['Samosa', 'snack', 'piece', 'piece', [130, 3, 15, 7, 1.5], []],
  ['Banana', 'snack', 'piece', 'piece', [105, 1.3, 27, 0.4, 3], []],
];

function normalizeFoodName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

(async () => {
  try {
    const target = await p.$queryRaw`SELECT DB_NAME() AS name`;
    console.log(`Seeding food_catalog in database: ${target[0].name}`);

    let inserted = 0;
    let skipped = 0;
    for (const [displayName, mealType, servingUnit, basis, [cal, pro, carb, fat, fib], aliases] of SEED) {
      const name = normalizeFoodName(displayName);
      const existing = await p.food_catalog.findFirst({ where: { name, is_deleted: false } });
      if (existing) {
        skipped += 1;
        continue;
      }
      await p.food_catalog.create({
        data: {
          id: randomUUID(),
          name,
          display_name: displayName,
          meal_type: mealType,
          serving_unit: servingUnit,
          basis,
          calories: cal,
          protein_g: pro,
          carbs_g: carb,
          fat_g: fat,
          fibre_g: fib,
          aliases: JSON.stringify(aliases ?? []),
          source: 'seed',
        },
      });
      inserted += 1;
    }
    console.log(`Seeded ${inserted} food(s); skipped ${skipped} already present. Catalog seed covers ${SEED.length} entries.`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await p.$disconnect();
  }
})();

// Additive migration; run before deploying code that selects initial_weight_kg.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const target = await prisma.$queryRaw`SELECT DB_NAME() AS name`;
  if (target[0].name !== 'nutrition_sandbox') throw new Error('Expected nutrition_sandbox');
  await prisma.$executeRaw`IF COL_LENGTH('fooddr.user_nutrition_profiles', 'initial_weight_kg') IS NULL
    ALTER TABLE fooddr.user_nutrition_profiles ADD initial_weight_kg DECIMAL(5,2) NULL`;
  console.log('nutrition_sandbox: initial_weight_kg column ready. Existing data unchanged.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());

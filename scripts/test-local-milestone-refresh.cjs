// Local-only integration audit. Creates and removes one isolated sandbox profile.
require('dotenv').config({ quiet: true });
require('ts-node/register');
const { randomUUID } = require('crypto');
const fs = require('fs');
const assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');
const config = require('../src/config/config').default;
const prisma = require('../src/config/sqlServerClient').default;
const base = 'http://localhost:3001/api/v1';
const userId = `nutrition-test-${randomUUID()}`;
const report = require('path').resolve(__dirname, '../artifacts/localhost-milestone-refresh-responses.txt');
const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const encrypted = CryptoJS.AES.encrypt(JSON.stringify({userId,orgId:1,device:'web'}),config.cryptoPayloadSecretKey).toString();
const token = jwt.sign({data:encrypted},config.jwtSecretKey,{expiresIn:600});
let checks = 0;
fs.mkdirSync(require('path').dirname(report),{recursive:true});
fs.writeFileSync(report, `LOCALHOST NUTRITION API TEST RESPONSES\nRun: ${new Date().toISOString()}\nBase URL: ${base}\nIsolated synthetic test profile; no authentication headers recorded.\n\n`);
const note = message => fs.appendFileSync(report, message+'\n');
function check(message, fn) { fn(); checks++; note(`PASS: ${message}`); }
async function api(label,path,body,expected=200) {
 const start=Date.now();
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const data=await r.json();
 note(`\n--- ${label} ---\n${body===undefined?'GET':'POST'} ${base+path}\n${body===undefined?'':`Request body:\n${JSON.stringify(body,null,2)}\n`}HTTP ${r.status}; ${Date.now()-start} ms\nResponse:\n${JSON.stringify(data,null,2)}`);
 check(`${label}: HTTP ${expected}`,()=>assert.equal(r.status,expected));
 return data;
}
const timings=[];
const badges=r=>Object.fromEntries(r.data.categories.flatMap(c=>c.badges).map(b=>[b.id,b]));
async function snapshot(label) {
 const paths=[`/api/v2/getNutritionSummaryByDate?date=${today}&page=1&limit=30`,'/api/v2/fetchNutritionAchievements','/api/v2/reports/goal-progress?days=30','/api/v2/fetchNutritionHealthScore?range=30',`/api/v2/getProgressByDate?date=${today}&include_benefits=false`];
 const start=Date.now();
 const results=await Promise.all(paths.map(path=>api(label,path)));
 timings.push({stage:label,all_five_ms:Date.now()-start});
 check(label+' scores agree',()=>{
 const score=results[3].data.health_score.value;
 assert.equal(results[0].data.insights.find(i=>i.type==='health_score').achieved,score);
 assert.equal(results[4].data.goal.score_value,score);
 });
 return results;
}
(async()=>{
 const target=await prisma.$queryRaw`SELECT DB_NAME() AS name`;
 assert.equal(target[0].name,'nutrition_sandbox');
 note('Database verified: nutrition_sandbox');
 await api('Create plan','/api/v2/generatePersonalizedNutritionPlan',{age:32,gender:'FEMALE',height:'170',height_unit:'CM',weight:'70',weight_unit:'KG',goal_weight:'69',primary_goal:'WEIGHT_LOSS',aggressiveness:'moderate',activity_level:'moderate'});
 await api('Complete assessment','/api/completeAssessment',{});
 let r=await snapshot('Before changes');
 check('No weight milestone initially',()=>assert.equal(badges(r[1]).first_1kg_lost.is_unlocked,false));
 await api('Lose first kilogram and reach target','/api/v2/updateWeight',{weight:69,weight_unit:'KG'});
 r=await snapshot('Immediately after weight update');
 check('Weight badges and points unlocked',()=>{const b=badges(r[1]);assert.equal(b.first_1kg_lost.is_unlocked,true);assert.equal(b.target_weight_reached_loss.is_unlocked,true);assert.ok(r[1].data.level.total_points>=b.first_1kg_lost.points+b.target_weight_reached_loss.points)});
 const plan=await prisma.user_nutrition_plans.findFirst({where:{user_id:userId,is_active:true,is_deleted:false}});
 await api('Complete water target','/api/updateWaterConsumption',{water_consumed_ml:Number(plan.water_target_ml)});
 r=await snapshot('Immediately after water update');
 check('Water reflected immediately',()=>{assert.equal(r[0].data.insights.find(i=>i.type==='hydration_streak').achieved,1);assert.equal(badges(r[1]).water_first_day.is_unlocked,true)});
 await api('Add meal','/api/v2/addMeal',{type:1,meal_type:'lunch',meal_name:'Milestone QA Meal',calories:500,protein_g:30,carbs_g:60,fat_g:15,fibre_g:5},201);
 r=await snapshot('Immediately after meal added');
 check('Meal calories and badge reflect new log',()=>{assert.equal(r[4].data.goal.achieved_kcal,500);assert.equal(badges(r[1]).first_meal_logged.is_unlocked,true);assert.ok(r[4].data.goal.score_value>0)});
 const logged=await api('Find test meal',`/api/loggedMealsByDate?date=${today}`);
 await api('Delete meal','/api/deleteMeal',{meal_id:logged.data.logged_meals[0].meals[0].meal_id});
 r=await snapshot('Immediately after meal deleted');
 check('Deleted meal removed from progress and achievements',()=>{assert.equal(r[4].data.goal.achieved_kcal,0);assert.equal(r[4].data.goal.score_value,0);assert.equal(badges(r[1]).first_meal_logged.is_unlocked,false);assert.equal(badges(r[1]).first_1kg_lost.is_unlocked,true)});
 note(JSON.stringify({result:'PASS',checks,timings},null,2));console.log(JSON.stringify({result:'PASS',checks,timings,report}));
})().catch(error=>{note(`\nRESULT: FAIL — ${error.message}`);console.error(error.message);process.exitCode=1}).finally(async()=>{
 try {
  await prisma.$transaction([
   prisma.meals.deleteMany({where:{user_id:userId}}),
   prisma.daily_stats.deleteMany({where:{user_id:userId}}),
   prisma.user_nutrition_plans.deleteMany({where:{user_id:userId}}),
   prisma.achievements.deleteMany({where:{user_id:userId}}),
   prisma.user_nutrition_profiles.deleteMany({where:{id:userId}}),
  ]);
  note('CLEANUP: isolated profile and its records removed.');
 }catch(e){note('CLEANUP FAILED: '+e.message);process.exitCode=1}
 await prisma.$disconnect();
});

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
const base = 'http://localhost:3000/api/v1';
const userId = `nutrition-test-${randomUUID()}`;
const report = require('path').resolve(__dirname, '../artifacts/localhost-nutrition-responses.txt');
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
const badge=(r,id)=>r.data.categories.flatMap(c=>c.badges).find(b=>b.id===id);
(async()=>{
 const target=await prisma.$queryRaw`SELECT DB_NAME() AS name`;
 assert.equal(target[0].name,'nutrition_sandbox');
 note('Database target verified: nutrition_sandbox');
 const plan={age:32,gender:'FEMALE',height:'170',height_unit:'CM',weight:'70',weight_unit:'KG',goal_weight:'65',primary_goal:'WEIGHT_LOSS',aggressiveness:'moderate',activity_level:'moderate'};
 await api('Invalid age','/api/v2/generatePersonalizedNutritionPlan',{...plan,age:5},400);
 const {age,...legacy}=plan;
 await api('Invalid birth year','/api/v2/generatePersonalizedNutritionPlan',{...legacy,birthYear:2021},400);
 await api('Initial plan','/api/v2/generatePersonalizedNutritionPlan',plan);
 await api('Complete assessment','/api/completeAssessment',{});
 let h=await api('Initial plan does not appear as weight update','/api/v2/getWeightHistory?page=1&limit=10');
 check('No initial weight-update history',()=>assert.equal(h.data.history.length,0));
 await api('Repeat plan','/api/v2/generatePersonalizedNutritionPlan',plan);
 await api('Plan weight bypass rejected','/api/v2/generatePersonalizedNutritionPlan',{...plan,weight:'71'},400);
 await api('More than 3 kg rejected','/api/v2/updateWeight',{weight:66.99},400);
 await api('Exactly 3 kg allowed','/api/v2/updateWeight',{weight:67});
 await api('Same-week change rejected','/api/v2/updateWeight',{weight:68},409);
 await api('Regenerate at saved weight','/api/v2/generatePersonalizedNutritionPlan',{...plan,weight:'67'});
 h=await api('Only explicit update appears','/api/v2/getWeightHistory?page=1&limit=10');
 check('One genuine weight update',()=>assert.equal(h.data.history.length,1));
 // Move only the synthetic profile clock to verify the seven-day boundary.
 const past=new Date(today+'T00:00:00Z');past.setUTCDate(past.getUTCDate()-7);
 await prisma.user_nutrition_profiles.update({where:{id:userId},data:{last_weight_update_date:past}});
 note('Fixture setup: isolated profile last_weight_update_date set to seven days ago.');
 await api('Seven-day boundary permits update','/api/v2/updateWeight',{weight:68});
 await api('Immediate repeat rejected','/api/v2/updateWeight',{weight:69},409);
 const added=await api('Add test meal','/api/v2/addMeal',{type:1,meal_type:'lunch',meal_name:'API Test Meal',calories:500,protein_g:30,carbs_g:60,fat_g:15,fibre_g:5},201);
 let a=await api('Achievements after meal','/api/v2/fetchNutritionAchievements');
 check('First meal badge unlocked',()=>assert.equal(badge(a,'first_meal_logged').is_unlocked,true));
 const s7=await api('Health score 7 days','/api/v2/fetchNutritionHealthScore?range=7');
 const s30=await api('Health score 30 days','/api/v2/fetchNutritionHealthScore?range=30');
 const summary=await api('Summary health score',`/api/v2/getNutritionSummaryByDate?date=${today}&page=1&limit=30`);
 check('Score agrees in both ranges and summary',()=>{
 assert.equal(s7.data.health_score.value,s30.data.health_score.value);
 assert.equal(s7.data.health_score.value,summary.data.insights.find(i=>i.type==='health_score').achieved);
 });
 const logged=await api('Logged meal date formatting',`/api/loggedMealsByDate?date=${today}&page=1&limit=10`);
 check('Date uses DD-MM-YYYY',()=>assert.match(logged.data.logged_meals[0].date,/^\d{2}-\d{2}-\d{4}$/));
 const mealId=logged.data.logged_meals[0].meals[0].meal_id;
 await api('Delete test meal','/api/deleteMeal',{meal_id:mealId});
 a=await api('Achievements after deletion','/api/v2/fetchNutritionAchievements');
 check('First meal badge removed',()=>assert.equal(badge(a,'first_meal_logged').is_unlocked,false));
 // High-weight historical baseline tests a separate kg axis, without changing profile weight.
 await prisma.daily_stats.create({data:{id:randomUUID(),user_id:userId,date:past,weight_kg:150,workout_status:'none'}});
 note('Fixture setup: isolated historical baseline of 150 kg; not a user weight update.');
 const chart=await api('Chart separates kilograms and points','/api/v2/fetchNutritionHealthScore?range=30');
 check('Weight axis covers 150 kg',()=>assert.ok(chart.data.chart.y_axes.weight.max>=150));
 h=await api('Unlogged historical baseline excluded','/api/v2/getWeightHistory?page=1&limit=10');
 check('Only today explicit weight update remains',()=>assert.equal(h.data.history.length,1));
 for(const days of [7,30,90])await api(`Goal progress ${days} days`,`/api/v2/reports/goal-progress?days=${days}`);
 note(`\nRESULT: PASS — ${checks} assertions.\nFrontend auto-refetch is not testable in this backend-only checkout.\nExisting user data was not altered by this test.`);
 console.log(JSON.stringify({result:'PASS',checks,report}));
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

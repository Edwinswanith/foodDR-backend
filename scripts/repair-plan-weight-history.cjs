// Dry-run by default. Only repairs entries whose matching API log proves
// they were written by plan generation. Backups precede every applied repair.
require('dotenv').config({quiet:true});
const {PrismaClient}=require('@prisma/client');
const fs=require('fs'),path=require('path');
const p=new PrismaClient();
const sourceRowId=process.argv[2];
if(!sourceRowId)throw new Error('Usage: node scripts/repair-plan-weight-history.cjs <daily_stats_id> [--apply]');
(async()=>{
 const target=await p.$queryRaw`SELECT DB_NAME() AS name`;
 if(target[0].name!=='nutrition_sandbox')throw new Error('Repair requires nutrition_sandbox');
 const source=await p.daily_stats.findUnique({where:{id:sourceRowId},select:{user_id:true}});
 if(!source)throw new Error('Source row not found');
 const profile=await p.user_nutrition_profiles.findUnique({where:{id:source.user_id},select:{last_weight_update_date:true}});
 const rows=await p.daily_stats.findMany({where:{user_id:source.user_id,is_deleted:false,weight_logged_at:{not:null}},select:{id:true,date:true,weight_logged_at:true},orderBy:{date:'asc'}});
 const candidates=[];
 for(const row of rows){
  const stamp=+row.weight_logged_at;
  const logs=await p.api_logs.findMany({where:{api_name:{in:['generatePersonalizedNutritionPlan','updateWeight']},status:'success',created_at:{gte:new Date(stamp-1000),lte:new Date(stamp+2000)},request_input:{contains:source.user_id}},select:{api_name:true,request_input:true}});
  const matches=logs.filter(log=>{try{const b=JSON.parse(log.request_input);return String(b.authUserId||b.userId)===source.user_id}catch{return false}});
  if(matches.length===1 && matches[0].api_name==='generatePersonalizedNutritionPlan')candidates.push(row);
 }
 const ids=new Set(candidates.map(r=>r.id));
 const remaining=rows.filter(r=>!ids.has(r.id));
 const oldDate=profile.last_weight_update_date;
 const resetDate=oldDate && candidates.some(r=>+r.date===+oldDate);
 const latestDate=remaining.at(-1)?.date||null;
 const summary={mode:process.argv.includes('--apply')?'apply':'dry-run',database:target[0].name,proven_plan_entries:candidates.length,remaining_entries:remaining.length,dates:candidates.map(r=>r.date.toISOString().slice(0,10)),reset_weekly_marker:Boolean(resetDate)};
 if(process.argv.includes('--apply') && candidates.length){
  const folder=path.resolve(__dirname,'../artifacts');fs.mkdirSync(folder,{recursive:true});
  const backup=path.join(folder,`weight-history-repair-${Date.now()}.json`);
  fs.writeFileSync(backup,JSON.stringify({user_id:source.user_id,last_weight_update_date:oldDate,rows:candidates},null,2),{mode:0o600});
  await p.$transaction(async tx=>{
   for(const row of candidates){
    const result=await tx.daily_stats.updateMany({where:{id:row.id,user_id:source.user_id,weight_logged_at:row.weight_logged_at},data:{weight_logged_at:null}});
    if(result.count!==1)throw new Error('Concurrent history update detected; repair rolled back');
   }
   if(resetDate){
    const result=await tx.user_nutrition_profiles.updateMany({where:{id:source.user_id,last_weight_update_date:oldDate},data:{last_weight_update_date:latestDate}});
    if(result.count!==1)throw new Error('Concurrent profile update detected; repair rolled back');
   }
  });
  summary.backup=backup;
 }
 console.log(JSON.stringify(summary,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());

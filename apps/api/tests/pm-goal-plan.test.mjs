import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {planPmGoalWork} from '../dist/modules/planning/infrastructure/pm-goal-plan.js';

const projectId=randomUUID(),goalId=randomUUID(),taskId=randomUUID();
const steps=[
 {key:'inspect',role:'testing',objective:'Проверить работающий интерфейс через браузер',
  acceptance:'Получены проверяемые изображения с подтверждённым SHA',needs:[],tools:[]},
 {key:'document',role:'documentation',objective:'Зафиксировать результаты проверки в документации',
  acceptance:'Артефакты связаны с актуальным документом',needs:['inspect'],tools:[]}
];

function storage({goalStatus='working',taskStage='analysis'}={}){
 const statements=[];
 const db={query:async(sql,args=[])=>{
  statements.push({sql,args});
  if(sql.includes('FROM project_pm_goals g'))
   return {rows:[{id:goalId,status:goalStatus}],rowCount:1};
  if(sql.includes('FROM tasks WHERE'))
   return {rows:[{id:taskId,stage:taskStage,spec_version:1}],rowCount:1};
  if(sql.includes('count(*)::int AS n'))
   return {rows:[{n:0}],rowCount:1};
  return {rows:[],rowCount:1};
 }};
 return {db,statements};
}
test('PM goal plan links every DAG assignment to the accepted goal',async()=>{
 const {db,statements}=storage();
 const result=await planPmGoalWork(db,{projectId,goalId,taskId,steps});
 assert.equal(result.goal_id,goalId);
 assert.equal(result.goal_status,'waiting_agents');
 assert.equal(result.linked_results,2);
 assert.equal(result.assignments.length,2);
 const links=statements.filter(s=>s.sql.includes('INSERT INTO project_pm_goal_links'));
 assert.equal(links.length,2);
 assert.deepEqual(new Set(links.map(l=>l.args[3])),
  new Set(result.assignments.map(a=>a.id)));
 assert.ok(links.every(l=>l.args[1]===projectId&&l.args[2]===goalId));
 const ids=statements.filter(s=>s.sql.includes('INSERT INTO agent_work_assignments'));
 assert.equal(ids.length,2);
 assert.ok(statements.some(s=>s.sql.includes('INSERT INTO agent_work_plan_dependencies')));
 assert.ok(statements.some(s=>s.sql.includes("SET status='waiting_agents'")));
 const last=statements.at(-1);
 assert.match(last.sql,/UPDATE project_pm_goals/);
});
test('completed or foreign goals cannot start any specialist',async()=>{
 for(const row of [[],[{id:goalId,status:'completed'}]]){
  const statements=[];
  const db={query:async(sql,args)=>{
   statements.push({sql,args});
   return {rows:row,rowCount:row.length};
  }};
  await assert.rejects(planPmGoalWork(db,{projectId,goalId,taskId,steps}),
   /Цель не найдена|Завершённую цель/);
  assert.ok(!statements.some(s=>s.sql.includes('INSERT INTO agent_work_assignments')));
 }
});
test('invalid dependency graph aborts before any goal link is recorded',async()=>{
 const {db,statements}=storage();
 await assert.rejects(planPmGoalWork(db,{projectId,goalId,taskId,steps:[
  {...steps[0],needs:['document']},steps[1]
 ]}),/Циклическая зависимость/);
 assert.ok(!statements.some(s=>s.sql.includes('INSERT INTO project_pm_goal_links')));
 assert.ok(!statements.some(s=>s.sql.includes('INSERT INTO agent_work_assignments')));
});

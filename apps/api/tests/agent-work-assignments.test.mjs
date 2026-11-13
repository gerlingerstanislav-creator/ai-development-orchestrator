import test from 'node:test';
import assert from 'node:assert/strict';
import {
 installWorkAssignmentsSchema,delegateWork,reportWork,reviewWork,listWork,finalizeWorkAttempt,workRoles
} from '../dist/modules/agents/infrastructure/work-assignments.js';
import {toolsForRole,capabilitiesForRole} from '../dist/agent-tools.js';
import {checkProjectManagerWatch} from '../dist/modules/planning/application/pm-watch-monitor.js';

const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const assignmentId='00000000-0000-4000-8000-000000000003';

test('work tools are discoverable but role scoped',()=>{
 assert.deepEqual([...workRoles],['analysis','development','testing','documentation','devops','architect']);
 const manager=toolsForRole('manager').map(t=>t.name);
 const developer=toolsForRole('development').map(t=>t.name);
 const observer=toolsForRole('development',true).map(t=>t.name);
 assert.ok(manager.includes('work.delegate')&&manager.includes('work.review'));
 assert.ok(developer.includes('work.delegate')&&developer.includes('work.report'));
 assert.ok(!developer.includes('work.review'));
 assert.ok(!observer.includes('work.report')&&observer.includes('work.list'));
 assert.ok(capabilitiesForRole('testing').some(t=>t.name==='work.report'));
});

test('schema is additive, includes scope, state, and task lookup indexes',async()=>{
 let ddl='';
 await installWorkAssignmentsSchema({query:async sql=>{ddl=sql;return {rowCount:0,rows:[]};}});
 assert.match(ddl,/CREATE TABLE IF NOT EXISTS agent_work_assignments/);
 assert.match(ddl,/task_id uuid NOT NULL REFERENCES tasks/);
 assert.match(ddl,/parent_id uuid/);
 assert.match(ddl,/status text NOT NULL DEFAULT 'queued'/);
 assert.match(ddl,/idx_agent_work_task/);
});

test('delegate creates a work item, not a PR or Kanban stage change',async()=>{
 const sql=[];
 const db={query:async (statement)=>{
  sql.push(statement);
  if(statement.includes('SELECT id,stage,spec_version'))return {rows:[{id:taskId,stage:'analysis',spec_version:3}],rowCount:1};
  if(statement.includes('count(*)::int AS n'))return {rows:[{n:0}],rowCount:1};
  if(statement.includes('SELECT id,status FROM agent_work_assignments'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:1};
 }};
 const result=await delegateWork(db,{projectId,taskId,sourceRole:'manager',role:'testing',
  objective:'Проверить браузерную реализацию',acceptance:'Сохранить настоящие desktop и mobile скриншоты'});
 assert.equal(result.status,'queued');
 assert.ok(sql.some(s=>s.startsWith('INSERT INTO agent_work_assignments')));
 assert.equal(sql.filter(s=>/UPDATE tasks|INSERT INTO ai_task_runs|INSERT INTO ai_test_runs/.test(s)).length,0);
});

test('delegate refuses finished tasks and cross-role nested assignments',async()=>{
 const db={query:async sql=>{
  if(sql.includes('SELECT id,stage,spec_version'))return {rows:[{id:taskId,stage:'done',spec_version:1}],rowCount:1};
  return {rows:[],rowCount:0};
 }};
 await assert.rejects(delegateWork(db,{projectId,taskId,sourceRole:'manager',role:'development',
  objective:'Написать недостающую реализацию',acceptance:'Изменения прошли проверку'}),/завершена/);
});

test('agent report cannot manufacture a completed task and rejects stale scope',async()=>{
 const calls=[];
 const db={query:async(sql)=>{calls.push(sql);return {rowCount:0,rows:[]};}};
 await assert.rejects(reportWork(db,{projectId,taskId,assignmentId,role:'testing',status:'submitted',
  result:'Созданы скриншоты из браузера',evidence:'Скриншоты в отчёте по текущему коммиту'}),/не активно/);
 assert.equal(calls.length,1);
 assert.match(calls[0],/a.role=\$4/);
 assert.match(calls[0],/t.spec_version=a.spec_version/);
 assert.doesNotMatch(calls[0],/UPDATE tasks SET stage/);
});

test('manager cannot accept unsubmitted, unverified, or stale work',async()=>{
 for(const row of [
  {status:'running',evidence:'valid refs',spec_version:3,actual_version:3},
  {status:'submitted',evidence:'',spec_version:3,actual_version:3},
  {status:'submitted',evidence:'valid refs',spec_version:2,actual_version:3}
 ]){
  const db={query:async()=>({rows:[{id:assignmentId,task_id:taskId,...row}],rowCount:1})};
  await assert.rejects(reviewWork(db,{projectId,assignmentId,action:'accept',reason:'Проверены артефакты и критерии задачи'}),/Нельзя принять/);
 }
});

test('manager can accept submitted evidence without moving the Kanban card',async()=>{
 const statements=[];
 const db={query:async sql=>{
  statements.push(sql);
  if(sql.startsWith('SELECT a.*'))return {rows:[{
   id:assignmentId,project_id:projectId,task_id:taskId,status:'submitted',
   evidence:'Ссылка на реальный отчёт',spec_version:3,actual_version:3}],rowCount:1};
  if(sql.includes('WITH RECURSIVE descendants'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:1};
 }};
 const reviewed=await reviewWork(db,{projectId,assignmentId,action:'accept',
  reason:'Проверены предъявленные артефакты по критериям приёмки'});
 assert.equal(reviewed.status,'completed');
 assert.ok(statements.some(s=>s.startsWith('UPDATE agent_work_assignments')));
 assert.ok(!statements.some(s=>s.includes('UPDATE tasks SET stage')));
});

test('executor without work.report is blocked and evidence is not invented',async()=>{
 let status='running';
 const db={query:async sql=>{
  if(sql.startsWith('UPDATE agent_work_assignments SET status')){status='blocked';return {
   rowCount:1,rows:[{id:assignmentId,project_id:projectId,task_id:taskId}]};}
  return {rowCount:1,rows:[]};
 }};
 assert.equal((await finalizeWorkAttempt(db,assignmentId,'Агент не вызвал work.report')).status,'blocked');
 assert.equal(status,'blocked');
});

test('read returns only assignments of the specified project and task',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.startsWith('SELECT 1 FROM tasks'))return {rowCount:1,rows:[{}]};
  return {rowCount:1,rows:[{id:assignmentId}]};
 }};
 const data=await listWork(db,projectId,taskId);
 assert.deepEqual(data.assignments,[{id:assignmentId}]);
 assert.deepEqual(calls[1].args,[projectId,taskId]);
});


test('PM watch stays pending for active work and never reports premature success',async()=>{
 const queries=[];
 const pool={
  query:async(sql,args)=>{
   queries.push(sql);
   return {rows:[{status:'running',role:'testing',objective:'Collect evidence',task_title:'Screens',display_number:36}],rowCount:1};
  },
  connect:async()=>{throw Error('must not write while work is active');}
 };
 const status=await checkProjectManagerWatch(pool,{
  projectId,processId:assignmentId,taskId,kind:'delegated_work'});
 assert.equal(status,'pending');
 assert.equal(queries.length,1);
});

test('PM watch reports blocked work once and requests corrective action',async()=>{
 const queries=[];
 const pool={
  query:async(sql)=>{queries.push(sql);return {
   rows:[{status:'blocked',role:'testing',objective:'Collect screenshots',result:'No browser access',
    evidence:'No active test environment',task_title:'Screenshot task',display_number:36}],rowCount:1};},
  connect:async()=>({
   query:async(sql,args)=>{
    queries.push(sql);
    if(sql.includes('INSERT INTO project_pm_process_reports'))return {rowCount:1,rows:[{process_id:assignmentId}]};
    return {rowCount:1,rows:[]};
   },
   release:()=>{}
  })
 };
 const done=await checkProjectManagerWatch(pool,{
  projectId,processId:assignmentId,kind:'delegated_work',taskId});
 assert.equal(done,'completed');
 assert.ok(queries.some(sql=>sql.includes('project_pm_process_reports')));
 assert.ok(queries.some(sql=>sql.includes('assistant_messages')));
 assert.ok(!queries.some(sql=>sql.includes('UPDATE tasks SET stage')));
});


test('manager cannot accept parent while a delegated child remains active',async()=>{
 const statements=[];
 const db={query:async(sql,args)=>{
  statements.push({sql,args});
  if(sql.startsWith('SELECT a.*'))return {rows:[{
   id:assignmentId,project_id:projectId,task_id:taskId,status:'submitted',
   evidence:'Verified report reference',spec_version:3,actual_version:3
  }],rowCount:1};
  if(sql.includes('WITH RECURSIVE descendants'))return {rows:[{one:1}],rowCount:1};
  throw Error('Unexpected mutation of assignment state');
 }};
 await assert.rejects(reviewWork(db,{projectId,assignmentId,action:'accept',
  reason:'Проверка независимого результата дочернего поручения'}),/делегированная работа не завершена/);
 assert.ok(statements[1].sql.includes("status NOT IN ('completed','cancelled')"));
 assert.deepEqual(statements[1].args,[assignmentId,projectId,taskId]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {planPmGoalWork} from '../dist/modules/planning/infrastructure/pm-goal-plan.js';
import {openPmGoal,completePmGoal,assessPmGoal} from '../dist/modules/planning/infrastructure/pm-goals.js';
import {installGoalWorkScope,delegateWork,planWork,reportWork,listWork,reviewWork} from '../dist/modules/agents/infrastructure/work-assignments.js';
import {executeAgentWorkTool} from '../dist/modules/agents/infrastructure/agent-work-tools.js';
import {readSessionToolGrants,toolsForRole} from '../dist/agent-tools.js';
import {checkProjectManagerWatch} from '../dist/modules/planning/application/pm-watch-monitor.js';

const projectId='00000000-0000-4000-8000-000000000001';
const goalId='00000000-0000-4000-8000-000000000002';
const assignmentId='00000000-0000-4000-8000-000000000003';
const manager={project_id:projectId,actor_id:projectId,role:'manager',id:'session'};
const role='documentation';
const objective='Organize the confirmed project documentation structure';
const acceptance='Create or update a verified document with traceable evidence';

test('v18 keeps task work and adds scope-exclusive goal work with project-safe dependency FKs',async()=>{
 let ddl='';
 await installGoalWorkScope({query:async sql=>{ddl=sql;return {rows:[],rowCount:0};}});
 assert.match(ddl,/ALTER TABLE agent_work_assignments ALTER COLUMN task_id DROP NOT NULL/);
 assert.match(ddl,/agent_work_scope_xor CHECK/);
 assert.match(ddl,/agent_work_goal_project FOREIGN KEY\(project_id,goal_id\)/);
 assert.match(ddl,/agent_work_dependency_scope_xor CHECK/);
 assert.match(ddl,/agent_work_dependency_goal_prerequisite FOREIGN KEY\(project_id,goal_id,requires_id\)/);
 assert.doesNotMatch(ddl,/DROP TABLE|TRUNCATE/);
});

test('manager delegates directly against existing PM goal without making a Kanban card',async()=>{
 const calls=[];
 const db={query:async(sql,params=[])=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT id,status FROM project_pm_goals'))return {rowCount:1,rows:[{id:goalId,status:'working'}]};
  if(sql.includes('count(*)::int AS n'))return {rowCount:1,rows:[{n:0}]};
  if(sql.includes('SELECT id,status,granted_tools'))return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[]};
 }};
 const result=await executeAgentWorkTool(db,manager,'work.delegate',{goal_id:goalId,role,objective,acceptance});
 assert.equal(result.status,'queued');
 assert.equal(result.goal_id,goalId);
 assert.equal(result.task_id,null);
 const inserted=calls.find(x=>x.sql.startsWith('INSERT INTO agent_work_assignments'));
 assert.deepEqual(inserted.params.slice(0,4).slice(2),[null,goalId]);
 assert.ok(calls.some(x=>x.sql.startsWith('INSERT INTO process_events')));
 const links=calls.filter(x=>x.sql.startsWith('INSERT INTO project_pm_goal_links'));
 assert.equal(links.length,1);
 assert.deepEqual(links[0].params.slice(1,3),[projectId,goalId]);
 assert.equal(links[0].params[3],result.id);
 assert.ok(calls.some(x=>x.sql.includes("UPDATE project_pm_goals SET status='waiting_agents'")));
 assert.ok(!calls.some(x=>/INSERT INTO task_events|UPDATE tasks|INSERT INTO ai_task_runs/.test(x.sql)));
 await assert.rejects(executeAgentWorkTool(db,manager,'work.delegate',{
  task_id:goalId,goal_id:goalId,role,objective,acceptance
 }),error=>error.statusCode===400);
});

test('goal scope cannot be guessed across project boundaries or after completion',async()=>{
 const missing={query:async(sql)=>{
  if(sql.includes('SELECT id,status FROM project_pm_goals'))return {rowCount:0,rows:[]};
  throw Error('Unexpected write: '+sql);
 }};
 await assert.rejects(delegateWork(missing,{projectId,goalId,sourceRole:'manager',role,objective,acceptance}),/Цель ПМ не найдена/);
 const completed={query:async(sql)=>{
  if(sql.includes('SELECT id,status FROM project_pm_goals'))return {rowCount:1,rows:[{id:goalId,status:'completed'}]};
  throw Error('Unexpected write: '+sql);
 }};
 await assert.rejects(delegateWork(completed,{projectId,goalId,sourceRole:'manager',role,objective,acceptance}),/завершена/);
});

test('goal plan has same dependency engine and no synthetic task',async()=>{
 const calls=[];
 const db={query:async(sql,params=[])=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT id,status FROM project_pm_goals'))return {rowCount:1,rows:[{id:goalId,status:'working'}]};
  if(sql.includes('count(*)::int AS n'))return {rowCount:1,rows:[{n:0}]};
  return {rowCount:1,rows:[]};
 }};
 const result=await planWork(db,{projectId,goalId,sourceRole:'manager',steps:[
  {key:'read',role:'analysis',objective:'Read the current project sources',acceptance:'Record sources and their revisions',needs:[],tools:[]},
  {key:'write',role:'documentation',objective:'Prepare the confirmed documentation',acceptance:'Record verified document references',needs:['read'],tools:[]}
 ]});
 assert.equal(result.goal_id,goalId);
 assert.equal(result.task_id,null);
 assert.equal(result.assignments.length,2);
 assert.equal(calls.filter(x=>x.sql.startsWith('INSERT INTO agent_work_plan_dependencies')).length,1);
 assert.ok(calls.filter(x=>x.sql.startsWith('INSERT INTO agent_work_assignments')).every(x=>x.params[2]===null&&x.params[3]===goalId));
 assert.ok(!calls.some(x=>x.sql.startsWith('INSERT INTO task_events')));
});

test('work list is restricted by scoped goal ID and specialist cannot take a task from unrelated goal',async()=>{
 const calls=[];
 const db={query:async(sql,args=[])=>{calls.push({sql,args});return {rowCount:1,rows:[{id:assignmentId}]};}};
 const data=await executeAgentWorkTool(db,manager,'work.list',{goal_id:goalId});
 assert.equal(data.assignments[0].id,assignmentId);
 assert.match(calls.at(-1).sql,/a.goal_id=\$2/);
 const specialist={...manager,role:'testing',task_id:goalId,process_id:assignmentId};
 await assert.rejects(executeAgentWorkTool(db,specialist,'work.list',{goal_id:goalId}),error=>error.statusCode===403);
});

test('goal result requires live process and cannot bypass the work.review boundary',async()=>{
 const statements=[];
 const db={query:async(sql,params=[])=>{
  statements.push({sql,params});
  if(sql.startsWith('UPDATE agent_work_assignments a'))return {rowCount:1,rows:[{
   id:assignmentId,project_id:projectId,task_id:null
  }]};
  return {rowCount:1,rows:[]};
 }};
 const status=await reportWork(db,{projectId,taskId:null,assignmentId,role,status:'submitted',
  result:'Documentation written with references',evidence:'Verified document revision and source reference'});
 assert.equal(status.status,'submitted');
 assert.equal(status.requires_review,true);
 assert.deepEqual(statements[0].params.slice(0,4),[assignmentId,projectId,null,role]);
 assert.match(statements[0].sql,/a.task_id IS NOT DISTINCT FROM \$3::uuid/);
 assert.match(statements[0].sql,/g.status<>'completed'/);
 assert.ok(!statements.some(x=>/UPDATE tasks SET stage/.test(x.sql)));
 const row={id:assignmentId,project_id:projectId,task_id:null,goal_id:goalId,
  status:'submitted',evidence:'Verified document revision',spec_version:0,actual_version:0};
 const reviewed=await reviewWork({query:async sql=>{
  if(sql.startsWith('SELECT a.*'))return {rowCount:1,rows:[row]};
  if(sql.includes('WITH RECURSIVE descendants'))return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[]};
 }},{projectId,assignmentId,action:'accept',reason:'Checked links and revision of resulting document'});
 assert.equal(reviewed.status,'completed');
 assert.equal(reviewed.goal_id,goalId);
});

test('taskless specialist grants remain bound to active assignment, never global role',async()=>{
 const specialist={...manager,role:'documentation',task_id:null,process_id:assignmentId,read_only:false};
 const sql=[];
 const db={query:async(query,args)=>{
  sql.push({query,args});
  return {rowCount:1,rows:[{granted_tools:['documents.update']}]};
 }};
 const granted=await readSessionToolGrants(db,specialist);
 assert.deepEqual(granted,['documents.update']);
 assert.match(sql[0].query,/g.status<>'completed'/);
 assert.deepEqual(sql[0].args,[assignmentId,projectId,null,'documentation']);
 assert.deepEqual(await readSessionToolGrants(db,{...specialist,read_only:true}),[]);
 assert.ok(!toolsForRole('testing').some(t=>t.name==='documents.update'));
});

test('PM receives goal-scoped work result in same conversation watch',async()=>{
 const statements=[];
 const pool={query:async(sql)=>{
  statements.push(sql);
  return {rowCount:1,rows:[{status:'blocked',role:'documentation',objective,
   result:'Source missing',evidence:'No source attached',task_title:null,display_number:null}]};
 },connect:async()=>({query:async sql=>{
  statements.push(sql);
  if(sql.includes('INSERT INTO project_pm_process_reports'))return {rowCount:1,rows:[{process_id:assignmentId}]};
  return {rowCount:1,rows:[]};
 },release:()=>{}})};
 const result=await checkProjectManagerWatch(pool,{projectId,processId:assignmentId,kind:'delegated_work'});
 assert.equal(result,'completed');
 assert.ok(statements.some(x=>x.includes('project_pm_process_reports')));
 assert.ok(!statements.some(x=>x.includes('UPDATE tasks SET stage')));
});


test('real PostgreSQL v19: goal-only DAG is executable, reviewable and completable without tasks',async t=>{
 if(!process.env.DATABASE_URL){t.skip('Integration PostgreSQL is not available');return;}
 const schema='goalwork_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{
  await db.end();
  await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await admin.end();
 });
 assert.ok((await runSchemaMigrations(db,coreSchemaMigrations({analysis:'Аналитика'}))).includes(19));
 const actor=randomUUID(),project=randomUUID(),message=randomUUID();
 await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
  [actor,'goal-work-'+actor+'@example.test','hash']);
 await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Goal Work Integration',$2,true)",
  [project,actor]);
 await db.query(`INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status)
  VALUES($1,$2,$3,'user','Prepare project documentation and verify the result','project','processing')`,
  [message,project,actor]);
 const goal=await openPmGoal(db,{
  projectId:project,sourceMessageId:message,actorId:actor,
  objective:'Prepare and independently verify updated documentation',
  criteria:['The content is written and verified by a separate specialist']
 });
 const steps=[
  {key:'draft',role:'documentation',objective:'Write documentation based on project source',
   acceptance:'Document identifier and verified revision are recorded',needs:[],tools:[]},
  {key:'verify',role:'analysis',objective:'Review the documentation produced by the first specialist',
   acceptance:'Independent confirmation of document structure and source',needs:['draft'],tools:[]}
 ];
 const plan=await planPmGoalWork(db,{projectId:project,goalId:goal.id,steps});
 assert.equal(plan.task_id,null);
 assert.equal(plan.goal_id,goal.id);
 assert.equal(plan.assignments.length,2);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_work_plan_dependencies WHERE goal_id=$1',[goal.id])).rows[0].n,1);
 const rows=(await db.query('SELECT id,role,task_id,goal_id FROM agent_work_assignments WHERE goal_id=$1 ORDER BY created_at',[goal.id])).rows;
 assert.equal(rows.length,2);
 assert.ok(rows.every(x=>x.task_id===null&&x.goal_id===goal.id));
 for(const assignment of plan.assignments){
  await db.query("UPDATE agent_work_assignments SET status='running' WHERE id=$1",[assignment.id]);
  const role=assignment.role;
  const report=await reportWork(db,{
   projectId:project,taskId:null,assignmentId:assignment.id,role,status:'submitted',
   result:'Real integration check recorded the specialist output and trace',
   evidence:'Verified document revision and explicit scope '+assignment.id
  });
  assert.equal(report.status,'submitted');
  const accepted=await reviewWork(db,{projectId:project,assignmentId:assignment.id,
   action:'accept',reason:'Checked actual evidence and goal scope constraints'});
  assert.equal(accepted.status,'completed');
 }
 const assessed=await assessPmGoal(db,project,goal.id);
 assert.equal(assessed.verification.verified,true);
 const completed=await completePmGoal(db,{
  projectId:project,goalId:goal.id,
  evidence:'Both scoped specialists were reviewed and the goal links were verified in PostgreSQL'
 });
 assert.equal(completed.status,'completed');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM tasks WHERE project_id=$1',[project])).rows[0].n,0);
});

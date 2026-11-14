import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
const migrations=coreSchemaMigrations({analysis:'Аналитика'});
async function isolated(fn){
 const name='ado_guards_v11_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:3});
 try{await fn(db);}
 finally{await db.end();await admin.query('DROP SCHEMA "'+name+'" CASCADE');await admin.end();}
}
test('fresh v20 installs durable PM goals, goal work and private goal screenshots without altering older migrations',async()=>{
 await isolated(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const triggers=(await db.query(`SELECT tgname FROM pg_trigger
   WHERE tgrelid='tasks'::regclass AND NOT tgisinternal
   AND tgname IN ('trg_ado_analysis_first_guard','trg_ado_epic_stage_sync','trg_ado_browser_evidence_guard')
   ORDER BY tgname`)).rows.map(r=>r.tgname);
  assert.deepEqual(triggers,['trg_ado_analysis_first_guard','trg_ado_browser_evidence_guard','trg_ado_epic_stage_sync']);
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=11')).rows[0].checksum,
   'ado-workflow-epic-analysis-guards-v11');
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=12')).rows[0].checksum,'ado-task-evidence-v12');
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=13')).rows[0].checksum,'ado-agent-work-assignments-v13');
  assert.equal((await db.query("SELECT to_regclass('agent_work_assignments') IS NOT NULL AS installed")).rows[0].installed,true);
  assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version=14")).rows[0].checksum,'ado-work-plan-dag-v14');
  assert.equal((await db.query("SELECT to_regclass('agent_work_plan_dependencies') IS NOT NULL AS installed")).rows[0].installed,true);
  assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version=15")).rows[0].checksum,'ado-agent-tool-capability-grants-v15');
  assert.equal((await db.query("SELECT array_length(granted_tools,1) FROM agent_work_assignments LIMIT 1")).rowCount,0);
  assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version=16")).rows[0].checksum,'ado-delegated-work-browser-artifacts-v16');
  assert.equal((await db.query("SELECT to_regclass('agent_work_artifacts') IS NOT NULL AS installed")).rows[0].installed,true);
  assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version=17")).rows[0].checksum,
   'ado-project-pm-outcome-goals-v17');
  assert.equal((await db.query("SELECT to_regclass('project_pm_goals') IS NOT NULL AS installed")).rows[0].installed,true);
  assert.equal((await db.query("SELECT to_regclass('project_pm_goal_links') IS NOT NULL AS installed")).rows[0].installed,true);
  assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version=19")).rows[0].checksum,'ado-goal-scoped-agent-work-v19');
  assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agent_work_assignments' AND column_name='goal_id'")).rowCount,1);
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=18')).rows[0].checksum,
   'ado-project-pm-capability-proposals-v18');
  const proposal=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_pm_goals' AND column_name='capability_proposal'")).rows;
  assert.equal(proposal.length,1);
  assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE version=20")).rows[0].checksum,
   'ado-goal-scoped-browser-artifacts-v20');
  const goalArtifactColumn=(await db.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agent_work_artifacts' AND column_name='goal_id'")).rows[0];
  const taskArtifactColumn=(await db.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agent_work_artifacts' AND column_name='task_id'")).rows[0];
  assert.equal(goalArtifactColumn?.is_nullable,'YES');
  assert.equal(taskArtifactColumn?.is_nullable,'YES');
  const constraints=(await db.query(`SELECT conname FROM pg_constraint
   WHERE conrelid='agent_work_artifacts'::regclass
   AND conname IN ('agent_work_artifact_scope_xor','agent_work_artifact_goal_project')
   ORDER BY conname`)).rows.map(row=>row.conname);
  assert.deepEqual(constraints,['agent_work_artifact_goal_project','agent_work_artifact_scope_xor']);
 });
});
test('v11 repairs legacy cards once and preserves QA rework transition and active sessions',async()=>{
 await isolated(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.filter(m=>m.version<=10)),[1,2,3,4,5,6,7,8,9,10]);
  const user=randomUUID(),project=randomUUID(),epic=randomUUID(),child=randomUUID(),unapproved=randomUUID(),qaTask=randomUUID(),session=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'v11@example.test','hash')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Upgrading',$2,true)",[project,user]);
  await db.query("INSERT INTO tasks(id,project_id,title,type,stage) VALUES($1,$2,'Epic','epic','done')",[epic,project]);
  await db.query("INSERT INTO tasks(id,project_id,title,type,stage,parent_id,analysis_state) VALUES($1,$2,'Child','task','analysis',$3,'ready_for_development')",[child,project,epic]);
  await db.query("INSERT INTO tasks(id,project_id,title,type,stage,parent_id) VALUES($1,$2,'Unapproved','task','backlog',$3)",[unapproved,project,epic]);
  await db.query("INSERT INTO tasks(id,project_id,title,type,stage) VALUES($1,$2,'QA rework','task','testing')",[qaTask,project]);
  await db.query("INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,status,expires_at,task_id) VALUES($1,$2,$3,'development','active-v11','running',now()+interval '2 hours',$4)",[session,project,user,qaTask]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[11,12,13,14,15,16,17,18,19,20]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[epic])).rows[0].stage,'backlog');
  assert.equal((await db.query('SELECT analysis_state FROM tasks WHERE id=$1',[child])).rows[0].analysis_state,'new');
  assert.equal((await db.query('SELECT status FROM agent_sessions WHERE id=$1',[session])).rows[0].status,'running');
  assert.equal((await db.query('SELECT agents_running FROM projects WHERE id=$1',[project])).rows[0].agents_running,true);
  await assert.rejects(db.query("UPDATE tasks SET stage='development' WHERE id=$1",[unapproved]),e=>e?.code==='23514');
  await db.query("UPDATE tasks SET stage='development' WHERE id=$1",[qaTask]);
  assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[qaTask])).rows[0].stage,'development');
  await db.query("UPDATE tasks SET stage='analysis' WHERE id=$1",[qaTask]);
  await assert.rejects(db.query("UPDATE tasks SET stage='development' WHERE id=$1",[qaTask]),e=>e?.code==='23514');
 });
});

test('browser artifacts cannot bypass analysis or invent an implementation commit',async()=>{
 await isolated(async db=>{
  await runSchemaMigrations(db,migrations);
  const project=randomUUID(),user=randomUUID(),task=randomUUID(),sha='a'.repeat(40);
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'evidence@example.test','hash')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Evidence',$2)",[project,user]);
  await db.query("INSERT INTO tasks(id,project_id,title,type,stage) VALUES($1,$2,'Capture screenshots','task','analysis')",[task,project]);
  await assert.rejects(db.query("UPDATE tasks SET stage='testing',execution_mode='browser_evidence',implementation_kind='artifact',evidence_source_sha=$2,implementation_commit=$2 WHERE id=$1",[task,sha]),e=>e?.code==='23514');
  await db.query("UPDATE tasks SET analysis_state='approved' WHERE id=$1",[task]);
  await assert.rejects(db.query("UPDATE tasks SET stage='testing',execution_mode='browser_evidence',implementation_kind='artifact',evidence_source_sha=$2,implementation_commit=$2 WHERE id=$1",[task,sha]),e=>e?.code==='23514');
  await db.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_completed','Confirmed by analyst')",[randomUUID(),task]);
  await db.query("UPDATE tasks SET stage='testing',execution_mode='browser_evidence',implementation_kind='artifact',evidence_source_sha=$2,implementation_commit=$2 WHERE id=$1",[task,sha]);
  assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[task])).rows[0].stage,'testing');
 });
});

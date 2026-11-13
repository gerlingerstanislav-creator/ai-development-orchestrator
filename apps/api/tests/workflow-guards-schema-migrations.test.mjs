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
test('fresh v12 installs all task transition guards once',async()=>{
 await isolated(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const triggers=(await db.query(`SELECT tgname FROM pg_trigger
   WHERE tgrelid='tasks'::regclass AND NOT tgisinternal
   AND tgname IN ('trg_ado_analysis_first_guard','trg_ado_epic_stage_sync','trg_ado_browser_evidence_guard')
   ORDER BY tgname`)).rows.map(r=>r.tgname);
  assert.deepEqual(triggers,['trg_ado_analysis_first_guard','trg_ado_browser_evidence_guard','trg_ado_epic_stage_sync']);
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=11')).rows[0].checksum,
   'ado-workflow-epic-analysis-guards-v11');
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=12')).rows[0].checksum,'ado-task-evidence-v12');
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
  assert.deepEqual(await runSchemaMigrations(db,migrations),[11,12]);
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

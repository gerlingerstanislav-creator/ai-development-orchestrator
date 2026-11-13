import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {initProjectIterations} from '../dist/project-iterations.js';
import {initRequirementsSchema} from '../dist/requirements.js';
import {reconcileLegacyAgentWorkQueue} from '../dist/agent-work-scheduler.js';

// Historical v8 adoption tests must remain pinned when later migrations are appended.
const migrations=coreSchemaMigrations({analysis:'Аналитика'}).filter(m=>m.version<=8);
async function isolated(fn){
 const schema='ado_iteration_v8_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 try{await fn(db);}
 finally{await db.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
}

test('fresh PostgreSQL installs iteration, queue and requirement history in v8 once',async()=>{
 await isolated(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5,6,7,8]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const objects=await db.query(`SELECT
   to_regclass('project_iterations') IS NOT NULL AS iterations,
   to_regclass('iteration_plans') IS NOT NULL AS plans,
   to_regclass('iteration_execution_queue') IS NOT NULL AS queue,
   to_regclass('project_sprints') IS NOT NULL AS sprints,
   to_regclass('task_spec_versions') IS NOT NULL AS revisions,
   to_regclass('task_requirement_reviews') IS NOT NULL AS reviews,
   to_regclass('requirement_review_runs') IS NOT NULL AS review_runs`);
  assert.ok(Object.values(objects.rows[0]).every(Boolean),JSON.stringify(objects.rows[0]));
  const versions=(await db.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(versions.map(x=>x.version),[1,2,3,4,5,6,7,8]);
  assert.equal(versions[7].checksum,'ado-iterations-development-queue-requirements-v8');
 });
});

test('v8 adopts historical startup tables while preserving active work and runtime cleanup',async()=>{
 await isolated(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.filter(m=>m.version<=7)),[1,2,3,4,5,6,7]);
  await initProjectIterations(db);
  await initRequirementsSchema(db);
  const user=randomUUID(),project=randomUUID(),iteration=randomUUID(),
   task=randomUUID(),legacyTask=randomUUID(),run=randomUUID(),spec=randomUUID(),review=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'v8@example.test','hash')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Active project',$2,true)",[project,user]);
  await db.query("INSERT INTO project_iterations(id,project_id,title,revision,approved_revision,body) VALUES($1,$2,'Live iteration',3,3,'Approved scope')",[iteration,project]);
  await db.query("INSERT INTO tasks(id,project_id,title,iteration_id,spec_version) VALUES($1,$2,'Active development',$3,4)",[task,project,iteration]);
  await db.query("INSERT INTO tasks(id,project_id,title,iteration_id) VALUES($1,$2,'Legacy unapproved',$3)",[legacyTask,project,iteration]);
  await db.query("INSERT INTO task_spec_versions(id,project_id,task_id,version,title,description,origin) VALUES($1,$2,$3,4,'Requirements','Keep source','owner')",[spec,project,task]);
  await db.query("INSERT INTO requirement_review_runs(id,project_id,task_id,spec_version,status,message) VALUES($1,$2,$3,4,'running','Review underway')",[review,project,task]);
  await db.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status) VALUES($1,$2,$3,$4,'gpt-6-luna','running')",[run,project,task,user]);
  await db.query("INSERT INTO iteration_execution_queue(project_id,iteration_id,task_id,requested_by,status,run_id,approved_revision,spec_version) VALUES($1,$2,$3,$4,'queued',$5,3,4)",[project,iteration,task,user,run]);
  await db.query("INSERT INTO iteration_execution_queue(project_id,iteration_id,task_id,requested_by,status) VALUES($1,$2,$3,$4,'queued')",[project,iteration,legacyTask,user]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[8]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  assert.equal((await db.query('SELECT agents_running FROM projects WHERE id=$1',[project])).rows[0].agents_running,true);
  assert.equal((await db.query('SELECT status FROM ai_task_runs WHERE id=$1',[run])).rows[0].status,'running');
  assert.deepEqual((await db.query('SELECT status,approved_revision,spec_version FROM iteration_execution_queue WHERE task_id=$1',[task])).rows[0],{status:'queued',approved_revision:3,spec_version:4});
  assert.equal((await db.query('SELECT description FROM task_spec_versions WHERE id=$1',[spec])).rows[0].description,'Keep source');
  assert.equal((await db.query('SELECT status FROM requirement_review_runs WHERE id=$1',[review])).rows[0].status,'running');
  // The migration must not run the recurring queue policy.
  assert.equal((await db.query('SELECT status FROM iteration_execution_queue WHERE task_id=$1',[legacyTask])).rows[0].status,'queued');
  await reconcileLegacyAgentWorkQueue(db);
  assert.equal((await db.query('SELECT status FROM iteration_execution_queue WHERE task_id=$1',[legacyTask])).rows[0].status,'stale');
  assert.equal((await db.query('SELECT status FROM iteration_execution_queue WHERE task_id=$1',[task])).rows[0].status,'queued');
 });
});

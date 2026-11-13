import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {applyLegacySchema} from '../dist/database/legacy-bootstrap.js';
import {initTaskAgentNotesSchema} from '../dist/task-agent-notes.js';

async function withSchema(run){
 const schema='ado_agent_migrations_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 try{
  assert.equal((await db.query('SELECT current_schema() AS value')).rows[0].value,schema);
  await run(db);
 }finally{
  await db.end();
  await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
  await admin.end();
 }
}
// Pin these adoption tests to migration versions 1–2; v3 has its own suite.
const migrations=coreSchemaMigrations({analysis:'Анализ'}).filter(m=>m.version<=2);
test('new databases install agent audit and queues transactionally in v2',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const objects=await db.query(`SELECT
   to_regclass('agent_prompt_audit') IS NOT NULL AS prompt_audit,
   to_regclass('task_agent_notes') IS NOT NULL AS notes,
   to_regclass('agent_peer_queue') IS NOT NULL AS peer_queue,
   to_regclass('agent_analysis_runs') IS NOT NULL AS analysis_queue`);
  assert.deepEqual(objects.rows[0],{
   prompt_audit:true,notes:true,peer_queue:true,analysis_queue:true
  });
  const version=await db.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(version.rows.map(x=>x.version),[1,2]);
  assert.equal(version.rows[1].name,'agent-audit-notes-and-queues');
  assert.ok(version.rows[1].checksum.length>10);
 });
});
test('legacy installed notes and project state remain intact across v2 adoption',async()=>{
 await withSchema(async db=>{
  await applyLegacySchema(db,{analysis:'Анализ'});
  await initTaskAgentNotesSchema(db);
  const ids={user:randomUUID(),project:randomUUID(),task:randomUUID(),note:randomUUID()};
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'adoption@example.test','placeholder')",[ids.user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Legacy', $2,true)",[ids.project,ids.user]);
  await db.query("INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'Legacy task','Original')",[ids.task,ids.project]);
  await db.query(`INSERT INTO task_agent_notes(
   id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_key,status,requires_customer)
   VALUES($1,$2,$3,'analysis','BA','development','question','Existing question','legacy-note','open',false)`,
   [ids.note,ids.project,ids.task]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const note=await db.query('SELECT id,body,status,requires_customer FROM task_agent_notes WHERE id=$1',[ids.note]);
  assert.deepEqual(note.rows[0],{
   id:ids.note,body:'Existing question',status:'open',requires_customer:false
  });
  const project=await db.query('SELECT agents_running FROM projects WHERE id=$1',[ids.project]);
  assert.equal(project.rows[0].agents_running,true,'schema migration must not run restart pause policy');
  const history=await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(history.rows.map(x=>x.version),[1,2]);
 });
});

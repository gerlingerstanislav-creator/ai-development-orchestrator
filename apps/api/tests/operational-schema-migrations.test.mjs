import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {initQualityGateSchema} from '../dist/quality-gates.js';
import {initTaskOrchestrationSchema} from '../dist/task-orchestration.js';
import {initProjectManagerInbox} from '../dist/project-manager-inbox.js';

const migrations=coreSchemaMigrations({analysis:'Аналитика'}).filter(m=>m.version<=3);
async function withSchema(fn){
 const name='ado_operational_migrations_'+randomUUID().replaceAll('-','');
 const administrator=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await administrator.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:3});
 try{await fn(db);}
 finally{
  await db.end();
  await administrator.query('DROP SCHEMA "'+name+'" CASCADE');
  await administrator.end();
 }
}
test('fresh bootstrap installs operational schema v3 exactly once',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const found=await db.query(`SELECT
   to_regclass('quality_gate_runs') IS NOT NULL AS quality_gates,
   to_regclass('task_orchestration_owners') IS NOT NULL AS owners,
   to_regclass('idx_pm_inbox_delivery') IS NOT NULL AS delivery_index,
   to_regclass('idx_pm_inbox_request') IS NOT NULL AS inbox_index`);
  assert.deepEqual(found.rows[0],{
   quality_gates:true,owners:true,delivery_index:true,inbox_index:true
  });
  const columns=await db.query(`SELECT column_name FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='assistant_messages'`);
  const names=new Set(columns.rows.map(x=>x.column_name));
  for(const name of ['pm_request_id','pm_request_digest','pm_dispatch_attempt',
   'pm_dispatched_at','pm_next_dispatch_at'])assert.ok(names.has(name),name);
  const ledger=await db.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledger.rows.map(r=>r.version),[1,2,3]);
  assert.equal(ledger.rows[2].name,'quality-orchestration-and-pm-inbox');
 });
});
test('v3 adopts existing infrastructure tables without altering pending work or PM chat content',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.slice(0,2)),[1,2]);
  await initQualityGateSchema(db);
  await initTaskOrchestrationSchema(db);
  await initProjectManagerInbox(db);
  const ids={user:randomUUID(),project:randomUUID(),task:randomUUID(),gate:randomUUID(),msg:randomUUID()};
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'operational@example.test','placeholder')",[ids.user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Existing', $2,true)",[ids.project,ids.user]);
  await db.query("INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'Existing task','Do not rewrite this')",[ids.task,ids.project]);
  await db.query("INSERT INTO quality_gate_runs(id,project_id,task_id,kind,head_sha,base_sha,status,message) VALUES($1,$2,$3,'ci',$4,$5,'running','Pending CI')",
   [ids.gate,ids.project,ids.task,'a'.repeat(40),'b'.repeat(40)]);
  await db.query("INSERT INTO task_orchestration_owners(task_id,project_id,owner_id,workflow_id,kind,state) VALUES($1,$2,$3,'workflow-1','development','active')",
   [ids.task,ids.project,ids.user]);
  await db.query("INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,channel,status,pm_request_id) VALUES($1,$2,$3,$4,'user','Existing user response','project','queued',$5)",
   [ids.msg,ids.project,ids.task,ids.user,randomUUID()]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[3]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const [gate,owner,message,project]=await Promise.all([
   db.query('SELECT status,message FROM quality_gate_runs WHERE id=$1',[ids.gate]),
   db.query('SELECT state,workflow_id FROM task_orchestration_owners WHERE task_id=$1',[ids.task]),
   db.query('SELECT body,status,pm_request_id FROM assistant_messages WHERE id=$1',[ids.msg]),
   db.query('SELECT agents_running FROM projects WHERE id=$1',[ids.project])
  ]);
  assert.deepEqual(gate.rows[0],{status:'running',message:'Pending CI'});
  assert.deepEqual(owner.rows[0],{state:'active',workflow_id:'workflow-1'});
  assert.equal(message.rows[0].body,'Existing user response');
  assert.equal(message.rows[0].status,'queued');
  assert.ok(message.rows[0].pm_request_id);
  assert.equal(project.rows[0].agents_running,true,'versioned schema must not pause running agents');
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(x=>x.version),[1,2,3]);
 });
});

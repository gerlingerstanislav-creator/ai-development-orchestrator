import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {initTaskCancellationSchema} from '../dist/task-cancellation.js';
import {installDiagnosticStorageSchema,startDiagnosticRetention} from '../dist/diagnostics.js';

const migrations=coreSchemaMigrations({analysis:'Аналитика'});
async function withSchema(fn){
 const schema='ado_runtime_storage_v6_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 try{await fn(db);}
 finally{
  await db.end();
  await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
  await admin.end();
 }
}
test('fresh migration v6 installs cancellation audit, task-origin index and scoped diagnostics',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5,6]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const found=(await db.query(`SELECT
   to_regclass('task_cancellation_audit') IS NOT NULL AS cancellation,
   to_regclass('idx_documents_task_origin') IS NOT NULL AS document_origin_idx,
   to_regclass('diagnostic_events') IS NOT NULL AS diagnostics,
   to_regclass('idx_diagnostic_events_project') IS NOT NULL AS diagnostic_idx`)).rows[0];
  assert.deepEqual(found,{cancellation:true,document_origin_idx:true,diagnostics:true,diagnostic_idx:true});
  const columns=await db.query(`SELECT column_name FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='documents'`);
  assert.ok(columns.rows.some(x=>x.column_name==='created_by_task_id'));
  const constraint=(await db.query(`SELECT pg_get_constraintdef(c.oid) AS definition
   FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
   WHERE t.relname='documents' AND c.conname='documents_created_by_task_id_fkey'`)).rows[0];
  assert.match(constraint.definition,/REFERENCES (?:[a-z_][a-z0-9_]*\.)?tasks\(id\) ON DELETE SET NULL/);
  const ledger=(await db.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(ledger.map(x=>x.version),[1,2,3,4,5,6]);
  assert.deepEqual(ledger.map(x=>x.checksum),[
   'ado-legacy-schema-baseline-v1','ado-agent-audit-notes-queues-v2',
   'ado-quality-orchestration-pm-inbox-v3','ado-merge-batch-ddl-v4',
   'ado-manager-chat-attachments-ddl-v5','ado-task-cancellation-diagnostics-v6'
  ],'versions 1–5 must keep their original persisted checksum');
 });
});

test('v6 adopts existing cancellation and diagnostics tables without deleting audit or incident history',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.filter(x=>x.version<=5)),[1,2,3,4,5]);
  // Older API bootstraps had already created these objects before v6 existed.
  await initTaskCancellationSchema(db);
  await installDiagnosticStorageSchema(db);
  const ids={user:randomUUID(),project:randomUUID(),task:randomUUID(),
   document:randomUUID(),audit:randomUUID(),diagnostic:randomUUID()};
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'v6-adoption@example.test','hash')",[ids.user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Legacy project',$2,true)",[ids.project,ids.user]);
  await db.query("INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Original task')",[ids.task,ids.project]);
  const specRoot=(await db.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='spec'",[ids.project])).rows[0]?.id;
  assert.ok(specRoot,'new project seeds the canonical specification root');
  await db.query("INSERT INTO documents(id,project_id,title,body,created_by_task_id,parent_id) VALUES($1,$2,'Original document','Durable content',$3,$4)",
   [ids.document,ids.project,ids.task,specRoot]);
  await db.query(`INSERT INTO task_cancellation_audit(id,project_id,task_id,title,actor_id,branch,pr_number,documents_removed)
   VALUES($1,$2,$3,'Cancelled old feature',$4,'task-branch',17,2)`,
   [ids.audit,ids.project,ids.task,ids.user]);
  await db.query(`INSERT INTO diagnostic_events(id,project_id,actor_id,request_id,severity,event_type,payload,created_at)
   VALUES($1,$2,$3,'req-42','warning','qa-run-failed',$4::jsonb,now()-interval '20 days')`,
   [ids.diagnostic,ids.project,ids.user,JSON.stringify({reason:'Timeout on prior QA'})]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[6]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const [doc,audit,incident,project]=await Promise.all([
   db.query('SELECT body,created_by_task_id FROM documents WHERE id=$1',[ids.document]),
   db.query('SELECT title,branch,pr_number,documents_removed FROM task_cancellation_audit WHERE id=$1',[ids.audit]),
   db.query('SELECT severity,event_type,payload,created_at FROM diagnostic_events WHERE id=$1',[ids.diagnostic]),
   db.query('SELECT agents_running FROM projects WHERE id=$1',[ids.project])
  ]);
  assert.deepEqual(doc.rows[0],{body:'Durable content',created_by_task_id:ids.task});
  assert.deepEqual(audit.rows[0],{title:'Cancelled old feature',branch:'task-branch',pr_number:17,documents_removed:2});
  assert.deepEqual(incident.rows[0].payload,{reason:'Timeout on prior QA'});
  assert.equal(incident.rows[0].event_type,'qa-run-failed');
  assert.equal(project.rows[0].agents_running,true);
  // A schema migration must never delete records; runtime retention remains separate.
  assert.equal(incident.rows.length,1);
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(x=>x.version),[1,2,3,4,5,6]);
  await startDiagnosticRetention(db);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM diagnostic_events')).rows[0].count,0,
   '14-day cleanup remains a per-start runtime policy, not a one-time migration');
 });
});

test('task-origin link is nulled on task deletion while immutable cancellation audit survives',async()=>{
 await withSchema(async db=>{
  await runSchemaMigrations(db,migrations);
  const user=randomUUID(),project=randomUUID(),task=randomUUID(),doc=randomUUID(),audit=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'v6-origin@example.test','hash')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Test', $2)",[project,user]);
  await db.query("INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Delete me')",[task,project]);
  const specRoot=(await db.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='spec'",[project])).rows[0]?.id;
  assert.ok(specRoot,'projects receive their five system roots automatically');
  await db.query("INSERT INTO documents(id,project_id,title,created_by_task_id,parent_id) VALUES($1,$2,'Retain page',$3,$4)",[doc,project,task,specRoot]);
  await db.query("INSERT INTO task_cancellation_audit(id,project_id,task_id,title) VALUES($1,$2,$3,'Historical cancellation')",[audit,project,task]);
  await db.query('DELETE FROM tasks WHERE id=$1',[task]);
  assert.equal((await db.query('SELECT created_by_task_id FROM documents WHERE id=$1',[doc])).rows[0].created_by_task_id,null);
  assert.equal((await db.query('SELECT title FROM task_cancellation_audit WHERE id=$1',[audit])).rows[0].title,'Historical cancellation');
 });
});

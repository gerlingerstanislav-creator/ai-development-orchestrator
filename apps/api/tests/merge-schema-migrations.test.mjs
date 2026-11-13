import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {recoverInterruptedLegacyMergeBatches} from '../dist/merge-batch.js';

const migrations=coreSchemaMigrations({analysis:'Аналитика'});

async function withSchema(callback){
 const name='ado_merge_v4_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:3});
 try{await callback(pool);}
 finally{
  await pool.end();
  await admin.query('DROP SCHEMA "'+name+'" CASCADE');
  await admin.end();
 }
}

test('fresh PostgreSQL schema applies merge-batch v4 once and preserves previous checksums',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const columns=await db.query(`SELECT column_name FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='merge_process_runs'`);
  assert.ok(columns.rows.some(row=>row.column_name==='task_ids'));
  const index=await db.query(`SELECT indexdef FROM pg_indexes
   WHERE schemaname=current_schema() AND indexname='idx_merge_process_active'`);
  assert.equal(index.rowCount,1);
  assert.match(index.rows[0].indexdef,/UNIQUE INDEX/);
  const ledger=await db.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledger.rows.map(row=>row.version),[1,2,3,4]);
  assert.equal(ledger.rows[0].checksum,'ado-legacy-schema-baseline-v1');
  assert.equal(ledger.rows[1].checksum,'ado-agent-audit-notes-queues-v2');
  assert.equal(ledger.rows[2].checksum,'ado-quality-orchestration-pm-inbox-v3');
  assert.equal(ledger.rows[3].checksum,'ado-merge-batch-ddl-v4');
 });
});

test('v4 adopts existing merge queues without touching runtime state or losing results',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.slice(0,3)),[1,2,3]);
  const user=randomUUID(),project1=randomUUID(),project2=randomUUID(),legacy=randomUUID(),active=randomUUID(),task=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'merge-v4@example.test','placeholder')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Legacy queue',$3),($2,'Active queue',$3)",[project1,project2,user]);
  await db.query("INSERT INTO merge_process_runs(id,project_id,actor_id,status,message,results) VALUES($1,$2,$3,'running','Legacy interrupted',$4)",
   [legacy,project1,user,JSON.stringify([{taskId:task,status:'merged'}])]);
  // Simulates a server where the pre-migration initializer already ran.
  await db.query('ALTER TABLE merge_process_runs ADD COLUMN IF NOT EXISTS task_ids uuid[]');
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_process_active ON merge_process_runs(project_id) WHERE status IN ('queued','running')");
  await db.query("INSERT INTO merge_process_runs(id,project_id,actor_id,status,message,task_ids) VALUES($1,$2,$3,'running','Real Temporal batch',$4)",
   [active,project2,user,[task]]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[4]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const before=await db.query('SELECT id,status,message,task_ids,results FROM merge_process_runs ORDER BY id');
  assert.equal(before.rows.find(row=>row.id===legacy).status,'running','DDL migration cannot rewrite old run state');
  assert.equal(before.rows.find(row=>row.id===active).status,'running');
  assert.deepEqual(before.rows.find(row=>row.id===active).task_ids,[task]);
  assert.deepEqual(before.rows.find(row=>row.id===legacy).results,[{taskId:task,status:'merged'}]);

  await recoverInterruptedLegacyMergeBatches(db);
  await recoverInterruptedLegacyMergeBatches(db);
  const after=await db.query('SELECT id,status,message,task_ids,results,finished_at FROM merge_process_runs ORDER BY id');
  assert.equal(after.rows.find(row=>row.id===legacy).status,'failed');
  assert.ok(after.rows.find(row=>row.id===legacy).finished_at);
  assert.equal(after.rows.find(row=>row.id===active).status,'running');
  assert.equal(after.rows.find(row=>row.id===active).message,'Real Temporal batch');
  assert.deepEqual(after.rows.find(row=>row.id===active).task_ids,[task]);
  assert.deepEqual(after.rows.find(row=>row.id===legacy).results,[{taskId:task,status:'merged'}]);
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(x=>x.version),[1,2,3,4]);
 });
});

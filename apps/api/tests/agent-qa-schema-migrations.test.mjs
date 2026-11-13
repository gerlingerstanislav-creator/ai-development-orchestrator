import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {initAgentToolsSchema} from '../dist/agent-tools.js';
import {initQaSchema} from '../dist/qa.js';
import {initQaWaiverSchema} from '../dist/qa-waiver.js';
import {initCloudDiagnosticsSchema} from '../dist/cloud-diagnostics.js';

// Pin the historical QA adoption suite to v7; newer migrations have separate tests.
const migrations=coreSchemaMigrations({analysis:'Аналитика'}).filter(m=>m.version<=7);
async function inIsolatedSchema(run){
 const name='ado_agent_qa_v7_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:3});
 try{await run(db);}
 finally{await db.end();await admin.query('DROP SCHEMA "'+name+'" CASCADE');await admin.end();}
}

test('fresh schema installs each agent and QA table once with immutable migration checksums',async()=>{
 await inIsolatedSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5,6,7]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const tables=await db.query(`SELECT
   to_regclass('agent_sessions') IS NOT NULL AS sessions,
   to_regclass('agent_tool_events') IS NOT NULL AS events,
   to_regclass('agent_memory') IS NOT NULL AS memory,
   to_regclass('agent_blockers') IS NOT NULL AS blockers,
   to_regclass('qa_user_flows') IS NOT NULL AS flows,
   to_regclass('qa_test_cases') IS NOT NULL AS cases,
   to_regclass('qa_test_plans') IS NOT NULL AS plans,
   to_regclass('qa_case_results') IS NOT NULL AS results,
   to_regclass('qa_merge_waivers') IS NOT NULL AS waivers,
   to_regclass('service_diagnostics_settings') IS NOT NULL AS settings,
   to_regclass('diagnostic_cloud_cursors') IS NOT NULL AS cursors,
   to_regclass('idx_agent_tool_idempotency') IS NOT NULL AS tool_idempotency,
   to_regclass('qa_merge_waivers_lookup') IS NOT NULL AS waiver_idx`);
  assert.ok(Object.values(tables.rows[0]).every(Boolean),JSON.stringify(tables.rows[0]));
  assert.deepEqual((await db.query('SELECT id,development_mode FROM service_diagnostics_settings')).rows,[{id:1,development_mode:true}]);
  const ledger=(await db.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(ledger.map(x=>x.version),[1,2,3,4,5,6,7]);
  assert.deepEqual(ledger.map(x=>x.checksum),[
   'ado-legacy-schema-baseline-v1','ado-agent-audit-notes-queues-v2',
   'ado-quality-orchestration-pm-inbox-v3','ado-merge-batch-ddl-v4',
   'ado-manager-chat-attachments-ddl-v5','ado-task-cancellation-diagnostics-v6',
   'ado-agent-qa-diagnostics-settings-v7'
  ]);
 });
});

test('v7 adoption preserves active agent sessions, MCP audit, QA evidence and owner waiver',async()=>{
 await inIsolatedSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.filter(m=>m.version<=6)),[1,2,3,4,5,6]);
  // Historical servers already installed these tables on every start.
  await initAgentToolsSchema(db);
  await initQaSchema(db);
  await initQaWaiverSchema(db);
  await initCloudDiagnosticsSchema(db);
  const id={user:randomUUID(),project:randomUUID(),task:randomUUID(),session:randomUUID(),
   tool:randomUUID(),memory:randomUUID(),flow:randomUUID(),case:randomUUID(),
   plan:randomUUID(),run:randomUUID(),result:randomUUID(),waiver:randomUUID()};
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'qa-v7@example.test','hash')",[id.user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Retained project',$2,true)",[id.project,id.user]);
  await db.query("INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'Existing task','Unchanged requirements')",[id.task,id.project]);
  await db.query(`INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,status,expires_at,task_id)
    VALUES($1,$2,$3,'testing','prior-agent-token-hash','running',now()+interval '4 hours',$4)`,
   [id.session,id.project,id.user,id.task]);
  await db.query(`INSERT INTO agent_tool_events(id,session_id,project_id,tool,arguments,result,success,idempotency_key)
    VALUES($1,$2,$3,'tasks.read','{}'::jsonb,'{"id":"stable-task"}'::jsonb,true,'prior-read')`,
   [id.tool,id.session,id.project]);
  await db.query(`INSERT INTO agent_memory(id,project_id,session_id,role,kind,body,status)
    VALUES($1,$2,$3,'testing','observation','Old evidence remains visible','approved')`,
   [id.memory,id.project,id.session]);
  await db.query("INSERT INTO qa_user_flows(id,project_id,source_task_id,title) VALUES($1,$2,$3,'Legacy checkout flow')",
   [id.flow,id.project,id.task]);
  await db.query(`INSERT INTO qa_test_cases(id,project_id,flow_id,source_task_id,title,area)
    VALUES($1,$2,$3,$4,'Checkout returns HTTP 200','API')`,
   [id.case,id.project,id.flow,id.task]);
  await db.query("INSERT INTO qa_test_plans(id,project_id,task_id,spec_hash,summary) VALUES($1,$2,$3,$4,'Owner criteria')",
   [id.plan,id.project,id.task,'a'.repeat(40)]);
  await db.query("INSERT INTO qa_plan_cases(plan_id,case_id,purpose) VALUES($1,$2,'targeted')",[id.plan,id.case]);
  await db.query(`INSERT INTO ai_test_runs(id,project_id,task_id,cycle_id,attempt,status,verdict)
    VALUES($1,$2,$3,$4,0,'completed','blocked')`,
   [id.run,id.project,id.task,randomUUID()]);
  await db.query(`INSERT INTO qa_case_results(id,project_id,test_run_id,case_id,result,evidence)
    VALUES($1,$2,$3,$4,'passed','HTTP response verified on pinned SHA')`,
   [id.result,id.project,id.run,id.case]);
  await db.query(`INSERT INTO qa_merge_waivers(id,project_id,task_id,test_run_id,approved_by,justification,commit_sha,spec_version,unverified_cases)
    VALUES($1,$2,$3,$4,$5,'Owner accepted documented browser gap',$6,3,$7::jsonb)`,
   [id.waiver,id.project,id.task,id.run,id.user,'b'.repeat(40),JSON.stringify([{id:'browser'}])]);
  await db.query("UPDATE service_diagnostics_settings SET development_mode=false WHERE id=1");
  assert.deepEqual(await runSchemaMigrations(db,migrations),[7]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  assert.equal((await db.query('SELECT status FROM agent_sessions WHERE id=$1',[id.session])).rows[0].status,'running');
  assert.deepEqual((await db.query('SELECT success,result FROM agent_tool_events WHERE id=$1',[id.tool])).rows[0],
   {success:true,result:{id:'stable-task'}});
  assert.equal((await db.query('SELECT body FROM agent_memory WHERE id=$1',[id.memory])).rows[0].body,'Old evidence remains visible');
  assert.deepEqual((await db.query('SELECT case_id,purpose FROM qa_plan_cases WHERE plan_id=$1',[id.plan])).rows,
   [{case_id:id.case,purpose:'targeted'}]);
  assert.equal((await db.query('SELECT evidence FROM qa_case_results WHERE id=$1',[id.result])).rows[0].evidence,'HTTP response verified on pinned SHA');
  assert.equal((await db.query('SELECT justification FROM qa_merge_waivers WHERE id=$1',[id.waiver])).rows[0].justification,'Owner accepted documented browser gap');
  assert.equal((await db.query('SELECT development_mode FROM service_diagnostics_settings WHERE id=1')).rows[0].development_mode,false,
   'user-selected diagnostics mode must survive migration');
  assert.equal((await db.query('SELECT agents_running FROM projects WHERE id=$1',[id.project])).rows[0].agents_running,true);
 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {routeTaskToBrowserEvidence,retryTaskBrowserEvidence} from '../dist/task-evidence-routing.js';
import {reconcileTaskEvidenceQueue,finishTaskEvidenceRun} from '../dist/task-evidence-queue.js';
import {confirmedSourceBuildFailure,confirmedEvidenceSourceBlocker} from '../dist/task-evidence-blockers.js';

const sha='a'.repeat(40);
test('analyst-approved historical screenshot job skips developer and creates one durable Temporal process',async t=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='browser_route_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();});
 await runSchemaMigrations(pool,coreSchemaMigrations({analysis:'Анализ'}));
 const [user,project,task]=Array.from({length:3},randomUUID);
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'evidence-route@example.test','hash')",[user]);
 await pool.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Screenshots',$2,true)",[project,user]);
 await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage) VALUES($1,$2,'Desktop and mobile', $3,'task','analysis')",
  [task,project,'Capture real screenshots for SHA '+sha]);
 await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_completed','Verified specification')",
  [randomUUID(),task]);
 await pool.query("UPDATE tasks SET analysis_state='approved' WHERE id=$1",[task]);
 await pool.query("UPDATE tasks SET stage='development' WHERE id=$1",[task]);
 await assert.rejects(routeTaskToBrowserEvidence(pool,{projectId:project,taskId:task,actorId:user,sourceSha:'b'.repeat(40),
  reason:'Historical screenshot evidence requested'}),/отсутствует/);
 const routed=await routeTaskToBrowserEvidence(pool,{projectId:project,taskId:task,actorId:user,sourceSha:sha,
  reason:'No code updates are necessary; capture the existing site'});
 assert.equal(routed.execution_mode,'browser_evidence');
 assert.equal((await pool.query('SELECT stage,implementation_kind,implementation_commit,pr_url FROM tasks WHERE id=$1',[task])).rows[0].stage,'testing');
 assert.equal((await pool.query('SELECT implementation_kind FROM tasks WHERE id=$1',[task])).rows[0].implementation_kind,'artifact');
 const started=[];
 const temporal=async()=>({workflow:{start:async(name,config)=>started.push({name,config})}});
 await reconcileTaskEvidenceQueue(pool,temporal);
 await reconcileTaskEvidenceQueue(pool,temporal);
 assert.equal(started.length,1,'a running task must not be dispatched twice');
 assert.equal(started[0].name,'browserEvidenceCycle');
 assert.deepEqual(started[0].config.args[0].projectId,project);
 assert.equal((await pool.query("SELECT count(*)::int n FROM ai_task_runs WHERE task_id=$1",[task])).rows[0].n,0,'no synthetic developer run');
 assert.equal((await pool.query("SELECT count(*)::int n FROM task_evidence_runs WHERE task_id=$1",[task])).rows[0].n,1);
 const run=started[0].config.args[0].runId;
 await finishTaskEvidenceRun(pool,{projectId:project,taskId:task,runId:run,status:'blocked',message:'Live environment is unavailable'});
 assert.equal((await pool.query("SELECT status FROM task_evidence_runs WHERE id=$1",[run])).rows[0].status,'blocked');
 // Explicit human retry preserves prior failures and does not invent a PR.
 await pool.query("UPDATE task_orchestration_owners SET state='finished' WHERE task_id=$1",[task]);
 const retry=await retryTaskBrowserEvidence(pool,{projectId:project,taskId:task,actorId:user,reason:'Browser environment has been restored'});
 assert.equal(retry.status,'queued');
 assert.equal((await pool.query("SELECT count(*)::int n FROM task_evidence_runs WHERE task_id=$1",[task])).rows[0].n,2);
 assert.equal((await pool.query("SELECT pr_url FROM tasks WHERE id=$1",[task])).rows[0].pr_url,null);
});

test('a verified Vue compilation failure on the same immutable SHA prevents another pointless browser run',async t=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='evidence_broken_sha_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();});
 await runSchemaMigrations(pool,coreSchemaMigrations({analysis:'Анализ'}));
 const [user,project,task]=Array.from({length:3},randomUUID);
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'broken-sha@example.test','hash')",[user]);
 await pool.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Screenshots',$2,true)",[project,user]);
 await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage) VALUES($1,$2,'Capture screenshots',$3,'task','analysis')",
  [task,project,'Capture current main page for SHA '+sha]);
 await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_completed','Confirmed')",[randomUUID(),task]);
 await pool.query("UPDATE tasks SET analysis_state='approved' WHERE id=$1",[task]);
 await pool.query("UPDATE tasks SET stage='development' WHERE id=$1",[task]);
 await routeTaskToBrowserEvidence(pool,{projectId:project,taskId:task,actorId:user,
  sourceSha:sha,reason:'Take desktop and mobile screenshots'});
 const compilerReport={
  commit:sha,summary:'Some tests succeeded',
  checks:[{name:'Локальная сборка',result:'failed',details:'Vue compiler error: v-else-if without adjacent v-if in AdminLogin.vue'}],
  findings:[{description:'Vue component compilation failed'}]
 };
 const temporalStarts=[];
 await pool.query(`INSERT INTO ai_test_runs(id,project_id,task_id,cycle_id,attempt,status,verdict,report)
  VALUES($1,$2,$3,$4,1,'completed','failed',$5)`,
  [randomUUID(),project,task,randomUUID(),JSON.stringify(compilerReport)]);
 assert.equal(confirmedSourceBuildFailure(compilerReport),true);
 assert.equal(confirmedSourceBuildFailure({...compilerReport,checks:[{name:'Открытие браузера',result:'failed',details:'Timeout'}]}),false);
 assert.match(await confirmedEvidenceSourceBlocker(pool,{projectId:project,taskId:task,sourceSha:sha}),/ошибка компиляции/);
 await reconcileTaskEvidenceQueue(pool,async()=>({workflow:{start:async()=>temporalStarts.push(1)}}));
 assert.deepEqual(temporalStarts,[],'known unbuildable commit must not consume another Codex run');
 const evidence=(await pool.query('SELECT status,message FROM task_evidence_runs WHERE task_id=$1',[task])).rows;
 assert.equal(evidence.length,1);
 assert.equal(evidence[0].status,'blocked');
 assert.match(evidence[0].message,/закреплённом SHA/);
 await assert.rejects(retryTaskBrowserEvidence(pool,{projectId:project,taskId:task,actorId:user,
  reason:'Repeat the same failed attempt again'}),/ошибка компиляции/);
 await assert.rejects(routeTaskToBrowserEvidence(pool,{projectId:project,taskId:task,actorId:user,
  sourceSha:sha,reason:'Repeat with the exact same immutable commit'}),/ошибка компиляции/);
 assert.equal(await confirmedEvidenceSourceBlocker(pool,{projectId:project,taskId:task,sourceSha:'b'.repeat(40)}),null);
 const duplicate=randomUUID();
 await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage) VALUES($1,$2,'Another screenshot task',$3,'task','analysis')",
  [duplicate,project,'Capture screenshots for SHA '+sha]);
 await assert.rejects(routeTaskToBrowserEvidence(pool,{
  projectId:project,taskId:duplicate,actorId:user,sourceSha:sha,
  reason:'Retry screenshot generation from another card'
 }),/ошибка компиляции/,'creating a duplicate card must not bypass the same verified immutable-source blocker');
});

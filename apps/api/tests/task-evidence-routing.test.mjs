import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {routeTaskToBrowserEvidence,retryTaskBrowserEvidence} from '../dist/task-evidence-routing.js';
import {reconcileTaskEvidenceQueue,finishTaskEvidenceRun} from '../dist/task-evidence-queue.js';

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

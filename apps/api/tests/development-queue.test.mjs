import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {carryDevelopmentAuthorizationAfterAnalysis,enqueueDevelopment,initAgentWorkQueue,readDevelopmentQueue,reconcileAgentWorkQueue} from '../dist/agent-work-scheduler.js';
import {initTaskOrchestrationSchema,releaseTaskOrchestration} from '../dist/task-orchestration.js';

test('development queue binds approval, skips blocked tasks and retries one stable Temporal start',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='development_queue_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid,deleted_at timestamptz,agents_running boolean NOT NULL DEFAULT true);
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE project_iterations(id uuid PRIMARY KEY,project_id uuid,revision int,approved_revision int);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,iteration_id uuid,title text DEFAULT '',display_number int DEFAULT 1,
   type text DEFAULT 'task',stage text DEFAULT 'analysis',analysis_state text DEFAULT 'ready_for_development',
   spec_version int DEFAULT 1,spec_reviewed_version int DEFAULT 1,spec_review_status text DEFAULT 'current',
   clarification_questions jsonb DEFAULT '[]',priority int DEFAULT 2,depends_on_task_id uuid,git_branch text,pr_url text,
   pr_base_branch text,test_feedback text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  CREATE TABLE project_ai_settings(project_id uuid,enabled boolean,model text,reasoning text);
  CREATE TABLE project_agent_models(project_id uuid,role text,model text);
  CREATE TABLE project_role_capacity(project_id uuid,role text,capacity int);
  CREATE TABLE project_git_repositories(project_id uuid,connection_id uuid);
  CREATE TABLE connections(id uuid,provider text);
  CREATE TABLE task_agent_notes(task_id uuid,project_id uuid,kind text,status text,target_stage text NOT NULL DEFAULT 'all',requires_customer boolean NOT NULL DEFAULT false);
  CREATE TABLE agent_peer_queue(project_id uuid,role text,status text);
  CREATE TABLE ai_task_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid,triggered_by uuid,model text,status text,message text NOT NULL DEFAULT '',cycle_id uuid,cycle_attempt int,created_at timestamptz DEFAULT now());
  CREATE TABLE ai_test_runs(id uuid PRIMARY KEY,task_id uuid,status text,verdict text,completed_at timestamptz DEFAULT now());
  CREATE TABLE process_events(id uuid,project_id uuid,process_id uuid,process_kind text,stage text,detail text);
  CREATE TABLE task_events(id uuid,task_id uuid,actor_id uuid,event text,detail text);
  CREATE TABLE iteration_execution_queue(project_id uuid,iteration_id uuid NOT NULL,task_id uuid,requested_by uuid,
   status text DEFAULT 'queued' CHECK(status IN ('queued','dispatching','dispatched','cancelled')),run_id uuid,
   detail text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(project_id,task_id));
 `);
 await initTaskOrchestrationSchema(db);
 const project=randomUUID(),iteration=randomUUID(),actor=randomUUID(),connection=randomUUID();
 const [legacy,first,second,dependency,changedSpec]=Array.from({length:5},randomUUID);
 await db.query('INSERT INTO projects(id,owner_id) VALUES($1,$2)',[project,actor]);
 await db.query('INSERT INTO users VALUES($1)',[actor]);
 await db.query('INSERT INTO project_iterations VALUES($1,$2,1,1)',[iteration,project]);
 await db.query("INSERT INTO project_ai_settings VALUES($1,true,'gpt-6-luna','low')",[project]);
 await db.query("INSERT INTO connections VALUES($1,'github_token')",[connection]);
 await db.query('INSERT INTO project_git_repositories VALUES($1,$2)',[project,connection]);
 await db.query("INSERT INTO tasks(id,project_id,iteration_id) SELECT unnest($1::uuid[]),$2,$3",[[legacy,first,second,changedSpec],project,iteration]);
 await db.query("INSERT INTO tasks(id,project_id,stage) VALUES($1,$2,'backlog')",[dependency,project]);
 await db.query("INSERT INTO iteration_execution_queue(project_id,iteration_id,task_id,requested_by) VALUES($1,$2,$3,$4)",[project,iteration,legacy,actor]);
 await initAgentWorkQueue(db);
 const launch=async scope=>{
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   const result=await enqueueDevelopment(client,project,actor,scope);
   await client.query('COMMIT');
   return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 };
 const starts=[];
 let failDelivery=false;
 const temporal=async()=>({workflow:{start:async(_name,options)=>{
  starts.push(options);
  if(failDelivery){failDelivery=false;throw Error('temporary Temporal outage');}
 }}});
 const dispatch=()=>reconcileAgentWorkQueue(db,temporal);
 const status=async task=>(await db.query('SELECT status,run_id,approved_revision FROM iteration_execution_queue WHERE task_id=$1',[task])).rows[0];

 assert.equal((await status(legacy)).status,'stale');
 await launch({iterationId:iteration,revision:1,taskIds:[first]});
 await db.query('UPDATE project_iterations SET revision=2,approved_revision=2 WHERE id=$1',[iteration]);
 assert.equal(await carryDevelopmentAuthorizationAfterAnalysis(db,{projectId:project,taskId:first,iterationId:iteration,previousVersion:1,version:2}),false);
 await dispatch();
 assert.equal(starts.length,0,'approving a new revision must not launch a prior request');
 assert.equal((await status(first)).status,'stale');

 const blocked=Array.from({length:81},randomUUID);
 await db.query('INSERT INTO tasks(id,project_id,iteration_id,priority,depends_on_task_id) SELECT unnest($1::uuid[]),$2,$3,1,$4',
  [blocked,project,iteration,dependency]);
 await launch({iterationId:iteration,revision:2,taskIds:blocked});
 await launch({iterationId:iteration,revision:2,taskIds:[changedSpec]});
 await db.query('UPDATE tasks SET spec_version=2,spec_reviewed_version=2 WHERE id=$1',[changedSpec]);
 const [fromPlan,fromCard]=await Promise.all([
  launch({iterationId:iteration,revision:2,taskIds:[first]}),
  launch({taskId:first,approveAnalysis:true})
 ]);
 const runId=fromPlan.tasks[0].run_id;
 assert.equal(fromCard.tasks[0].run_id,runId,'concurrent entry points reuse one queued attempt');
 assert.match((await readDevelopmentQueue(db,project)).find(row=>row.task_id===blocked[0]).detail,/задачи-основания/);

 failDelivery=true;
 await dispatch(); // A transient outage is recorded for retry, not propagated across projects.
 assert.equal((await status(first)).status,'dispatching');
 await dispatch();
 assert.equal((await status(first)).status,'dispatched');
 assert.equal((await status(changedSpec)).status,'stale');
 assert.deepEqual(starts.map(run=>run.workflowId),['task-cycle-'+runId,'task-cycle-'+runId]);
 assert.equal(starts[0].workflowIdReusePolicy,'REJECT_DUPLICATE');
 assert.equal((await db.query('SELECT count(*)::int AS total FROM ai_task_runs')).rows[0].total,1);

 await launch({iterationId:iteration,revision:2,taskIds:[second]});
 await db.query('UPDATE tasks SET spec_version=2,spec_reviewed_version=2 WHERE id=$1',[second]);
 assert.equal(await carryDevelopmentAuthorizationAfterAnalysis(db,{projectId:project,taskId:second,iterationId:iteration,previousVersion:1,version:2}),true);
 assert.match((await readDevelopmentQueue(db,project)).find(row=>row.task_id===second).detail,/слот разработчика/);
 await dispatch();
 assert.equal(starts.length,2);
 await db.query("UPDATE ai_task_runs SET status='completed' WHERE id=$1",[runId]);
 await releaseTaskOrchestration(db,project,first,runId);
 await dispatch();
 assert.equal(starts[2].args[0].taskId,second);

 const automatic=randomUUID();
 await db.query("UPDATE ai_task_runs SET status='completed' WHERE task_id=$1",[second]);
 await releaseTaskOrchestration(db,project,second,(await status(second)).run_id);
 await db.query(`INSERT INTO tasks(id,project_id,iteration_id,stage,analysis_state,spec_review_status,priority)
  VALUES($1,$2,$3,'development','approved','pending',0)`,[automatic,project,iteration]);
 await db.query('UPDATE project_iterations SET approved_revision=NULL WHERE id=$1',[iteration]);
 await dispatch();
 await dispatch();
 assert.equal(starts[3].args[0].taskId,automatic,'analysis handoff is sufficient for automatic development');
 assert.equal(starts.length,4,'the same task is dispatched once');
 assert.equal((await db.query('SELECT triggered_by FROM ai_task_runs WHERE task_id=$1',[automatic])).rows[0].triggered_by,actor);

 // A completed run does not restart merely because the card is still visible
 // in Development. Rework must be driven by concrete QA/PM feedback.
 await db.query("UPDATE ai_task_runs SET status='completed' WHERE task_id=$1",[automatic]);
 await releaseTaskOrchestration(db,project,automatic,(await status(automatic)).run_id);
 await dispatch();
 assert.equal(starts.length,4,'already completed work without new feedback must not rerun');
 await db.query("UPDATE tasks SET test_feedback='QA: fix 360px responsive circles, keep existing PR',git_branch=$2,pr_url=$3,updated_at=now() WHERE id=$1",
  [first,first,'https://github.com/example/repo/pull/9']);
 const oldRunId=(await status(first)).run_id;
 await dispatch();
 assert.equal(starts.length,5,'a returned QA task must be requeued exactly once');
 assert.equal(starts[4].args[0].taskId,first);
 const next=await status(first);
 assert.equal(next.status,'dispatched');
 assert.notEqual(next.run_id,oldRunId,'rework uses a fresh run preserving earlier history');
 assert.equal((await db.query('SELECT count(*)::int n FROM ai_task_runs WHERE task_id=$1',[first])).rows[0].n,2);
 const preserved=(await db.query('SELECT git_branch,pr_url,test_feedback FROM tasks WHERE id=$1',[first])).rows[0];
 assert.equal(preserved.git_branch,first);
 assert.match(preserved.pr_url,/pull\/9/);
 assert.match(preserved.test_feedback,/360px/);
 await dispatch();
 assert.equal(starts.length,5,'active rework must not launch duplicate developers');
 await db.query("UPDATE ai_task_runs SET status='failed' WHERE id=$1",[next.run_id]);
 await releaseTaskOrchestration(db,project,first,next.run_id);
 await dispatch();
 assert.equal(starts.length,5,'failed rework must not requeue itself forever without new comments');

 // A failed developer run itself updates tasks.test_feedback + tasks.updated_at.
 // With the old r.created_at >= t.updated_at guard, the same Git 128 failure
 // starts indefinitely every 5-second scheduling tick.
 const broken=randomUUID(),priorRun=randomUUID();
 const exactFailure='git завершился с кодом 128: fatal: refs/remotes/origin/main...HEAD: no merge base';
 await db.query("INSERT INTO tasks(id,project_id,iteration_id,stage,analysis_state,test_feedback,updated_at) VALUES($1,$2,$3,'development','approved',$4,now())",
  [broken,project,iteration,exactFailure]);
 await db.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status,message,created_at) VALUES($1,$2,$3,$4,'gpt-6-luna','failed',$5,now()-interval '2 minutes')",
  [priorRun,project,broken,actor,exactFailure]);
 await dispatch();
 await dispatch();
 assert.equal(starts.length,5,'same developer failure must not create another cycle even though task timestamp is newer');
 // A truly new owner/QA instruction remains eligible for a new attempt.
 await db.query("UPDATE tasks SET test_feedback=$2,updated_at=now() WHERE id=$1",
  [broken,'QA нашёл новый воспроизводимый дефект на обновлённом SHA; требуется исправление']);
 await dispatch();
 assert.equal(starts.length,6,'new distinct feedback permits another attempt without bypassing QA');
 assert.equal(starts.at(-1).args[0].taskId,broken);
 await db.query("UPDATE ai_task_runs SET status='completed' WHERE task_id=$1 AND status IN ('queued','running')",[broken]);
 await releaseTaskOrchestration(db,project,broken,(await status(broken)).run_id);
 // A blocked QA must never be interpreted as a request for another developer
 // cycle. Only an actual reproducible failed test is eligible for rework.
 const qaBlocked=randomUUID(),qaRun=randomUUID();
 await db.query("INSERT INTO tasks(id,project_id,iteration_id,stage,analysis_state,test_feedback) VALUES($1,$2,$3,'development','approved','QA: Chromium asserts were not executed')",
  [qaBlocked,project,iteration]);
 await db.query("INSERT INTO ai_test_runs(id,task_id,status,verdict) VALUES($1,$2,'completed','blocked')",[qaRun,qaBlocked]);
 await dispatch();
 assert.equal(starts.length,6,'blocked QA cannot auto-assign the developer');
 await db.query("UPDATE ai_test_runs SET verdict='failed' WHERE id=$1",[qaRun]);
 await dispatch();
 assert.equal(starts.length,7,'a real QA failure can authorize developer rework');
 assert.equal(starts.at(-1).args[0].taskId,qaBlocked);
});

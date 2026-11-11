import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Client as TemporalClient} from '@temporalio/client';
import {acquireTaskOrchestration,releaseTaskOrchestration} from './task-orchestration.js';

/** An approved iteration launch is a durable intent, not a one-shot batch of HTTP requests.
 * Only tasks explicitly launched by the owner or the project manager are eligible.
 * Questions and real code dependencies postpone individual tasks, not the whole iteration.
 */
export async function initAgentWorkQueue(pool:Pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS iteration_execution_queue (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  iteration_id uuid NOT NULL REFERENCES project_iterations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','dispatching','dispatched','cancelled')),
  run_id uuid,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,task_id)
 );
 CREATE INDEX IF NOT EXISTS idx_iteration_execution_queue_pending ON iteration_execution_queue(status,created_at);`);
}
export async function enqueueIterationWork(pool:Pick<Pool,'query'>,projectId:string,iterationId:string,actorId:string,revision:number,taskIds?:string[]){
 const i=await pool.query('SELECT revision,approved_revision FROM project_iterations WHERE id=$1 AND project_id=$2',[iterationId,projectId]);
 if(!i.rowCount||i.rows[0].revision!==revision||i.rows[0].approved_revision!==revision)
  throw Object.assign(Error('Итерация не согласована или её редакция изменилась'),{statusCode:409});
 const values=taskIds?.length?taskIds:null;
 const tasks=await pool.query(`SELECT id,stage FROM tasks WHERE project_id=$1 AND iteration_id=$2 AND type<>'epic'
  AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])) AND stage<>'done'`,[projectId,iterationId,values]);
 if(values&&tasks.rows.length!==new Set(values).size)
  throw Object.assign(Error('Выбранные задачи не найдены в итерации либо уже завершены'),{statusCode:409});
 for(const task of tasks.rows){
  await pool.query(`INSERT INTO iteration_execution_queue(project_id,iteration_id,task_id,requested_by)
   VALUES($1,$2,$3,$4) ON CONFLICT(project_id,task_id) DO UPDATE
   SET status=CASE WHEN iteration_execution_queue.status='cancelled' THEN 'queued' ELSE iteration_execution_queue.status END,
   updated_at=now()`,[projectId,iterationId,task.id,actorId]);
 }
 return {queued:tasks.rows.length,iteration_id:iterationId,tasks:tasks.rows};
}

/** Polling reconciles missed notifications and crashed API processes without consuming Codex.
 * The short-lived DB lock serializes dispatcher decisions; Codex is not held while waiting.
 */
export async function reconcileAgentWorkQueue(pool:Pool,temporal:()=>Promise<TemporalClient>){
 const db=await pool.connect();
 let acquired=false;
 try{
  const lock=await db.query("SELECT pg_try_advisory_lock(hashtext('ado-iteration-development-queue')) AS locked");
  acquired=lock.rows[0]?.locked===true;
  if(!acquired)return;
  // Recover a crash after DB commit but before the Temporal start call.
  const orphan=await db.query("SELECT project_id,task_id,run_id FROM iteration_execution_queue WHERE status='dispatching' AND run_id IS NOT NULL ORDER BY updated_at LIMIT 1");
  if(orphan.rowCount){
   const pending=orphan.rows[0];
   const row=await db.query('SELECT status FROM ai_task_runs WHERE id=$1',[pending.run_id]);
   if(!row.rowCount||row.rows[0].status==='failed'){
    await db.query("UPDATE iteration_execution_queue SET status='queued',run_id=NULL,updated_at=now() WHERE project_id=$1 AND task_id=$2",[pending.project_id,pending.task_id]);
   }else{
    try{
     const client=await temporal();
     await client.workflow.start('developmentTestingCycle',{taskQueue:'agent-pipeline',workflowId:'task-cycle-'+pending.run_id,args:[{projectId:pending.project_id,taskId:pending.task_id,runId:pending.run_id,maxFixes:3}]});
    }catch(error){
     if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name))throw error;
    }
    await db.query("UPDATE iteration_execution_queue SET status='dispatched',detail='Запуск восстановлен',updated_at=now() WHERE project_id=$1 AND task_id=$2",[pending.project_id,pending.task_id]);
   }
   return;
  }
  // One active development run system-wide. QA already runs independently in Codex Runner.
  const busy=await db.query("SELECT 1 FROM ai_task_runs WHERE status IN ('queued','running') LIMIT 1");
  if(busy.rowCount)return;
  const pending=await db.query(`SELECT q.project_id,q.iteration_id,q.task_id,q.requested_by,t.stage,t.analysis_state,
    t.spec_review_status,t.clarification_questions,t.depends_on_task_id,t.pr_base_branch,
    t.spec_version,i.revision,i.approved_revision,settings.model,settings.enabled,
    dep.stage AS dependency_stage,dep.git_branch AS dependency_branch,dep.pr_url AS dependency_pr,
    EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.task_id=t.id AND n.kind='question' AND n.status IN ('open','processing')) AS open_questions
   FROM iteration_execution_queue q
   JOIN tasks t ON t.id=q.task_id AND t.project_id=q.project_id
   JOIN project_iterations i ON i.id=q.iteration_id
   JOIN project_ai_settings settings ON settings.project_id=q.project_id
   LEFT JOIN tasks dep ON dep.id=t.depends_on_task_id AND dep.project_id=t.project_id
   WHERE q.status='queued' AND i.approved_revision=i.revision
   ORDER BY q.created_at,q.task_id LIMIT 80`);
  for(const t of pending.rows){
   if(!t.enabled||t.open_questions||t.clarification_questions?.length||['pending','needs_approval'].includes(t.spec_review_status))continue;
   if(t.stage==='analysis'&&(t.analysis_state!=='ready_for_development'||t.spec_review_status!=='current'))continue;
   if(t.stage==='development'&&t.analysis_state!=='approved')continue;
   if(!['analysis','development'].includes(t.stage)){
    // The work may already have advanced via the manual API.
    if(['testing','merge_queue','deployment','documentation','done'].includes(t.stage))
     await db.query("UPDATE iteration_execution_queue SET status='dispatched',detail='Задача уже перешла на следующий этап',updated_at=now() WHERE project_id=$1 AND task_id=$2 AND status='queued'",[t.project_id,t.task_id]);
    continue;
   }
   if(t.depends_on_task_id&&!(['deployment','documentation','done'].includes(t.dependency_stage)||
     (t.dependency_stage==='merge_queue'&&t.dependency_pr&&t.dependency_branch)))continue;
   // Prior manual execution takes precedence. Never launch a duplicate cycle.
   const existing=await db.query("SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND status IN ('queued','running','completed') AND created_at>=(SELECT created_at FROM iteration_execution_queue WHERE project_id=$2 AND task_id=$1) LIMIT 1",[t.task_id,t.project_id]);
   if(existing.rowCount){await db.query("UPDATE iteration_execution_queue SET status='dispatched',detail='Задача уже запущена',updated_at=now() WHERE project_id=$1 AND task_id=$2",[t.project_id,t.task_id]);continue;}
   const runId=randomUUID();
   await db.query('BEGIN');
   try{
    const claimed=await db.query("UPDATE iteration_execution_queue SET status='dispatching',run_id=$3,updated_at=now() WHERE project_id=$1 AND task_id=$2 AND status='queued' RETURNING task_id",[t.project_id,t.task_id,runId]);
    if(!claimed.rowCount){await db.query('ROLLBACK');continue;}
    const locked=await db.query("SELECT stage,analysis_state,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE",[t.task_id,t.project_id]);
    if(!locked.rowCount||locked.rows[0].stage!==t.stage||locked.rows[0].analysis_state!==t.analysis_state||locked.rows[0].spec_review_status!==t.spec_review_status){await db.query('ROLLBACK');continue;}
    const owned=await acquireTaskOrchestration(db,t.project_id,t.task_id,runId,'task-cycle-'+runId,'development');
    if(!owned){await db.query('ROLLBACK');continue;}
    if(t.stage==='analysis'){
     await db.query("UPDATE tasks SET stage='development',analysis_state='approved',updated_at=now() WHERE id=$1",[t.task_id]);
     await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'stage_changed','Анализ → Разработка: автоматический запуск согласованной итерации')",[randomUUID(),t.task_id,t.requested_by]);
    }
    if(t.depends_on_task_id&&t.dependency_stage==='merge_queue')
     await db.query('UPDATE tasks SET pr_base_branch=$2 WHERE id=$1',[t.task_id,t.dependency_branch]);
    await db.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status,cycle_id,cycle_attempt) VALUES($1,$2,$3,$4,$5,'queued',$1,0)",[runId,t.project_id,t.task_id,t.requested_by,t.model]);
    await db.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'development','queued','Диспетчер передал готовую задачу разработчику')",[randomUUID(),t.project_id,runId]);
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
   try{
    const client=await temporal();
    await client.workflow.start('developmentTestingCycle',{taskQueue:'agent-pipeline',workflowId:'task-cycle-'+runId,args:[{projectId:t.project_id,taskId:t.task_id,runId,maxFixes:3}]});
    await db.query("UPDATE iteration_execution_queue SET status='dispatched',detail='Передано Temporal',updated_at=now() WHERE project_id=$1 AND task_id=$2",[t.project_id,t.task_id]);
   }catch(error){
    await db.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,'Не удалось передать Temporal: '+String(error).slice(0,400)]);
    await releaseTaskOrchestration(pool,t.project_id,t.task_id,runId);
    await db.query("UPDATE iteration_execution_queue SET status='queued',run_id=NULL,detail=$3,updated_at=now() WHERE project_id=$1 AND task_id=$2",[t.project_id,t.task_id,'Повторная постановка после ошибки Temporal']);
    if(t.stage==='analysis')await db.query("UPDATE tasks SET stage='analysis',analysis_state='ready_for_development' WHERE id=$1 AND stage='development' AND NOT EXISTS(SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND status IN ('queued','running'))",[t.task_id]);
   }
   return; // Reconcile another task after the active developer finishes.
  }
 }finally{
  if(acquired)await db.query("SELECT pg_advisory_unlock(hashtext('ado-iteration-development-queue'))").catch(()=>{});
  db.release();
 }
}

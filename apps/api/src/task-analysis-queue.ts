import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Client as TemporalClient} from '@temporalio/client';
import {roleCapacity} from './project-team.js';

export async function initTaskAnalysisQueue(pool:Pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS agent_analysis_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  spec_version integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','waiting','failed','cancelled')),
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_agent_analysis_runs_project ON agent_analysis_runs(project_id,status,created_at);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_analysis_runs_active ON agent_analysis_runs(task_id) WHERE status IN ('queued','running');`);
}
export async function reconcileTaskAnalysisQueue(pool:Pool,temporal:()=>Promise<TemporalClient>){
 const db=await pool.connect();
 let locked=false;
 try{
  locked=(await db.query("SELECT pg_try_advisory_lock(hashtext('ado-task-analysis-stage')) AS locked")).rows[0]?.locked===true;
  if(!locked)return;
  // Recover an interrupted API dispatch (idempotent workflow ID).
  const pending=await db.query(`SELECT id,project_id,task_id,status FROM agent_analysis_runs
   WHERE status='queued' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=agent_analysis_runs.project_id AND p.agents_running) ORDER BY created_at LIMIT 10`);
  for(const run of pending.rows){
   try{
    const c=await temporal();
    try{await c.workflow.start('analyzeTaskStage',{taskQueue:'agent-pipeline',workflowId:'task-analysis-'+run.id,args:[run.id]});}
    catch(e){if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((e as Error).name))throw e;}
   }catch{/* Retry this run next tick, without blocking other projects. */ continue;}
  }

  // Ready means the analyst finalized this task's requirements, independent of epic siblings.
  const ready=await db.query(`SELECT t.id,t.project_id,t.iteration_id,t.display_number FROM tasks t
   WHERE t.stage='analysis' AND t.type IN ('task','bug','improvement') AND t.analysis_state='ready_for_development'
    AND EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.agents_running)
    AND coalesce(jsonb_array_length(t.clarification_questions),0)=0
    AND NOT EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.task_id=t.id AND n.kind='question' AND n.status IN ('open','processing'))
    AND NOT EXISTS(SELECT 1 FROM agent_analysis_runs a WHERE a.task_id=t.id AND a.status IN ('queued','running'))

   ORDER BY t.priority,t.created_at LIMIT 10`);
  for(const t of ready.rows){
   const updated=await db.query(`UPDATE tasks SET stage='development',analysis_state='approved',updated_at=now()
    WHERE id=$1 AND project_id=$2 AND stage='analysis' AND analysis_state='ready_for_development'
    AND coalesce(jsonb_array_length(clarification_questions),0)=0
    AND NOT EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.task_id=$1 AND n.kind='question' AND n.status IN ('open','processing'))
    RETURNING id`,[t.id,t.project_id]);
   if(updated.rowCount){
    await db.query(`INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'stage_changed',$3)`,
      [randomUUID(),t.id,'Аналитик завершил анализ и передал задачу в разработку.']);
    await db.query(`INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status)
     VALUES($1,$2,$3,'analysis','Системный аналитик','development','handoff',$4,'agent',$5,'resolved') ON CONFLICT(task_id,source_key) DO NOTHING`,
      [randomUUID(),t.project_id,t.id,'ТЗ готово. Разработчик получит задачу автоматически.','analysis-stage-ready:'+t.id]);
   }
  }
  // Interleave projects before applying a bounded scan. A busy project's long
  // backlog must not hide another project's ready analyst work.
  const candidates=await db.query(`SELECT id,project_id,spec_version FROM (
   SELECT t.id,t.project_id,t.spec_version,t.priority,t.created_at,
    row_number() OVER(PARTITION BY t.project_id ORDER BY t.priority,t.created_at,t.id) AS project_position
   FROM tasks t JOIN project_ai_settings ai ON ai.project_id=t.project_id AND ai.enabled=true
   WHERE t.stage='analysis' AND t.type IN ('task','bug','improvement') AND t.analysis_state='new'
    AND EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.agents_running)
    AND NOT EXISTS(SELECT 1 FROM agent_analysis_runs a WHERE a.task_id=t.id AND a.status IN ('queued','running'))
    AND NOT EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.task_id=t.id AND n.kind='question' AND n.status IN ('open','processing'))
  ) ready ORDER BY project_position,priority,created_at,id LIMIT 100`);
  for(const t of candidates.rows){
   const capacity=await roleCapacity(pool,t.project_id,'analysis');
   const running=await db.query(`SELECT count(*)::int AS total FROM agent_analysis_runs
    WHERE project_id=$1 AND status IN ('queued','running')`,[t.project_id]);
   if(Number(running.rows[0]?.total||0)>=capacity)continue;
   const runId=randomUUID();
   await db.query('BEGIN');
   try{
    const claimed=await db.query(`UPDATE tasks SET analysis_state='processing',updated_at=now()
     WHERE id=$1 AND project_id=$2 AND stage='analysis' AND analysis_state='new'
     AND spec_version=$3 RETURNING id`,[t.id,t.project_id,t.spec_version]);
    if(!claimed.rowCount){await db.query('ROLLBACK');continue;}
    await db.query(`INSERT INTO agent_analysis_runs(id,project_id,task_id,spec_version)
     VALUES($1,$2,$3,$4)`,[runId,t.project_id,t.id,t.spec_version]);
    await db.query(`INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail)
     VALUES($1,$2,$3,'analysis','queued','Системный аналитик получил задачу для завершения анализа')`,[randomUUID(),t.project_id,runId]);
    await db.query('COMMIT');
   }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
   try{
    const c=await temporal();
    await c.workflow.start('analyzeTaskStage',{taskQueue:'agent-pipeline',workflowId:'task-analysis-'+runId,args:[runId]});
   }catch{/* Queued run will be recovered above. */}
  }
 }finally{
  if(locked)await db.query("SELECT pg_advisory_unlock(hashtext('ado-task-analysis-stage'))").catch(()=>{});
  db.release();
 }
}

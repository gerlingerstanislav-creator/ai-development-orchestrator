import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Client as TemporalClient} from '@temporalio/client';
import {acquireTaskOrchestration,releaseTaskOrchestration} from './task-orchestration.js';
import {PENDING_OWNER_QUESTION_SQL} from './task-question-gates.js';

/** Durable idempotent dispatch for work whose deliverable is visual evidence.
 * Never creates a development run or PR; the QA Runner owns the evidence.
 */
export async function reconcileTaskEvidenceQueue(pool:Pool,temporal:()=>Promise<TemporalClient>){
 const db=await pool.connect();
 let owned=false;
 try{
  owned=(await db.query("SELECT pg_try_advisory_lock(hashtext('ado-task-evidence-queue')) AS locked")).rows[0]?.locked===true;
  if(!owned)return;
  await db.query(`INSERT INTO task_evidence_runs(id,project_id,task_id,spec_version,source_sha)
   SELECT gen_random_uuid(),t.project_id,t.id,t.spec_version,t.evidence_source_sha
   FROM tasks t JOIN projects p ON p.id=t.project_id
   WHERE p.deleted_at IS NULL AND p.agents_running=true
    AND t.stage='testing' AND t.execution_mode='browser_evidence'
    AND t.analysis_state='approved' AND t.implementation_kind='artifact'
    AND t.evidence_source_sha IS NOT NULL
    AND coalesce(jsonb_array_length(t.clarification_questions),0)=0
    AND NOT EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.task_id=t.id AND n.project_id=t.project_id AND ${PENDING_OWNER_QUESTION_SQL})
    AND NOT EXISTS(SELECT 1 FROM task_evidence_runs r
      WHERE r.task_id=t.id AND r.spec_version=t.spec_version AND r.source_sha=t.evidence_source_sha)
   ORDER BY t.priority,t.created_at LIMIT 20
   ON CONFLICT DO NOTHING`);
  const queued=await db.query(`SELECT r.id,r.project_id,r.task_id,r.status,r.spec_version,r.source_sha
   FROM task_evidence_runs r JOIN tasks t ON t.id=r.task_id AND t.project_id=r.project_id
   JOIN projects p ON p.id=r.project_id AND p.agents_running=true AND p.deleted_at IS NULL
   WHERE r.status IN ('queued','dispatching')
    AND t.stage='testing' AND t.execution_mode='browser_evidence'
    AND t.spec_version=r.spec_version AND t.evidence_source_sha=r.source_sha
   ORDER BY r.created_at LIMIT 20`);
  for(const run of queued.rows){
   if(run.status==='queued'){
    await db.query('BEGIN');
    try{
     const active=await db.query("SELECT id,status FROM task_evidence_runs WHERE id=$1 AND status='queued' FOR UPDATE",[run.id]);
     const task=await db.query("SELECT id FROM tasks WHERE id=$1 AND project_id=$2 AND stage='testing' AND execution_mode='browser_evidence' AND spec_version=$3 AND evidence_source_sha=$4 FOR UPDATE",
      [run.task_id,run.project_id,run.spec_version,run.source_sha]);
     if(!active.rowCount||!task.rowCount||!await acquireTaskOrchestration(db,run.project_id,run.task_id,run.id,'task-evidence-'+run.id,'testing')){
      await db.query('ROLLBACK');continue;
     }
     await db.query("UPDATE task_evidence_runs SET status='dispatching',updated_at=now() WHERE id=$1",[run.id]);
     await db.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,task_id) VALUES($1,$2,$3,'testing','evidence_queued',$4,$5)",
      [randomUUID(),run.project_id,run.id,'Браузерное исполнение без PR: закреплённый SHA '+run.source_sha,run.task_id]);
     await db.query('COMMIT');
    }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
   }
   try{
    const client=await temporal();
    try{
     await client.workflow.start('browserEvidenceCycle',{
      taskQueue:'agent-pipeline',workflowId:'task-evidence-'+run.id,workflowIdReusePolicy:'REJECT_DUPLICATE',
      args:[{projectId:run.project_id,taskId:run.task_id,runId:run.id}]
     });
    }catch(error){
     if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name))throw error;
    }
    await db.query("UPDATE task_evidence_runs SET status='running',message='Исполнитель запущен через Temporal',updated_at=now() WHERE id=$1 AND status='dispatching'",[run.id]);
   }catch(error){
    // A queued dispatch can be retried safely. Do not discard existing artifacts
    // and do not open a second workflow while Temporal is unavailable.
    await db.query("UPDATE task_evidence_runs SET message=$2,updated_at=now() WHERE id=$1 AND status='dispatching'",
     [run.id,'Temporal недоступен: '+String(error).slice(0,350)]);
   }
  }
 }finally{
  if(owned)await db.query("SELECT pg_advisory_unlock(hashtext('ado-task-evidence-queue'))").catch(()=>{});
  db.release();
 }
}

/** Terminal result, always recorded before releasing durable task ownership. */
export async function finishTaskEvidenceRun(pool:Pick<Pool,'query'>,args:{
 projectId:string;taskId:string;runId:string;status:'completed'|'blocked'|'failed';message:string
}){
 const detail=args.message.slice(0,1800);
 await pool.query("UPDATE task_evidence_runs SET status=$4,message=$5,updated_at=now() WHERE id=$1 AND project_id=$2 AND task_id=$3 AND status IN ('dispatching','running')",
  [args.runId,args.projectId,args.taskId,args.status,detail]);
 if(args.status!=='completed')
  await pool.query("UPDATE tasks SET test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing' AND execution_mode='browser_evidence'",
   [args.taskId,args.projectId,detail]);
 await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level,task_id) VALUES($1,$2,$3,'testing',$4,$5,$6,$7)",
  [randomUUID(),args.projectId,args.runId,args.status==='completed'?'evidence_verified':'evidence_blocked',detail,args.status==='completed'?'info':'warning',args.taskId]);
}

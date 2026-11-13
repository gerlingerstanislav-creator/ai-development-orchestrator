import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

/** Continue an already completed developer handoff using the existing, evidence-
 * checking recovery API. Moving the card never marks QA or CI successful.
 * A durable process attempt throttles unavailable GitHub/Runner integrations. */
export async function reconcileIdlePullRequests(
 db:Pick<Pool,'query'>,
 recover:(input:{projectId:string;taskId:string;auth:string;cookie:string})=>Promise<{ok:boolean;status:number;message:string}>,
 ownerToken:(userId:string,email:string)=>Promise<string>
):Promise<void>{
 const candidates=await db.query(`SELECT t.id AS task_id,t.project_id,p.owner_id,u.email
  FROM tasks t
  JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL AND p.agents_running=true
  JOIN users u ON u.id=p.owner_id
  JOIN project_ai_settings ai ON ai.project_id=t.project_id AND ai.enabled=true
  WHERE t.type IN ('task','bug','improvement') AND t.stage='development'
   AND t.analysis_state='approved'
   AND NULLIF(BTRIM(t.pr_url),'') IS NOT NULL AND NULLIF(BTRIM(t.git_branch),'') IS NOT NULL
   AND t.pr_number IS NOT NULL
   AND COALESCE(t.test_feedback,'')=''
   AND t.spec_review_status='current'
   AND EXISTS(SELECT 1 FROM ai_task_runs r WHERE r.task_id=t.id AND r.status='completed')
   AND (SELECT r.status FROM ai_task_runs r WHERE r.task_id=t.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1)='completed'
   AND NOT EXISTS(SELECT 1 FROM ai_task_runs r WHERE r.task_id=t.id AND r.status IN ('queued','running'))
   AND NOT EXISTS(SELECT 1 FROM task_orchestration_owners o WHERE o.task_id=t.id AND o.state='active')
   AND NOT EXISTS(SELECT 1 FROM iteration_execution_queue q WHERE q.task_id=t.id AND q.status IN ('queued','dispatching'))
   AND NOT EXISTS(SELECT 1 FROM ai_test_runs qa WHERE qa.task_id=t.id AND
    qa.created_at >= (SELECT COALESCE(r.completed_at,r.created_at)
      FROM ai_task_runs r WHERE r.task_id=t.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1))
   AND NOT EXISTS(SELECT 1 FROM process_events e WHERE e.task_id=t.id
    AND e.process_kind='recovery' AND e.stage='attempt'
    AND e.created_at>now()-interval '2 minutes')
  ORDER BY t.updated_at,t.id LIMIT 5`);
 for(const task of candidates.rows){
  const attemptId=randomUUID();
  // Persist a visible attempt before making network calls, so retries cannot
  // hammer GitHub or create repeated QA workers every reconciliation tick.
  await db.query(`INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,task_id)
   VALUES($1,$2,$1,'recovery','attempt',$3,$4)`,
   [attemptId,task.project_id,'Автоматическое продолжение существующего PR до QA',task.task_id]);
  let outcome:{ok:boolean;status:number;message:string};
  try{
   const auth='Bearer '+await ownerToken(task.owner_id,task.email);
   outcome=await recover({projectId:task.project_id,taskId:task.task_id,auth,cookie:''});
  }catch(error){
   outcome={ok:false,status:503,message:String(error).slice(0,750)};
  }
  await db.query(`INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level,task_id)
   VALUES($1,$2,$3,'recovery',$4,$5,$6,$7)`,
   [randomUUID(),task.project_id,attemptId,outcome.ok?'continued':'blocked',outcome.message.slice(0,1400),
    outcome.ok?'info':'warning',task.task_id]);
 }
}

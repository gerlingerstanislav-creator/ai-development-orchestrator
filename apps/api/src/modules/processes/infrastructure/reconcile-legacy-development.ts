import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {developmentProcessDetail} from '../domain/development-process-detail.js';

type RunnerJob={
 status?:string;message?:string;branch?:string|null;prUrl?:string|null;baseBranch?:string|null;
 usage?:{input_tokens?:number;cached_input_tokens?:number;output_tokens?:number};
};
type LegacyRun={id:string;project_id:string;task_id:string;status:string;message:string|null};

/**
 * Older runs without a Temporal cycle still require polling after a deployment.
 * This reconciler runs from the process scheduler, never from GET /api/background-processes.
 * Database mutations and process events are committed atomically, and every update
 * is conditional on a still-running legacy process to avoid duplicate transitions
 * when two application replicas reconcile simultaneously.
 */
export function createLegacyDevelopmentReconciler(
 db:Pick<Pool,'query'|'connect'>,
 runner:(path:string)=>Promise<RunnerJob>,
 reportFailure:(error:unknown,runId:string)=>void
){
 let active:Promise<void>|null=null;

 async function reconcileOne(row:LegacyRun){
  let remote:RunnerJob|undefined;
  let status=row.status;
  let detail=developmentProcessDetail(row.message||'Работа над задачей');
  try{
   remote=await runner('/jobs/'+row.id);
   status=String(remote.status||status);
   detail=developmentProcessDetail(String(remote.message||detail)).slice(0,250);
  }catch(error){
   const message=error instanceof Error?error.message:String(error);
   if(message.includes('Задача не найдена'))return;
   const outage='Связь с исполнителем временно недоступна · ';
   if(!detail.startsWith(outage))detail=outage+detail;
   remote=undefined;
  }
  if(!['queued','running','completed','failed'].includes(status))return;
  const terminal=status==='completed'||status==='failed';
  if(!terminal&&status===row.status&&detail===row.message)return;
  let tx:Awaited<ReturnType<Pool['connect']>>|undefined;
  try{
   tx=await db.connect();
   await tx.query('BEGIN');
   const updated=terminal
    ?await tx.query(`UPDATE ai_task_runs SET status=$2,message=$3,branch=COALESCE($4,branch),
      pr_url=COALESCE($5,pr_url),completed_at=now()
      WHERE id=$1 AND cycle_id IS NULL AND status IN ('running','queued') RETURNING id`,
      [row.id,status,detail,remote?.branch||null,remote?.prUrl||null])
    :await tx.query(`UPDATE ai_task_runs SET status=$2,message=$3
      WHERE id=$1 AND cycle_id IS NULL AND status IN ('running','queued')
      AND (status IS DISTINCT FROM $2 OR message IS DISTINCT FROM $3) RETURNING id`,
      [row.id,status,detail]);
   if(updated.rowCount){
    if(terminal&&status==='completed'&&remote?.prUrl){
     const match=/\/pull\/(\d+)$/.exec(remote.prUrl);
     // A later workflow may already have advanced this task; never move it
     // back to testing in a legacy reconciliation pass.
     await tx.query("UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$6,updated_at=now() WHERE id=$1 AND project_id=$5 AND stage='development'",
      [row.task_id,remote.branch||null,remote.prUrl,match?Number(match[1]):null,row.project_id,remote.baseBranch||null]);
    }
    if(terminal&&remote?.usage){
     const u=remote.usage;
     await tx.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) SELECT $1,$2,$3,$4,'development',a.model,$5,$6,$7 FROM ai_task_runs a WHERE a.id=$4 ON CONFLICT(source_id) DO NOTHING",
      [randomUUID(),row.project_id,row.task_id,row.id,Math.max(0,Number(u.input_tokens)||0),Math.max(0,Number(u.cached_input_tokens)||0),Math.max(0,Number(u.output_tokens)||0)]);
    }
    await tx.query("INSERT INTO process_events(id,project_id,process_id,process_kind,level,stage,detail) VALUES($1,$2,$3,'development',$4,$5,$6)",
     [randomUUID(),row.project_id,row.id,status==='failed'?'error':'info',status,detail]);
   }
   await tx.query('COMMIT');
  }catch(error){
   if(tx)await tx.query('ROLLBACK').catch(()=>{});
   reportFailure(error,row.id);
  }finally{
   tx?.release();
  }
 }

 async function runOnce(){
  const result=await db.query(`SELECT id,project_id,task_id,status,message FROM ai_task_runs
    WHERE cycle_id IS NULL AND status IN ('queued','running')
    ORDER BY created_at ASC LIMIT 50`);
  const rows=result.rows as LegacyRun[];
  // Bounded concurrency avoids saturating Codex while making recovery
  // progress across multiple old runs.
  for(let i=0;i<rows.length;i+=4)
   await Promise.all(rows.slice(i,i+4).map(reconcileOne));
 }
 return function reconcileLegacyDevelopmentRuns():Promise<void>{
  if(active)return active;
  active=runOnce().finally(()=>{active=null;});
  return active;
 };
}

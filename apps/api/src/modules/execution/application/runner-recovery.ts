/** Application-owned recovery policy for Codex Runner outages and business failures.
 * This module has no Temporal dependencies, so process state can be tested alone.
 */
export type RunnerProcessKind='development'|'testing';
type Db={query:(sql:string,args:any[])=>Promise<{rowCount:number|null}>};
type EventPort=(projectId:string,runId:string,kind:string,stage:string,detail:string,level?:string)=>Promise<void>;

/** A 4xx from the Runner is a terminal job error, not a transient outage. */
export function runnerUnavailable(error:unknown){
 const status=(error as {statusCode?:number})?.statusCode;
 if(status&&status<500)throw error;
 return {status:'running' as const,message:'Ожидается восстановление связи с Codex Runner'};
}

export function createRunnerRecovery(db:Db,recordEvent:EventPort){
 async function failRunnerRun(kind:RunnerProcessKind,projectId:string,id:string,message:string){
  const table=kind==='development'?'ai_task_runs':'ai_test_runs';
  await db.query(`UPDATE ${table} SET status='failed',message=$2,completed_at=now() WHERE id=$1 AND status IN ('queued','running')`,[id,message]);
  await recordEvent(projectId,id,kind,'failed',message,'error');
  return {status:'failed' as const,message};
 }
 async function trackRunnerWait(kind:RunnerProcessKind,projectId:string,id:string,error?:unknown,recoveryDetail?:string){
  const status=(error as {statusCode?:number})?.statusCode;
  if(status&&status<500)return failRunnerRun(kind,projectId,id,(error as Error).message);
  const message=error?'Ожидается восстановление связи с Codex Runner':
   recoveryDetail?recoveryDetail.slice(0,1200):'Восстанавливается задание в Codex Runner';
  const table=kind==='development'?'ai_task_runs':'ai_test_runs';
  const change=await db.query(`UPDATE ${table} SET message=$2
   WHERE id=$1 AND status IN ('queued','running') AND message IS DISTINCT FROM $2 RETURNING id`,[id,message]);
  if(change.rowCount)await recordEvent(projectId,id,kind,'runner_recovery',message);
  return {status:'running' as const,message};
 }
 return {failRunnerRun,trackRunnerWait};
}

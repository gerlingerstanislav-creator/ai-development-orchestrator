/** Project deletion rules. All destructive operations require project ownership. */
export function projectDeletionConfirmation(name:string,confirmation:string):boolean{
 return name.trim().length>0 && confirmation===name;
}
export const activeProjectOperationChecks=[
 "SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
 "SELECT 1 FROM ai_test_runs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
 "SELECT 1 FROM document_import_jobs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
 "SELECT 1 FROM merge_process_runs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
 "SELECT 1 FROM requirement_review_runs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
 "SELECT 1 FROM task_orchestration_owners WHERE project_id=$1 AND state='active' LIMIT 1",
 "SELECT 1 FROM agent_sessions WHERE project_id=$1 AND status='running' AND expires_at>now() LIMIT 1"
] as const;
export async function findActiveProjectOperation(db:{query:(sql:string,params?:unknown[])=>Promise<{rowCount:number|null}>},projectId:string):Promise<number>{
 for(let i=0;i<activeProjectOperationChecks.length;i++){
  const r=await db.query(activeProjectOperationChecks[i],[projectId]);
  if(r.rowCount)return i+1;
 }
 return 0;
}

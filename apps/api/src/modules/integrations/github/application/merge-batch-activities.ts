import {createHash} from 'node:crypto';
import {loadMergeBatch,saveMergeResult,setMergeProgress,finishMergeBatch,type MergeResult} from '../../../../merge-batch.js';
import {runnerUnavailable} from '../../../execution/application/runner-recovery.js';
import {resolveRoleAiSettings,roleCapacity} from '../../../../project-team.js';

type MergeDb=Parameters<typeof loadMergeBatch>[0];

/** Retry-aware PR merge and conflict resolution, without Temporal SDK
 * dependencies. The existing workflow names and activity exports are retained. */
export function createMergeBatchActivities({
 pool,decrypt,runner,dispatch,mergeTaskPr,http=fetch
}:{
 pool:MergeDb;
 decrypt:(packed:string)=>string;
 runner:(path:string)=>Promise<any>;
 dispatch:(job:any)=>Promise<boolean>;
 mergeTaskPr:(projectId:string,taskId:string,actorId:string)=>Promise<unknown>;
 http?:typeof fetch;
}){
async function pendingMergeTasks(batchId:string){
 const batch=await loadMergeBatch(pool,batchId);
 return batch?.task_ids.filter(id=>!batch.results.some(result=>result.taskId===id))??[];
}

async function tryMergeBatchTask(batchId:string,taskId:string):Promise<{status:'merged'|'pending'|'conflict'|'skipped';reason?:string}>{
 const batch=await loadMergeBatch(pool,batchId);
 if(!batch?.task_ids.includes(taskId))return {status:'skipped',reason:'Задача отсутствует в очереди'};
 await setMergeProgress(pool,batchId,taskId,'Слияние PR '+(batch.results.length+1)+' из '+batch.task_ids.length);
 try{await mergeTaskPr(batch.project_id,taskId,batch.actor_id);return {status:'merged'};}
 catch(error){
  const reason=(error as Error).message;
  const status=(error as {statusCode?:number}).statusCode;
  if(!status||status>=500)throw error;
  if(/ещё вычисляет mergeability/i.test(reason))return {status:'pending',reason};
  if(/merge conflicts|содержит конфликт|mergeable.*dirty|GitHub отклонил слияние.*conflict/i.test(reason))return {status:'conflict',reason};
  return {status:'skipped',reason};
 }
}

async function pollMergeConflict(batchId:string,taskId:string,attempt:number):Promise<{status:'running'|'completed'|'failed';message?:string}>{
 const batch=await loadMergeBatch(pool,batchId);
 if(!batch?.task_ids.includes(taskId))return {status:'failed',message:'Задача отсутствует в очереди'};
 const hex=createHash('sha256').update(batchId+':'+taskId+':'+attempt).digest('hex').slice(0,32);
 const jobId=hex.replace(/^(........)(....)(....)(....)/,'$1-$2-$3-$4-');
 try{
  const remote=await runner('/jobs/'+jobId);
  if(['completed','failed','cancelled'].includes(remote.status))
   return {status:remote.status==='completed'?'completed':'failed',message:String(remote.message||'').slice(0,1200)};
  if(remote.status!=='interrupted')return {status:'running'};
 }catch(error){
  if((error as {statusCode?:number}).statusCode!==404)return runnerUnavailable(error);
 }
 await setMergeProgress(pool,batchId,taskId,'Разрешение конфликта PR через Codex');
 const {project_id:projectId,actor_id:actorId}=batch;
 const details=await pool.query(`SELECT t.title,t.description,t.pr_number,t.git_branch,g.repository,c.secret_encrypted,a.model,a.reasoning
  FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id
  JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3
  LEFT JOIN project_ai_settings a ON a.project_id=t.project_id
  WHERE t.id=$1 AND t.project_id=$2 AND t.stage='merge_queue'`,[taskId,projectId,actorId]);
 const row=details.rows[0];
 if(!row?.pr_number||row.git_branch!==taskId)return {status:'failed',message:'Не найдена рабочая ветка PR задачи'};
 const token=decrypt(row.secret_encrypted);
 const response=await http('https://api.github.com/repos/'+row.repository+'/pulls/'+row.pr_number,{
  headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},signal:AbortSignal.timeout(15000)
 });
 if(!response.ok)throw Error('Не удалось получить PR: HTTP '+response.status);
 const pr=await response.json() as any;
 if(pr.merged)return {status:'completed'};
 if(pr.state!=='open'||pr.head?.ref!==row.git_branch)return {status:'failed',message:'Рабочая ветка PR изменилась'};
 const ai=await resolveRoleAiSettings(pool,projectId,'development',{model:row.model||'gpt-6-luna',reasoning:row.reasoning||'low'});
 try{
  await dispatch({id:jobId,kind:'resolve-conflict',taskId,projectId,repository:row.repository,baseBranch:pr.base.ref,token,
   model:ai.model,reasoning:ai.reasoning,roleCapacity:await roleCapacity(pool,projectId,'development'),
   maxRuntimeSeconds:900,title:row.title,description:row.description||''});
 }catch(error){
  const status=(error as {statusCode?:number}).statusCode;
  if(status&&status<500)return {status:'failed',message:(error as Error).message};
  return runnerUnavailable(error);
 }
 return {status:'running'};
}
async function recordMergeBatchResult(batchId:string,result:MergeResult){await saveMergeResult(pool,batchId,result);}
async function completeMergeBatch(batchId:string,error?:string){await finishMergeBatch(pool,batchId,error);}

 return {pendingMergeTasks,tryMergeBatchTask,pollMergeConflict,recordMergeBatchResult,completeMergeBatch};
}

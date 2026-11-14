import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {DelegatedSandboxItem} from '../application/delegated-work-activities.js';

type Db=Pick<Pool,'query'>;
type ResponseBody={
 message?:string;error?:string;source_sha?:string|null;browser_available?:boolean;
 screenshots_saved?:number;usage?:{input_tokens:number;cached_input_tokens:number;output_tokens:number}
};
/** Infrastructure port: only the server sees GitHub credentials. A specialist
 * gets a sandbox with a pinned source checkout and verified browser bridge.
 */
export function createDelegatedRunner({pool,baseUrl,secret,decrypt,event,fetchImpl=fetch}:{
 pool:Db;baseUrl:string;secret:string;decrypt:(value:string)=>string;
 event:(projectId:string,processId:string,kind:string,stage:string,message:string)=>Promise<void>;
 fetchImpl?:typeof fetch;
}){
 return async function executeSandbox(item:DelegatedSandboxItem,assignmentId:string,prompt:string,
  ai:{model:string;reasoning:string}):Promise<string>{
  const source=await pool.query('SELECT g.repository,g.target_branch,g.default_branch,c.secret_encrypted '+
   'FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id '+
   "WHERE g.project_id=$1 AND c.provider='github_token' LIMIT 1",[item.project_id]);
  const git=source.rows[0];
  // SHA is extracted from task evidence, not used to choose a workflow.
  // Runner verifies the actual git checkout.
  const candidate=String(item.evidence_source_sha||item.implementation_commit||
   String(item.task_description||'').match(/\b[a-f0-9]{40}\b/i)?.[0]||'');
  const sourceSha=/^[a-f0-9]{40}$/i.test(candidate)?candidate.toLowerCase():undefined;
  const response=await fetchImpl(baseUrl+'/delegated-work',{
   method:'POST',
   headers:{'X-Runner-Secret':secret,'Content-Type':'application/json'},
   body:JSON.stringify({
    projectId:item.project_id,taskId:item.task_id||null,goalId:item.goal_id||null,assignmentId,
    actorId:item.project_owner_id,role:item.role,
    repository:git?.secret_encrypted?git.repository:null,
    branch:git?.target_branch||git?.default_branch||'main',
    token:git?.secret_encrypted?decrypt(git.secret_encrypted):undefined,
    sourceSha,prompt,model:ai.model,reasoning:ai.reasoning
   }),
   signal:AbortSignal.timeout(460000)
  });
  const result=await response.json().catch(()=>({})) as ResponseBody;
  if(!response.ok)throw Error('Изолированный исполнитель: '+String(result.error||response.status).slice(0,500));
  await event(item.project_id,assignmentId,'agent','runtime_completed',
   'Выполнено в изолированной среде. Git SHA: '+String(result.source_sha||'нет репозитория')+
   '; Chromium: '+(result.browser_available?'доступен':'недоступен')+
   '; сохранено скриншотов: '+Number(result.screenshots_saved||0));
  if(result.usage)await pool.query(
   'INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
   [randomUUID(),item.project_id,item.task_id,randomUUID(),'delegated_work',ai.model,
    Number(result.usage.input_tokens)||0,Number(result.usage.cached_input_tokens)||0,Number(result.usage.output_tokens)||0]);
  return String(result.message||'');
 };
}

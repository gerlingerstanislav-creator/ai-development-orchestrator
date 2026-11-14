/** Reuse already-published task code only after verifying the exact GitHub
 * task branch and live PR head. Persistence is a separate, atomic port.
 */
export type ExistingTaskPrInput={
 projectId:string;taskId:string;runId:string;actorId:string|null;
 repository:string;baseBranch:string;token:string;title:string;
};
export type RecoveredTaskPr={
 projectId:string;taskId:string;runId:string;actorId:string|null;
 branch:string;headSha:string;url:string;number:number;baseBranch:string;
};
type GithubPr={
 number?:number;head?:{ref?:string;sha?:string};base?:{ref?:string};
 state?:string;merged_at?:string|null;html_url?:string;
};
function failure(message:string,statusCode=502){
 return Object.assign(new Error(message),{statusCode});
}
function validNumber(pr:GithubPr){
 return Number.isInteger(pr.number)&&Number(pr.number)>0?Number(pr.number):null;
}
export function createExistingTaskPrRecovery({
 save,http=fetch
}:{save:(pr:RecoveredTaskPr)=>Promise<void>;http?:typeof fetch}){
 async function recover(input:ExistingTaskPrInput):Promise<boolean>{
  const {projectId,taskId,runId,actorId,repository,baseBranch,token,title}=input;
  const branch=taskId;
  const api='https://api.github.com/repos/'+repository;
  const headers={
   Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
   'X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'
  };
  const gh=async(endpoint:string,options:RequestInit={})=>{
   const response=await http(api+endpoint,{
    ...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(20000)
   });
   const data=await response.json().catch(()=>({})) as any;
   return {response,data};
  };
  const branchPath='/branches/'+encodeURIComponent(branch);
  const published=await gh(branchPath);
  if(published.response.status===404)return false;
  if(!published.response.ok)throw failure('Не удалось проверить ветку задачи в GitHub: HTTP '+published.response.status);
  const headSha=String(published.data?.commit?.sha||'');
  if(!/^[0-9a-f]{40}$/i.test(headSha))throw failure('GitHub не подтвердил SHA существующей ветки задачи');
  const comparison=await gh('/compare/'+encodeURIComponent(baseBranch)+'...'+encodeURIComponent(branch));
  if(!comparison.response.ok)throw failure('Не удалось сравнить ветки: GitHub HTTP '+comparison.response.status);
  if(!(Number(comparison.data?.ahead_by)>0))return false;
  if(comparison.data?.head_commit?.sha&&comparison.data.head_commit.sha!==headSha)
   throw failure('Ветка GitHub изменилась во время сравнения. Восстановление отложено.',409);
  const list=async(state:'open'|'closed')=>{
   const result=await gh('/pulls?state='+state+'&head='+
    encodeURIComponent(repository.split('/')[0]+':'+branch)+'&per_page=100');
   if(!result.response.ok)
    throw failure(result.response.status===403
     ?'GitHub HTTP 403: для восстановления PR нужны Pull requests: Read and write.'
     :'Не удалось получить '+state+' PR: GitHub HTTP '+result.response.status,
    result.response.status===403?409:502);
   if(!Array.isArray(result.data))throw failure('GitHub вернул некорректный список PR');
   return result.data as GithubPr[];
  };
  const patch=async(number:number,body:object)=>{
   const result=await gh('/pulls/'+number,{
    method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
   });
   if(!result.response.ok)
    throw failure('Не удалось обновить PR #'+number+': GitHub HTTP '+
     result.response.status+' '+String(result.data?.message||'').slice(0,180),409);
   return result.data as GithubPr;
  };
  const open=await list('open');
  let pr:GithubPr|undefined=open.find(item=>item.base?.ref===baseBranch)||open[0];
  if(pr&&pr.base?.ref!==baseBranch){
   const number=validNumber(pr);
   if(!number)throw failure('GitHub вернул PR без номера');
   pr=await patch(number,{base:baseBranch});
  }
  if(!pr){
   const closed=await list('closed');
   const old=closed.find(item=>!item.merged_at&&item.base?.ref===baseBranch);
   if(old){
    const number=validNumber(old);
    if(!number)throw failure('GitHub вернул PR без номера');
    pr=await patch(number,{state:'open'});
   }
  }
  if(!pr){
   const created=await gh('/pulls',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
     title:'AI: '+title.slice(0,180),
     body:'Изменения по задаче '+taskId+
      '\n\nПодготовлено AI Development Orchestrator. Проверь изменения перед слиянием.',
     head:branch,base:baseBranch,draft:false
    })
   });
   if(created.response.ok)pr=created.data as GithubPr;
   else if(created.response.status===422)
    pr=(await list('open')).find(item=>item.base?.ref===baseBranch);
   if(!pr)throw failure(created.response.status===403
    ?'GitHub HTTP 403: создание PR запрещено. Нужны Pull requests: Read and write.'
    :'Не удалось создать или найти PR: GitHub HTTP '+created.response.status+
     ' '+String(created.data?.message||'').slice(0,180),409);
  }
  const number=validNumber(pr);
  if(!number)throw failure('GitHub не подтвердил номер PR');
  // A list, PATCH or POST response may be stale. Read the current PR.
  const current=await gh('/pulls/'+number);
  if(!current.response.ok)throw failure('Не удалось проверить PR #'+number+
   ': GitHub HTTP '+current.response.status);
  const verified=current.data as GithubPr;
  if(verified.state!=='open'||verified.base?.ref!==baseBranch||
     verified.head?.ref!==branch||verified.head?.sha!==headSha||
     verified.number!==number||!verified.html_url)
   throw failure('PR #'+number+' не соответствует ветке, базовой ветке или опубликованному SHA. Требуется повторная проверка.',409);
  const finalBranch=await gh(branchPath);
  if(!finalBranch.response.ok||finalBranch.data?.commit?.sha!==headSha)
   throw failure('Ветка задачи изменилась во время восстановления PR. Повтори проверку.',409);
  await save({projectId,taskId,runId,actorId,branch,headSha,
   url:verified.html_url,number,baseBranch});
  return true;
 }
 return recover;
}

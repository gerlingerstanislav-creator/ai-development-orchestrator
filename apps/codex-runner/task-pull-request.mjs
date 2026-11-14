/** Task-owned GitHub PR publication/recovery, separate from the HTTP Runner.
 * Same branch and SHA are mandatory; concurrent GitHub writers may race.
 * Callers own job cancellation, Git operations, and the persistent checkpoint.
 */
export function createTaskPullRequestService({fetchImpl=fetch,assertJobActive=()=>{}}={}){
 const request=fetchImpl;
async function createPullRequest(job,branch,summary){
 const response=await request('https://api.github.com/repos/'+job.repository+'/pulls',{
  method:'POST',
  headers:{Authorization:'Bearer '+job.token,'Content-Type':'application/json',
   Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'},
  body:JSON.stringify({
   title:'AI: '+job.title.slice(0,180),
   body:'Автоматически подготовлено Codex по задаче '+job.taskId+'\n\nМодель: '+job.model+
   '\n\n'+summary.slice(0,1500)+'\n\nПроверьте изменения и тесты перед слиянием.',
   head:branch,base:job.baseBranch,draft:false
  }),
  signal:AbortSignal.timeout(25000)
 });
 if(!response.ok){
  throw new Error('GitHub PR HTTP '+response.status+
   (response.status===403||response.status===422?' — проверь Pull requests: Read and write и правила веток':''));
 }
 return response.json();
}
async function ensureTaskPullRequest(job,branch,commit,summary){
 const url='https://api.github.com/repos/'+job.repository;
 const headers={Authorization:'Bearer '+job.token,Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const list=async state=>{
  const response=await request(url+'/pulls?state='+state+'&head='+
   encodeURIComponent(job.repository.split('/')[0]+':'+branch)+'&per_page=100',{
    headers,signal:AbortSignal.timeout(20000)
   });
  if(!response.ok)throw Error('Не удалось проверить '+state+' PR: GitHub HTTP '+response.status);
  return response.json();
 };
 const patch=async(number,body)=>{
  const response=await request(url+'/pulls/'+number,{
   method:'PATCH',headers:{...headers,'Content-Type':'application/json'},
   body:JSON.stringify(body),signal:AbortSignal.timeout(20000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Не удалось восстановить PR #'+number+': GitHub HTTP '+response.status+
   ' '+String(data.message||'').slice(0,220));
  return data;
 };
 assertJobActive(job.id);
 const open=await list('open');
 let pr=open.find(item=>item.base?.ref===job.baseBranch);
 if(!pr&&open.length){
  // A PR for this task branch already exists against another base. Creating
  // another would hit 422; change the target explicitly and keep its history.
  pr=await patch(open[0].number,{base:job.baseBranch});
 }
 if(!pr){
  const closed=await list('closed');
  const recoverable=closed.find(item=>!item.merged_at&&item.base?.ref===job.baseBranch);
  if(recoverable)pr=await patch(recoverable.number,{state:'open'});
 }
 if(!pr){
  try{pr=await createPullRequest(job,branch,summary);}
  catch(error){
   // A concurrent writer may have created the PR between list and POST.
   const again=await list('open');
   pr=again.find(item=>item.base?.ref===job.baseBranch);
   if(!pr)throw error;
  }
 }
 if(pr.head?.sha!==commit||!pr.html_url){
  const current=await request(url+'/pulls/'+pr.number,{headers,signal:AbortSignal.timeout(20000)});
  if(current.ok)pr=await current.json();
 }
 if(pr.head?.sha!==commit||!pr.html_url)
  throw Error('PR #'+pr.number+' существует, но SHA ветки не совпадает с опубликованным коммитом. Не перезаписываем чужие изменения.');
 return pr.html_url;
}
 return {ensureTaskPullRequest};
}

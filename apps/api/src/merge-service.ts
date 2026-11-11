import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {deploymentDecision} from './deployment-stage.js';
import {qaWaiverAssessment} from './qa-waiver.js';
import {pendingAgentQuestions} from './task-agent-notes.js';

export function createMergeService(pool:Pool,decryptToken:(value:string)=>string){
async function restackChildren(projectId:string,parentId:string,parentHeadSha:string,parentBase:string,repository:string,token:string,actorId:string){
 const children=await pool.query("SELECT id,pr_number,pr_base_branch FROM tasks WHERE project_id=$1 AND depends_on_task_id=$2 AND stage='merge_queue' AND pr_number IS NOT NULL",[projectId,parentId]);
 if(!children.rowCount)return;
 const base='https://api.github.com/repos/'+repository;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const compare=await fetch(base+'/compare/'+encodeURIComponent(parentHeadSha)+'...'+encodeURIComponent(parentBase),{headers,signal:AbortSignal.timeout(15000)});
 const ancestry=await compare.json().catch(()=>({})) as any;
 const safe=compare.ok&&['ahead','identical'].includes(ancestry.status);
 for(const child of children.rows){
  if(child.pr_base_branch===parentBase)continue;
  try{
   if(!safe)throw new Error('Нельзя автоматически сменить базу: коммит родительской ветки не содержится в '+parentBase+'. Нужна безопасная пересборка ветки.');
   const updated=await fetch(base+'/pulls/'+child.pr_number,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({base:parentBase}),signal:AbortSignal.timeout(15000)});
   const data=await updated.json().catch(()=>({})) as any;
   if(!updated.ok)throw new Error('GitHub HTTP '+updated.status+': '+String(data.message||'').slice(0,150));
   await pool.query('UPDATE tasks SET pr_base_branch=$2,updated_at=now() WHERE id=$1',[child.id,parentBase]);
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),child.id,actorId,'pr_restacked','PR переключён на '+parentBase+' после слияния родителя '+parentId]);
  }catch(e){
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),child.id,actorId,'pr_restack_failed','PR ожидает смены базовой ветки: '+(e instanceof Error?e.message:String(e)).slice(0,320)]);
  }
 }
}
async function registerMergedDeployment(projectId:string,taskId:string,userId:string,mergeSha:string|null,prUrl:string){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const task=await client.query('SELECT stage FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,projectId]);
  if(!task.rowCount)throw new Error('Задача не найдена после слияния PR');
  if(task.rows[0].stage!=='merge_queue'){
   await client.query('COMMIT');
   return task.rows[0].stage as string;
  }
  const mode=(await client.query("SELECT mode FROM project_deployment_settings WHERE project_id=$1",[projectId])).rows[0]?.mode||'skip';
  const decision=deploymentDecision(mode);
  const skipped=decision.status==='skipped';
  const destination=decision.stage;
  await client.query("INSERT INTO task_deployment_records(task_id,project_id,status,reason,merge_sha,actor_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,merge_sha=COALESCE(EXCLUDED.merge_sha,task_deployment_records.merge_sha),actor_id=EXCLUDED.actor_id,updated_at=now()",
   [taskId,projectId,decision.status,decision.reason,mergeSha,userId]);
  await client.query('UPDATE tasks SET stage=$3,updated_at=now() WHERE id=$1 AND project_id=$2',[taskId,projectId,destination]);
  await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)",
   [randomUUID(),taskId,userId,skipped?'deployment_skipped':'deployment_pending',skipped?'Выкладка пропущена: окружение не настроено':'Нужно подтвердить ручную выкладку или указать причину пропуска']);
  await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'merged',$4)",
   [randomUUID(),taskId,userId,prUrl]);
  await client.query('COMMIT');
  return destination;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
 async function mergeTaskPr(projectId:string,taskId:string,userId:string){
 const info=await pool.query("SELECT t.id,t.title,t.stage,t.pr_number,t.pr_url,t.depends_on_task_id,t.pr_base_branch,g.repository,g.target_branch,g.default_branch,c.secret_encrypted,d.merge_sha FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 LEFT JOIN task_deployment_records d ON d.task_id=t.id AND d.project_id=t.project_id WHERE t.id=$1 AND t.project_id=$2",
 [taskId,projectId,userId]);
 if(!info.rowCount)throw Object.assign(new Error('Задача или подключение GitHub не найдены'),{statusCode:404});
 const row=info.rows[0];
 if((row.stage!=='merge_queue'&&!row.merge_sha)||!row.pr_number)throw Object.assign(new Error('Задача не находится в очереди слияния или не содержит PR'),{statusCode:409});
 const token=decryptToken(row.secret_encrypted);
 const base='https://api.github.com/repos/'+row.repository;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const pull=await fetch(base+'/pulls/'+row.pr_number,{headers,signal:AbortSignal.timeout(15000)});
 if(!pull.ok)throw Object.assign(new Error('Не удалось получить PR: GitHub HTTP '+pull.status),{statusCode:502});
 let pr=await pull.json() as any;
 if(pr.merged){
  if(row.stage==='merge_queue'){
   await restackChildren(projectId,taskId,pr.head.sha,pr.base.ref,row.repository,token,userId);
   await registerMergedDeployment(projectId,taskId,userId,String(pr.merge_commit_sha||pr.head.sha||''),row.pr_url);
  }
  return {taskId,status:'merged' as const,url:row.pr_url};
 }
 if(row.stage!=='merge_queue')throw Object.assign(Error('Задача уже покинула очередь слияния'),{statusCode:409});
 if(await pendingAgentQuestions(pool,projectId,taskId))throw Object.assign(new Error('Нельзя слить PR: у задачи остаются вопросы без ответа'),{statusCode:409});
 if(row.depends_on_task_id){
  const parent=await pool.query('SELECT id,title,stage,pr_number,pr_base_branch FROM tasks WHERE project_id=$1 AND id=$2',[projectId,row.depends_on_task_id]);
  if(parent.rowCount && !['documentation','done'].includes(parent.rows[0].stage))
   throw Object.assign(new Error('Сначала слей родительскую задачу «'+parent.rows[0].title+'»'),{statusCode:409});
  if(parent.rowCount && parent.rows[0].pr_number && row.pr_base_branch===row.depends_on_task_id){
   const parentPr=await fetch('https://api.github.com/repos/'+row.repository+'/pulls/'+parent.rows[0].pr_number,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},signal:AbortSignal.timeout(15000)});
   if(parentPr.ok){
    const info=await parentPr.json() as any;
    if(info.merged)await restackChildren(projectId,row.depends_on_task_id,info.head.sha,info.base.ref,row.repository,token,userId);
   }
   const current=await pool.query('SELECT pr_base_branch FROM tasks WHERE id=$1',[taskId]);
   row.pr_base_branch=current.rows[0]?.pr_base_branch;
   if(row.pr_base_branch===row.depends_on_task_id)
    throw Object.assign(Error('PR всё ещё направлен в ветку задачи-основания. Сначала обновите базовую ветку.'),{statusCode:409});
   const updated=await fetch(base+'/pulls/'+row.pr_number,{headers,signal:AbortSignal.timeout(15000)});
   if(!updated.ok)throw Object.assign(Error('Не удалось обновить данные PR: GitHub HTTP '+updated.status),{statusCode:502});
   pr=await updated.json();
  }
 }
 if(pr.state!=='open'||pr.draft)throw Object.assign(new Error('PR закрыт или находится в черновике; переведи его в Ready for review'),{statusCode:409});
 // QA plans require a verified test run for the exact commit being merged.
 const spec=await pool.query('SELECT spec_version,spec_reviewed_version,spec_review_status,spec_reviewed_commit FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]);
 if(!spec.rowCount||spec.rows[0].spec_review_status!=='current'||spec.rows[0].spec_version!==spec.rows[0].spec_reviewed_version||(spec.rows[0].spec_reviewed_commit&&spec.rows[0].spec_reviewed_commit!==pr.head.sha))
  throw Object.assign(new Error('Требования изменились или аналитик проверял другую версию PR. Повтори сверку требований и тестирование.'),{statusCode:409});
 const qaPlan=await pool.query('SELECT id,spec_version FROM qa_test_plans WHERE project_id=$1 AND task_id=$2',[projectId,taskId]);
 const orchestrated=await pool.query('SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND cycle_id IS NOT NULL LIMIT 1',[projectId,taskId]);
 if((qaPlan.rowCount||orchestrated.rowCount)&&spec.rows[0].spec_reviewed_commit!==pr.head.sha)
  throw Object.assign(new Error('Аналитик не проверил последний коммит PR. Сначала повтори сверку требований.'),{statusCode:409});
 if((qaPlan.rowCount||orchestrated.rowCount)&&(!qaPlan.rowCount||qaPlan.rows[0].spec_version!==spec.rows[0].spec_version))
  throw Object.assign(new Error('Нет QA-плана для актуальной версии ТЗ. Сначала выполни тестирование.'),{statusCode:409});
 if(qaPlan.rowCount){
  const lastTest=await pool.query('SELECT id,task_id,verdict,report,status,qa_spec_version,qa_plan_snapshot FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1',[projectId,taskId]);
  const run=lastTest.rows[0];
  const matches=run&&run.status==='completed'&&run.report?.commit===pr.head.sha&&run.qa_spec_version===spec.rows[0].spec_version;
  if(!matches)throw Object.assign(new Error('QA-отчёт устарел или не относится к текущему коммиту PR. Повтори тестирование.'),{statusCode:409});
  if(run.verdict==='blocked'){
   const waiver=await pool.query('SELECT id,test_run_id,commit_sha,spec_version FROM qa_merge_waivers WHERE project_id=$1 AND task_id=$2 AND test_run_id=$3',[projectId,taskId,run.id]);
   if(!waiver.rowCount||!qaWaiverAssessment(run).eligible||waiver.rows[0].commit_sha!==pr.head.sha||waiver.rows[0].spec_version!==spec.rows[0].spec_version)
    throw Object.assign(new Error('Сценарии не проверены. Необходимо отдельное согласование исключений в карточке задачи.'),{statusCode:409});
  }else if(run.verdict!=='passed'){
   throw Object.assign(new Error('Тестировщик выявил дефекты или проверка не завершена. Слияние запрещено.'),{statusCode:409});
  }
 }
 if(pr.base?.ref!==(row.pr_base_branch||row.target_branch||row.default_branch))throw Object.assign(new Error('Целевая ветка PR отличается от настроенной ветки проекта'),{statusCode:409});
 if(pr.mergeable===null || pr.mergeable_state==='unknown')
  throw Object.assign(new Error('GitHub ещё вычисляет mergeability PR, повторная проверка необходима'),{statusCode:409});
 if(pr.mergeable===false || pr.mergeable_state==='dirty')
  throw Object.assign(new Error('PR содержит конфликт с целевой веткой'),{statusCode:409});
 if(pr.mergeable_state==='blocked')
  throw Object.assign(new Error('PR заблокирован правилами GitHub или проверками'),{statusCode:409});
 // Best-effort CI inspection. Fine-grained tokens may lack Checks access;
 // GitHub still enforces branch protection and required checks on the merge API.
 // Never treat an inaccessible check endpoint as proof that CI has passed.
 const readCi=async(path:string,label:string):Promise<any|null>=>{
  const url=base+path;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});
  if(response.status===401||response.status===403){
   const publicHeaders={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
   const publicResponse=await fetch(url,{headers:publicHeaders,signal:AbortSignal.timeout(15000)});
   if(publicResponse.ok)return publicResponse.json();
   if([401,403,404].includes(publicResponse.status))return null;
   throw Object.assign(new Error('Не удалось проверить '+label+': GitHub HTTP '+publicResponse.status),{statusCode:502});
  }
  if(!response.ok)throw Object.assign(new Error('Не удалось проверить '+label+' в GitHub: HTTP '+response.status),{statusCode:502});
  return response.json();
 };
 const checkData=await readCi('/commits/'+encodeURIComponent(pr.head.sha)+'/check-runs?per_page=100','CI (Check Runs)');
 if(checkData){
  const runs=Array.isArray(checkData.check_runs)?checkData.check_runs:[];
  const incomplete=runs.filter((c:any)=>c.status!=='completed'||!['success','neutral','skipped'].includes(c.conclusion));
  if(incomplete.length)throw Object.assign(new Error('PR ожидает проверок CI или содержит ошибки: '+incomplete.map((c:any)=>c.name).slice(0,5).join(', ')),{statusCode:409});
  if(Number(checkData.total_count||0)>runs.length)throw Object.assign(new Error('У коммита больше 100 проверок CI. Для безопасного слияния необходимо получить все результаты проверок.'),{statusCode:409});
 }
 const statusData=await readCi('/commits/'+encodeURIComponent(pr.head.sha)+'/status','статусы коммита');
 if(statusData){
  const statuses=Array.isArray(statusData.statuses)?statusData.statuses:[];
  if(statuses.length&&statusData.state!=='success')throw Object.assign(new Error('Статусы коммита не пройдены: '+statusData.state),{statusCode:409});
 }

 const merge=await fetch(base+'/pulls/'+row.pr_number+'/merge',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},
  body:JSON.stringify({sha:pr.head.sha,merge_method:'merge',commit_title:'Merge AI task: '+String(row.title).slice(0,150)}),
  signal:AbortSignal.timeout(25000)});
 const merged=await merge.json().catch(()=>({})) as any;
 if(!merge.ok || !merged.merged){
  const latest=await fetch(base+'/pulls/'+row.pr_number,{headers,signal:AbortSignal.timeout(15000)});
  if(latest.ok){
   const current=await latest.json() as any;
   if(current.merged){
    await restackChildren(projectId,taskId,current.head.sha,current.base.ref,row.repository,token,userId);
    await registerMergedDeployment(projectId,taskId,userId,String(current.merge_commit_sha||current.head.sha||''),row.pr_url);
    return {taskId,status:'merged' as const,url:row.pr_url};
   }
  }
  const statusCode=merge.status>=500||merge.status===429||latest.status>=500?502:409;
  throw Object.assign(new Error('GitHub отклонил слияние: '+String(merged.message||merge.status).slice(0,240)),{statusCode});
 }
 await restackChildren(projectId,taskId,pr.head.sha,pr.base.ref,row.repository,token,userId);
 await registerMergedDeployment(projectId,taskId,userId,String(merged.sha||pr.merge_commit_sha||''),row.pr_url);
 return {taskId,status:'merged' as const,url:row.pr_url};
}
 return {mergeTaskPr};
}

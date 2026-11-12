import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {requireMergeCi} from './merge-ci.js';
import {deploymentDecision} from './deployment-stage.js';
import {qaWaiverAssessment} from './qa-waiver.js';
import {pendingAgentQuestions} from './task-agent-notes.js';

async function requireQaForMerge(db:Pick<Pool,'query'>,projectId:string,taskId:string,headSha:string){
 const spec=(await db.query('SELECT spec_version,spec_reviewed_version,spec_review_status,spec_reviewed_commit FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId])).rows[0];
 if(!spec||spec.spec_review_status!=='current'||spec.spec_version!==spec.spec_reviewed_version||spec.spec_reviewed_commit!==headSha)
  throw Object.assign(Error('Аналитик не сверил текущую версию ТЗ с коммитом PR. Запустите сверку и QA в карточке задачи.'),{statusCode:409});
 const run=(await db.query('SELECT id,task_id,verdict,report,status,qa_spec_version,qa_plan_snapshot FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[projectId,taskId])).rows[0];
 const snapshot=run?.qa_plan_snapshot;
 const adHoc=snapshot?.singlePass===true&&snapshot.adHoc===true;
 const plan=adHoc?null:(await db.query('SELECT spec_version,spec_hash FROM qa_test_plans WHERE project_id=$1 AND task_id=$2',[projectId,taskId])).rows[0];
 if(!adHoc&&(!plan?.spec_hash||plan.spec_version!==spec.spec_version))
  throw Object.assign(Error('Нет QA-плана для текущей версии ТЗ. Запустите QA в карточке задачи.'),{statusCode:409});
 if(!run||run.status!=='completed'||run.report?.commit!==headSha||run.report?.staleSpecification===true||run.qa_spec_version!==spec.spec_version||
  !Array.isArray(snapshot?.cases)||!snapshot.cases.length||!adHoc&&snapshot.spec_hash!==plan.spec_hash)
  throw Object.assign(Error('Нет завершённого QA-отчёта для текущего SHA и версии ТЗ. Повторите QA в карточке задачи.'),{statusCode:409});
 if(snapshot.singlePass===true&&run.report.executionVerified!==true)
  throw Object.assign(Error('Runner не подтвердил результаты QA. Повторите проверку.'),{statusCode:409});
 if(run.verdict==='blocked'){
  const assessment=qaWaiverAssessment(run);
  const missingQa=()=>Object.assign(Error('Сценарии QA не подтверждены. Проверьте доступность среды или согласуйте допустимое исключение в карточке задачи.'),{statusCode:409});
  if(!assessment.eligible)throw missingQa();
  if(snapshot.simplified===true)return;
  const waiver=(await db.query('SELECT commit_sha,spec_version FROM qa_merge_waivers WHERE project_id=$1 AND task_id=$2 AND test_run_id=$3',
   [projectId,taskId,run.id])).rows[0];
  if(!waiver||waiver.commit_sha!==headSha||waiver.spec_version!==spec.spec_version)throw missingQa();
 }else if(run.verdict!=='passed'){
  throw Object.assign(Error('Тестировщик выявил дефекты или проверка не завершена. Слияние запрещено.'),{statusCode:409});
 }
}

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
async function recordMergedDeployment(client:PoolClient,projectId:string,taskId:string,userId:string,mergeSha:string|null,prUrl:string){
  const task=await client.query('SELECT stage FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,projectId]);
  if(!task.rowCount)throw new Error('Задача не найдена после слияния PR');
  if(task.rows[0].stage!=='merge_queue')return;
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
}
async function registerMergedDeployment(projectId:string,taskId:string,userId:string,mergeSha:string|null,prUrl:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await recordMergedDeployment(db,projectId,taskId,userId,mergeSha,prUrl);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
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
  await restackChildren(projectId,taskId,pr.head.sha,pr.base.ref,row.repository,token,userId);
  if(row.stage==='merge_queue'){
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
 const headSha=pr.head?.sha;
 if(typeof headSha!=='string'||!/^[a-f0-9]{40}$/i.test(headSha))
  throw Object.assign(Error('GitHub не подтвердил SHA текущего PR'),{statusCode:409});
 await requireQaForMerge(pool,projectId,taskId,headSha);
 if(pr.base?.ref!==(row.pr_base_branch||row.target_branch||row.default_branch))throw Object.assign(new Error('Целевая ветка PR отличается от настроенной ветки проекта'),{statusCode:409});
 if(pr.mergeable===null || pr.mergeable_state==='unknown')
  throw Object.assign(new Error('GitHub ещё вычисляет mergeability PR, повторная проверка необходима'),{statusCode:409});
 if(pr.mergeable===false || pr.mergeable_state==='dirty')
  throw Object.assign(new Error('PR содержит конфликт с целевой веткой'),{statusCode:409});
 await requireMergeCi({base,headers,branch:pr.base.ref,headSha,
  mergeSha:typeof pr.merge_commit_sha==='string'&&/^[a-f0-9]{40}$/i.test(pr.merge_commit_sha)?pr.merge_commit_sha:null});
 if(pr.mergeable_state==='blocked')
  throw Object.assign(Error('Проверки CI подтверждены, но GitHub блокирует слияние. Проверьте ограничения целевой ветки в PR.'),{statusCode:409});

 const db=await pool.connect();
 let merge:Response;
 let merged:{merged?:boolean;sha?:string;message?:string};
 try{
  await db.query('BEGIN');
  const locked=(await db.query('SELECT stage,pr_number FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,taskId])).rows[0];
  if(locked?.stage!=='merge_queue'||locked.pr_number!==row.pr_number)
   throw Object.assign(Error('Задача или PR изменились после проверки. Повторите слияние.'),{statusCode:409});
  if(await pendingAgentQuestions(db,projectId,taskId))
   throw Object.assign(Error('Нельзя слить PR: у задачи остаются вопросы без ответа'),{statusCode:409});
  await requireQaForMerge(db,projectId,taskId,headSha);
  merge=await fetch(base+'/pulls/'+row.pr_number+'/merge',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},
   body:JSON.stringify({sha:headSha,merge_method:'merge',commit_title:'Merge AI task: '+String(row.title).slice(0,150)}),
   signal:AbortSignal.timeout(25000)});
  merged=await merge.json().catch(()=>({}));
  if(merge.ok&&merged.merged)
   await recordMergedDeployment(db,projectId,taskId,userId,String(merged.sha||pr.merge_commit_sha||''),row.pr_url);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
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
 return {taskId,status:'merged' as const,url:row.pr_url};
}
 return {mergeTaskPr};
}

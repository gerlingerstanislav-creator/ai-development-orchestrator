import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';

const params=z.object({id:z.string().uuid(),taskId:z.string().uuid()});
type Dependencies={pool:Pool;access:(r:any,p:any,id:string)=>Promise<boolean>;requireAdmin:(r:any,p:any)=>Promise<boolean>;uid:(r:any)=>string;decryptToken:(value:string)=>string};
/** Failed Codex attempts can create a remote UUID branch before tasks.git_branch is saved. */
export function needsGitHubCleanup(task:{git_branch?:string|null;pr_number?:number|null},hadDevelopmentRuns:boolean){
 return Boolean(task.git_branch||task.pr_number||hadDevelopmentRuns);
}


export async function initTaskCancellationSchema(pool:Pool){
 await pool.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL");
 await pool.query("CREATE INDEX IF NOT EXISTS idx_documents_task_origin ON documents(project_id,created_by_task_id)");
 await pool.query("CREATE TABLE IF NOT EXISTS task_cancellation_audit(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL,task_number bigint,title text NOT NULL,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,repository text,branch text,pr_number integer,qa_plans_removed integer NOT NULL DEFAULT 0,qa_cases_removed integer NOT NULL DEFAULT 0,qa_flows_removed integer NOT NULL DEFAULT 0,documents_removed integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now())");
}
async function taskPreview(client:Pool|PoolClient,projectId:string,taskId:string){
 const t=await client.query("SELECT id,title,display_number,stage,git_branch,pr_url,pr_number FROM tasks WHERE project_id=$1 AND id=$2",[projectId,taskId]);
 if(!t.rowCount)return null;
 const [dependents,active,activeTest,legacyRuns,activeReview,delegatedWork,pmKickoff,developmentHistory,docs,plans,cases,flows,versions]=await Promise.all([
  client.query('SELECT display_number,title FROM tasks WHERE project_id=$1 AND depends_on_task_id=$2 LIMIT 15',[projectId,taskId]),
  client.query("SELECT workflow_id FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[projectId,taskId]),
  client.query("SELECT id FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('running','queued') LIMIT 1",[projectId,taskId]),
  client.query("SELECT id FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('running','queued') LIMIT 1",[projectId,taskId]),
  client.query("SELECT id FROM requirement_review_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('running','queued') LIMIT 1",[projectId,taskId]),
  client.query("SELECT id FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running') LIMIT 1",[projectId,taskId]),
  client.query("SELECT id FROM assistant_messages WHERE project_id=$1 AND task_id=$2 AND channel='pm-internal' AND status IN ('queued','processing') LIMIT 1",[projectId,taskId]),
  client.query('SELECT count(*)::int AS total FROM ai_task_runs WHERE project_id=$1 AND task_id=$2',[projectId,taskId]),
  client.query("SELECT count(*)::int AS n FROM documents WHERE project_id=$1 AND created_by_task_id=$2",[projectId,taskId]),
  client.query("SELECT count(*)::int AS n FROM qa_test_plans WHERE project_id=$1 AND task_id=$2",[projectId,taskId]),
  client.query("SELECT count(*)::int AS n FROM qa_test_cases WHERE project_id=$1 AND source_task_id=$2",[projectId,taskId]),
  client.query("SELECT count(*)::int AS n FROM qa_user_flows WHERE project_id=$1 AND source_task_id=$2",[projectId,taskId]),
  client.query("SELECT count(*)::int AS n FROM document_versions WHERE $2::uuid::text IN (SELECT jsonb_array_elements_text(task_ids)) AND document_id IN (SELECT id FROM documents WHERE project_id=$1)",[projectId,taskId])
 ]);
 const row=t.rows[0];
 const blocked:string[]=[];
 if(['documentation','done'].includes(row.stage))blocked.push('PR уже слит: нельзя удалить внедрённую функциональность через отмену задачи');
 if(dependents.rowCount)blocked.push('На задачу опираются другие задачи: '+dependents.rows.map(x=>'#'+x.display_number+' '+x.title).join(', '));
 if(active.rowCount||activeTest.rowCount||legacyRuns.rowCount||activeReview.rowCount||delegatedWork.rowCount||pmKickoff.rowCount)
  blocked.push('Для задачи остаётся активный AI/Temporal-процесс, поручение специалиста или PM Inbox. Сначала штатно останови процесс, затем повтори отмену: удаление работающего задания не допускается');
 if(versions.rows[0].n)blocked.push('Есть версии общей проектной документации с этой задачей; сначала разреши историю документации');
 const sharedChildren=await client.query("SELECT count(*)::int AS n FROM documents d WHERE d.project_id=$1 AND d.parent_id IN (SELECT id FROM documents WHERE project_id=$1 AND created_by_task_id=$2) AND d.created_by_task_id IS DISTINCT FROM $2",[projectId,taskId]);
 if(sharedChildren.rows[0].n)blocked.push('Документы задачи используются как родительские страницы для чужой документации');
 return {task:row,blocked,github_cleanup_required:needsGitHubCleanup(row,developmentHistory.rows[0].total>0),warnings:['Автоматически удаляются только документы, явно привязанные к задаче. Исторические или общие страницы без такой привязки сохраняются.'],stats:{documents:docs.rows[0].n,qa_plans:plans.rows[0].n,qa_cases:cases.rows[0].n,qa_flows:flows.rows[0].n},confirmation:'ОТМЕНИТЬ #'+row.display_number};
}
async function github(token:string,repository:string,path:string,method:'GET'|'PATCH'|'DELETE'='GET',body?:unknown){
 const response=await fetch('https://api.github.com/repos/'+repository+path,{method,headers:{
  Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
  'User-Agent':'ai-development-orchestrator','Content-Type':'application/json'
 },body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
 if(!response.ok&&response.status!==404){
  throw new Error('GitHub HTTP '+response.status+' при '+method+' '+path+': '+(await response.text()).slice(0,200));
 }
 return {status:response.status,value:response.status===404?null:await response.json().catch(()=>null) as any};
}
/** Both GitHub cleanup and SQL deletion are idempotent. A failing GitHub request leaves DB state untouched. */
export async function closeGitHubArtifacts(repository:string,token:string,task:any){
 const branch=task.git_branch||task.id;
 if(branch!==task.id)throw new Error('Ветка не совпадает с UUID задачи. Автоматическое удаление чужой ветки запрещено');
 const rep=await github(token,repository,'');
 if(rep.status!==200)throw new Error('GitHub-репозиторий недоступен');
 const defaultBranch=String(rep.value.default_branch||'');
 if(branch===defaultBranch)throw new Error('Удаление основной ветки запрещено');
 const others=await github(token,repository,'/pulls?state=open&base='+encodeURIComponent(branch)+'&per_page=100');
 if((others.value||[]).length)throw new Error('Ветка используется как база других открытых PR; сначала разреши зависимости');
 const owner=repository.split('/')[0];
 const heads=await github(token,repository,'/pulls?state=open&head='+encodeURIComponent(owner+':'+branch)+'&per_page=100');
 const attached=(heads.value||[]) as any[];
 if(attached.some(pr=>pr.number!==task.pr_number))throw new Error('Есть другие PR с веткой задачи; автоматическое удаление запрещено');
 if(task.pr_number){
  const pr=await github(token,repository,'/pulls/'+task.pr_number);
  if(pr.status!==200)throw new Error('Не удалось подтвердить состояние PR; удаление запрещено');
  if(pr.value.merged||pr.value.state==='merged')throw new Error('PR уже слит. Отмена задачи запрещена');
  if(pr.value.head?.ref!==branch||pr.value.head?.repo?.full_name!==repository)
   throw new Error('PR указывает на другую ветку или репозиторий; удаление запрещено');
  if(pr.value.state==='open')await github(token,repository,'/pulls/'+task.pr_number,'PATCH',{state:'closed'});
 }
 const ref=await github(token,repository,'/git/ref/heads/'+encodeURIComponent(branch));
 if(ref.status===200)await github(token,repository,'/git/refs/heads/'+encodeURIComponent(branch),'DELETE');
}
export function registerTaskCancellationRoutes(app:FastifyInstance,deps:Dependencies){
 const {pool,access,requireAdmin,uid,decryptToken}=deps;
 app.get('/api/projects/:id/tasks/:taskId/cancel-preview',async(req:any,reply)=>{
  const {id,taskId}=params.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const preview=await taskPreview(pool,id,taskId);
  if(!preview)return reply.code(404).send({error:'Задача не найдена'});
  return {...preview,github_note:'PR будет закрыт, но останется в истории GitHub. Ветка будет удалена.'};
 });
 app.post('/api/projects/:id/tasks/:taskId/cancel',async(req:any,reply)=>{
  const {id,taskId}=params.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  z.object({confirm:z.literal(true)}).parse(req.body);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const row=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
   if(!row.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Задача уже удалена или не найдена'});}
   const preview=await taskPreview(client,id,taskId);
   if(!preview||preview.blocked.length){await client.query('ROLLBACK');return reply.code(409).send({error:'Нельзя отменить задачу',blockers:preview?.blocked});}
   const task=row.rows[0];
   const link=await client.query("SELECT g.repository,c.secret_encrypted FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id AND c.owner_id=$2 WHERE g.project_id=$1",[id,uid(req)]);
   if(preview.github_cleanup_required&&!link.rowCount){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Сначала подключи GitHub-токен владельца для безопасной очистки ветки и PR'});
   }
   if(preview.github_cleanup_required&&link.rowCount)await closeGitHubArtifacts(link.rows[0].repository,decryptToken(link.rows[0].secret_encrypted),task);
   const processIds=await client.query("SELECT id FROM ai_task_runs WHERE task_id=$1 UNION SELECT id FROM ai_test_runs WHERE task_id=$1 UNION SELECT id FROM requirement_review_runs WHERE task_id=$1",[taskId]);
   if(processIds.rowCount)await client.query('DELETE FROM process_events WHERE project_id=$1 AND process_id=ANY($2::uuid[])',[id,processIds.rows.map(x=>x.id)]);
   // The QA plan may reuse shared regression cases; delete only those no longer used.
   await client.query('DELETE FROM qa_test_plans WHERE project_id=$1 AND task_id=$2',[id,taskId]);
   const deletedCases=await client.query('DELETE FROM qa_test_cases c WHERE c.project_id=$1 AND c.source_task_id=$2 AND NOT EXISTS (SELECT 1 FROM qa_plan_cases pc WHERE pc.case_id=c.id) AND NOT EXISTS (SELECT 1 FROM qa_manual_results mr WHERE mr.case_id=c.id) AND NOT EXISTS (SELECT 1 FROM qa_case_results cr JOIN ai_test_runs tr ON tr.id=cr.test_run_id WHERE cr.case_id=c.id AND tr.task_id IS DISTINCT FROM $2) RETURNING id',[id,taskId]);
   const deletedFlows=await client.query('DELETE FROM qa_user_flows f WHERE f.project_id=$1 AND f.source_task_id=$2 AND NOT EXISTS (SELECT 1 FROM qa_test_cases c WHERE c.flow_id=f.id) RETURNING id',[id,taskId]);
   const deletedDocs=await client.query('DELETE FROM documents WHERE project_id=$1 AND created_by_task_id=$2 RETURNING id',[id,taskId]);
   await client.query('DELETE FROM assistant_messages WHERE project_id=$1 AND task_id=$2',[id,taskId]);
   await client.query('DELETE FROM project_rule_suggestions WHERE project_id=$1 AND task_id=$2',[id,taskId]);
   await client.query('DELETE FROM tasks WHERE project_id=$1 AND id=$2',[id,taskId]);
   const auditId=randomUUID();
   await client.query('INSERT INTO task_cancellation_audit(id,project_id,task_id,task_number,title,actor_id,repository,branch,pr_number,qa_plans_removed,qa_cases_removed,qa_flows_removed,documents_removed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [auditId,id,taskId,task.display_number,task.title,uid(req),link.rows[0]?.repository||null,task.git_branch||taskId,task.pr_number,preview.stats.qa_plans,deletedCases.rowCount||0,deletedFlows.rowCount||0,deletedDocs.rowCount||0]);
   await client.query('COMMIT');
   return {ok:true,audit_id:auditId,removed:{...preview.stats,qa_cases:deletedCases.rowCount,qa_flows:deletedFlows.rowCount,documents:deletedDocs.rowCount},github_pr:'closed_if_open',branch:'deleted_if_present'};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
}

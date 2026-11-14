import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import type {Client} from '@temporalio/client';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {validStages} from '../projects/domain/workflow-stages.js';
import {tasksWithCustomerQuestions} from '../../project-manager.js';
import {saveSpecRevision,updateCurrentSpecification} from '../../requirements.js';
import {pendingAgentQuestions} from '../../task-agent-notes.js';
import {readAgentActivity} from '../../task-agent-activity.js';
import {qaEventDetail,formatQaReportMessage} from '../../qa-report-message.js';
import {routeTaskToBrowserEvidence,retryTaskBrowserEvidence} from '../../task-evidence-routing.js';
import {registerTaskBoardRoutes} from '../../task-board-routes.js';

type Deps={
 pool:Pool;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 temporal:()=>Promise<Client>;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/** Task HTTP boundary: scoped CRUD, dependency cycle prevention,
 * approval-gated requirements and combined agent history.
 *
 * The dependency command is also used by the authenticated PM tooling,
 * to avoid parallel implementations of task graph mutations.
 */
export function registerProjectTaskRoutes(app:FastifyInstance,{pool,uid,access,requireAdmin,temporal}:Deps){
registerTaskBoardRoutes(app,{pool,uid,access,requireAdmin});
app.get('/api/projects/:id/tasks',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return tasksWithCustomerQuestions(pool,id);});
app.post('/api/projects/:id/tasks',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(300),description:z.string().max(20000).default(''),type:z.enum(['task','bug','improvement','epic','question']).default('task'),parent_id:z.string().uuid().nullable().optional(),document_id:z.string().uuid().nullable().optional()}),req.body);
 if(data.parent_id){const p=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[data.parent_id,id]);if(!p.rowCount)return reply.code(400).send({error:'Родительская задача не найдена'});}
 if(data.type==='question'){
  if(!data.document_id||data.parent_id)return reply.code(400).send({error:'Вопрос к ПО должен быть связан с документом и не иметь родительской задачи'});
  const doc=await pool.query('SELECT 1 FROM documents WHERE project_id=$1 AND id=$2',[id,data.document_id]);
  if(!doc.rowCount)return reply.code(404).send({error:'Документ для вопроса не найден'});
 }else if(data.document_id)return reply.code(400).send({error:'Привязка к документу предусмотрена только для вопросов к ПО'});
 const taskId=randomUUID();
 if(data.type==='question'){
  await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage,position,document_id,question_key,question_topic,question_status) VALUES($1,$2,$3,$4,'question','backlog',(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2),$5,$6,'manual','open')",
   [taskId,id,data.title,data.description||data.title,data.document_id,taskId]);
 }else{
  await pool.query('INSERT INTO tasks(id,project_id,title,description,type,parent_id,position) VALUES($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2))',[taskId,id,data.title,data.description,data.type,data.parent_id||null]);
 }
 await pool.query('INSERT INTO task_events(id,task_id,actor_id,event) VALUES($1,$2,$3,$4)',[randomUUID(),taskId,uid(req),'created']);
 return reply.code(201).send({id:taskId});
});
// An explicit owner route and PM tool use the same validated service; they
// never bypass the analysis, active-run or provenance gates.
app.post('/api/projects/:id/tasks/:taskId/execution-route',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const data=parse(z.object({
  mode:z.literal('browser_evidence'),source_sha:z.string().regex(/^[a-f0-9]{40}$/i),
  reason:z.string().trim().min(12).max(1600)
 }),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const routed=await routeTaskToBrowserEvidence(client,{
   projectId:id,taskId,actorId:uid(req),sourceSha:data.source_sha,reason:data.reason
  });
  await client.query('COMMIT');return routed;
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  return reply.code(Math.min(599,Math.max(400,Number((error as any).statusCode)||409))).send({error:String((error as Error).message)});
 }finally{client.release();}
});
app.post('/api/projects/:id/tasks/:taskId/retry-evidence',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {reason}=parse(z.object({reason:z.string().trim().min(12).max(1600)}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const result=await retryTaskBrowserEvidence(client,{projectId:id,taskId,actorId:uid(req),reason});
  await client.query('COMMIT');return result;
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  return reply.code(Math.min(599,Math.max(400,Number((error as any).statusCode)||409))).send({error:String((error as Error).message)});
 }finally{client.release();}
});
async function updateDependency(projectId:string,taskId:string,parentId:string|null,actorId:string){
 if(parentId===taskId)throw Object.assign(new Error('Задача не может зависеть от самой себя'),{statusCode:409});
 const task=await pool.query('SELECT id,stage,git_branch FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]);
 if(!task.rowCount)throw Object.assign(new Error('Задача не найдена'),{statusCode:404});
 if(['merge_queue','deployment','documentation','done'].includes(task.rows[0].stage)||task.rows[0].git_branch)
  throw Object.assign(new Error('Нельзя менять базовую зависимость после создания ветки. Сначала завершите текущую разработку.'),{statusCode:409});
 if(parentId){
  const parent=await pool.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2',[projectId,parentId]);
  if(!parent.rowCount)throw Object.assign(new Error('Задача-основание не найдена в этом проекте'),{statusCode:404});
  const chain=await pool.query('WITH RECURSIVE parents AS ('+
    'SELECT id,depends_on_task_id,ARRAY[id] AS trail FROM tasks WHERE id=$1 AND project_id=$2 '+
    'UNION ALL SELECT t.id,t.depends_on_task_id,p.trail||t.id FROM tasks t JOIN parents p ON t.id=p.depends_on_task_id '+
    'WHERE NOT t.id=ANY(p.trail) AND t.project_id=$2) '+
    'SELECT 1 FROM parents WHERE id=$3 LIMIT 1',[parentId,projectId,taskId]);
  if(chain.rowCount)throw Object.assign(new Error('Обнаружен цикл зависимостей'),{statusCode:409});
 }
 await pool.query("UPDATE tasks SET depends_on_task_id=$3,dependency_source='manual',updated_at=now() WHERE project_id=$1 AND id=$2",[projectId,taskId,parentId]);
 await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
  [randomUUID(),taskId,actorId,'dependency_changed',parentId?'Зависит от '+parentId:'Зависимость удалена']);
 return {ok:true,depends_on_task_id:parentId};
}
app.put('/api/projects/:id/tasks/:taskId/dependency',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {depends_on_task_id}=parse(z.object({depends_on_task_id:z.string().uuid().nullable()}),req.body);
 try{return await updateDependency(id,taskId,depends_on_task_id,uid(req));}
 catch(e){const err=e as Error&{statusCode?:number};return reply.code(err.statusCode||409).send({error:err.message});}
});
/** Manual task edits are spec changes; they invalidate QA and trigger analyst review. */
async function startRequirementsReview(projectId:string,taskId:string,version:number){
 const running=await pool.query("SELECT id FROM requirement_review_runs WHERE project_id=$1 AND task_id=$2 AND spec_version=$3 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",[projectId,taskId,version]);
 if(running.rowCount)return {started:true,runId:running.rows[0].id,message:'Проверка требований уже выполняется'};
 const enabled=await pool.query('SELECT enabled FROM project_ai_settings WHERE project_id=$1',[projectId]);
 if(!enabled.rows[0]?.enabled)return {started:false,message:'AI отключён; проверка требований ожидает включения'};
 const active=await pool.query("SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running') AND cycle_id IS NOT NULL LIMIT 1",[projectId,taskId]);
 if(active.rowCount)return {started:false,message:'Актуализацию требований выполнит аналитик в активном цикле разработки'};
 const runId=randomUUID();
 await pool.query("INSERT INTO requirement_review_runs(id,project_id,task_id,spec_version,status,message) VALUES($1,$2,$3,$4,'queued','Ожидает проверки аналитиком')",[runId,projectId,taskId,version]);
 try{
  const client=await temporal();
  await client.workflow.start('requirementsReview',{taskQueue:'agent-pipeline',workflowId:'requirements-'+taskId+'-v'+version+'-'+runId,args:[{projectId,taskId,runId}]});
  return {started:true,runId,message:'AI-аналитик проверяет изменение требований'};
 }catch(e){
  await pool.query("UPDATE requirement_review_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,'Не удалось запустить Temporal: '+String(e).slice(0,500)]);
  return {started:false,runId,message:'Не удалось запустить проверку требований; повтори её вручную'};
 }
}
app.get('/api/projects/:id/tasks/:taskId/requirements',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const task=await pool.query('SELECT id,title,description,spec_version,spec_reviewed_version,spec_review_status,spec_reviewed_commit,spec_review_note FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 const [reviews,versions,runs]=await Promise.all([
  pool.query('SELECT id,classification,status,summary,proposed_description,questions,commit_sha,spec_version,created_at,resolved_at FROM task_requirement_reviews WHERE task_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 30',[taskId,id]),
  pool.query('SELECT id,version,origin,title,description,reason,created_at FROM task_spec_versions WHERE task_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 30',[taskId,id]),
  pool.query('SELECT id,status,message,spec_version,created_at,completed_at FROM requirement_review_runs WHERE task_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 12',[taskId,id])
 ]);
 return {task:task.rows[0],reviews:reviews.rows,versions:versions.rows,runs:runs.rows};
});
app.post('/api/projects/:id/tasks/:taskId/requirements/retry',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const task=await pool.query('SELECT spec_version,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 if(task.rows[0].spec_review_status==='needs_approval')return reply.code(409).send({error:'Сначала согласуй изменение требований'});
 const run=await startRequirementsReview(id,taskId,task.rows[0].spec_version);
 return reply.code(run.started?202:409).send(run);
});
app.post('/api/projects/:id/tasks/:taskId/requirements/:reviewId/decision',async(req:any,reply)=>{
 const {id,taskId,reviewId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid(),reviewId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {decision}=parse(z.object({decision:z.enum(['approve','reject'])}),req.body);
 if(decision==='approve'&&await pendingAgentQuestions(pool,id,taskId))return reply.code(409).send({error:'Нельзя согласовать изменение требований, пока остаются вопросы агентов без ответа'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const task=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
  const review=await client.query("SELECT * FROM task_requirement_reviews WHERE id=$1 AND task_id=$2 AND project_id=$3 FOR UPDATE",[reviewId,taskId,id]);
  if(!task.rowCount||!review.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Требования или предложение не найдены'});}
  const t=task.rows[0],v=review.rows[0];
  if(decision==='approve'){
   const pending=await client.query("SELECT 1 FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status='open' LIMIT 1",[id,taskId]);
   if(pending.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'Поступил новый вопрос агента: сначала ответь на него'});}
  }
  if(v.classification==='uncertain'&&decision==='approve'){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Аналитик не смог проверить требования. Сначала ответь на вопросы и уточни ТЗ.'});
  }
  if(v.status!=='needs_approval'||t.spec_version!==v.spec_version||t.spec_review_status!=='needs_approval'){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Предложение уже рассмотрено или относится к старой версии ТЗ'});
  }
  if(decision==='approve'){
   const newVersion=await saveSpecRevision(client,t,{title:t.title,description:v.proposed_description,origin:'approved_change',actorId:uid(req),reason:v.summary,reviewStatus:'current',reviewedCommit:v.commit_sha});
   if(newVersion===t.spec_version){
    await client.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note=$4,updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,id,v.commit_sha,v.summary]);
   }
   await client.query("UPDATE task_requirement_reviews SET status='approved',resolved_at=now(),resolved_by=$2 WHERE id=$1",[reviewId,uid(req)]);
  }else{
   const backToDevelopment=['testing','merge_queue'].includes(t.stage);
   await client.query("UPDATE tasks SET spec_review_status='rejected',spec_review_note=$3,test_feedback=$4,stage=CASE WHEN $5 THEN 'development' ELSE stage END,updated_at=now() WHERE id=$1 AND project_id=$2",
    [taskId,id,'Изменение требований отклонено: реализация должна соответствовать утверждённому ТЗ','Отклонено изменение поведения: '+v.summary,backToDevelopment]);
   await client.query("UPDATE task_requirement_reviews SET status='rejected',resolved_at=now(),resolved_by=$2 WHERE id=$1",[reviewId,uid(req)]);
  }
  await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),decision==='approve'?'requirements_approved':'requirements_rejected',v.summary.slice(0,1800)]);
  await client.query('COMMIT');
  return {ok:true,decision};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.patch('/api/projects/:id/tasks/:taskId',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(300).optional(),description:z.string().max(20000).optional(),stage:validStages.optional(),priority:z.number().int().min(1).max(5).optional()}),req.body);
 const client=await pool.connect();
 let version=0,changed=false;
 try{
  await client.query('BEGIN');
  const old=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
  if(!old.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Задача не найдена'});}
  const t=old.rows[0];
  if(t.type==='question'){
   if(data.stage&&data.stage!==t.stage){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Вопрос не участвует в этапах разработки'});
   }
   if(t.question_status!=='open'&&(data.title!==undefined||data.description!==undefined)){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Вопрос уже передан аналитику и не редактируется'});
   }
   const questionTitle=data.title??t.title,questionText=data.description??t.description;
   await client.query('UPDATE tasks SET title=$3,description=$4,updated_at=now() WHERE id=$1 AND project_id=$2',[taskId,id,questionTitle,questionText]);
   if(questionTitle!==t.title||questionText!==t.description)
    await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
     [randomUUID(),taskId,uid(req),'question_updated','Вопрос уточнён владельцем продукта']);
   await client.query('COMMIT');
   return {ok:true};
  }
  if(t.type==='question'&&data.stage&&data.stage!==t.stage){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Этап вопроса изменяется после обработки ответа аналитиком'});
  }
  if(data.stage&&data.stage!==t.stage&&(!['backlog','analysis'].includes(t.stage)||!['backlog','analysis'].includes(data.stage))){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Перемещение между разработкой, PR и завершением выполняется только через действия workflow'});
  }
  const title=data.title??t.title,description=data.description??t.description;
  if(data.priority!==undefined&&data.priority!==t.priority){
   await client.query('UPDATE tasks SET priority=$2,updated_at=now() WHERE id=$1',[taskId,data.priority]);
   await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'priority_changed',$4)",[randomUUID(),taskId,uid(req),'Приоритет '+data.priority]);
  }
  if(['documentation','done'].includes(t.stage)&&description!==t.description){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'PR уже слит. Чтобы изменить завершённую функциональность, создай новую связанную задачу; нельзя переписывать утверждённое ТЗ уже внедрённой версии.'});
  }
  changed=title!==t.title||description!==t.description;
  version=t.spec_version;
  if(changed)await updateCurrentSpecification(client,id,taskId,title,description);
  const stage=data.stage&&data.stage!==t.stage?data.stage:changed&&t.stage==='merge_queue'?'testing':t.stage;
  if(stage!==t.stage)await client.query('UPDATE tasks SET stage=$2,updated_at=now() WHERE id=$1',[taskId,stage]);
  if(changed){
   if(['analysis','backlog'].includes(t.stage))await client.query("UPDATE tasks SET analysis_state='new' WHERE id=$1",[taskId]);
   await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'spec_changed','Обновлено текущее описание задачи']);
  }
  if(stage!==t.stage)await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'stage_changed',t.stage+' → '+stage]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 return {ok:true,spec_version:version,requirements_review:null};
});
app.get('/api/projects/:id/tasks/:taskId/events',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const r=await pool.query('SELECT e.* FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.id=$1 AND t.project_id=$2 ORDER BY e.created_at DESC',[taskId,id]);return r.rows;
});
// Unified task feed: task actions and Temporal process steps visible before tests begin.
app.get('/api/projects/:id/tasks/:taskId/activity',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const task=await pool.query('SELECT id FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 const [events,processes,ownership,tests,notes,agentRuns]=await Promise.all([
  pool.query('SELECT id,event,detail,created_at FROM task_events WHERE task_id=$1 ORDER BY created_at DESC LIMIT 200',[taskId]),
  pool.query("SELECT p.id,p.process_kind,p.stage,p.detail,p.level,p.created_at FROM process_events p WHERE p.project_id=$1 AND (p.task_id=$2 OR p.process_id IN (SELECT id FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 UNION SELECT id FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 UNION SELECT id FROM requirement_review_runs WHERE project_id=$1 AND task_id=$2)) ORDER BY p.created_at DESC,p.id DESC LIMIT 250",[id,taskId]),
  pool.query('SELECT owner_id,kind,workflow_id,state,started_at FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2',[id,taskId]),
  pool.query('SELECT id,task_id,cycle_id,attempt,status,message,verdict,report,qa_plan_snapshot,created_at,completed_at,qa_spec_version FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 30',[id,taskId]),
  pool.query('SELECT id,author_stage,author_name,target_stage,kind,body,source_kind,status,answer,answered_at,created_at FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200',[id,taskId]),
  readAgentActivity(pool,id,taskId)
 ]);
 return {events:events.rows,processEvents:processes.rows.map(row=>({...row,detail:row.process_kind==='testing'?qaEventDetail(row.detail):row.detail})),agentRuns,owner:ownership.rows[0]?.state==='active'?ownership.rows[0]:null,tests:tests.rows.map(run=>({...run,human_report:['completed','failed'].includes(run.status)?formatQaReportMessage(run):null})),notes:notes.rows};
});
 return {updateDependency,startRequirementsReview};
}

import {registerDevelopmentRunStatusRoutes} from './modules/execution/api/development-run-status.js';
import {registerQualityOperationsRoutes} from './modules/quality/api.js';
import {createQueueReconciler} from './modules/execution/application/queue-reconciler.js';
import {scanStalledPmInbox} from './modules/planning/infrastructure/pm-inbox-diagnostics.js';
import {registerProjectTaskRoutes} from './modules/tasks/api.js';
import {registerWorkflowSettingsRoutes} from './modules/projects/workflow-api.js';
import {registerAiSettingsRoutes} from './modules/execution/api/ai-settings.js';
import {coreSchemaMigrations} from './database/core-migrations.js';
import {registerDocumentationRoutes} from './modules/documentation/api.js';
import {registerProjectProcessRoutes} from './modules/processes/project-api.js';
import {registerProjectCoreRoutes} from './modules/projects/api.js';
import {workflowStageDescriptions} from './modules/projects/domain/workflow-defaults.js';
import {createLegacyDevelopmentReconciler} from './modules/processes/infrastructure/reconcile-legacy-development.js';
import {registerBackgroundProcessRoutes} from './modules/processes/api.js';
import {registerProjectGitRoutes} from './modules/integrations/github/api.js';
import {registerConnectionRoutes} from './modules/integrations/connections/api.js';
import {encryptConnectionSecret,decryptConnectionSecret} from './modules/integrations/connections/secret-cipher.js';
import {registerCodexAdminRoutes} from './modules/codex/api.js';
import {registerAuthRoutes} from './modules/auth/api.js';
import {issueAccessToken} from './modules/auth/application/tokens.js';
import {ensureLegacyAdministrator} from './database/legacy-bootstrap.js';
import {runSchemaMigrations} from './database/schema-migrations.js';
import {canManagerCloseTask,planManagerStageMove,type WorkStage} from './task-stage-operations.js';
import {startDiagnosticRetention,installDiagnosticHooks,registerDiagnosticRoutes} from './diagnostics.js';
import {registerCloudDiagnosticsSettings,startCloudDiagnosticsSender} from './cloud-diagnostics.js';
import Fastify from 'fastify';
import {recoverInterruptedLegacyMergeBatches,recoverMergeBatches} from './merge-batch.js';
import {registerMergeOperationsRoutes} from './modules/execution/api/merge-operations.js';
import {registerAutomaticDeploymentRoutes} from './deployment-automation.js';
import { registerAssistantRoutes } from './assistant.js';
import {registerChatImageRoutes} from './chat-images.js';
import {registerProjectIterationRoutes} from './project-iterations.js';
import {resolveRoleAiSettings} from './project-team.js';
import {registerAgentToolRoutes} from './agent-tool-routes.js';
import {authorizePmDestructiveSource} from './pm-source-authorization.js';
import {registerProjectTeamRoutes,reconcileProjectTeamProfiles} from './project-team.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import {registerDocumentationResetRoutes} from './documentation-reset.js';
import {registerSafeTaskDeletion} from './task-deletion.js';
import {registerBusinessAnalystHandoff} from './business-analyst-handoff.js';
import {failProjectManagerInbox,publishOwnerQuestionsToPmChat,pmInboxWorkflowId,registerProjectManagerInbox} from './project-manager-inbox.js';
import {registerKnowledgeContextRoutes} from './knowledge-context.js';
import {registerKnowledgeWorkflowRoutes} from './knowledge-workflow-routes.js';
import {registerKnowledgeDocumentUpdateRoutes} from './knowledge-document-updates.js';
import {registerQaRoutes} from './qa.js';
import {registerQaWaiverRoutes} from './qa-waiver.js';
import {registerTaskAgentNotesRoutes,pendingAgentQuestions} from './task-agent-notes.js';
import {registerTaskCancellationRoutes} from './task-cancellation.js';
import {enqueueDevelopment,reconcileAgentWorkQueue,reconcileLegacyAgentWorkQueue} from './agent-work-scheduler.js';
import {reconcileAgentPeerQueue} from './agent-peer-queue.js';
import {reconcileAgentWorkAssignments} from './modules/agents/application/work-assignments.js';
import {reconcileTaskAnalysisQueue,reuseExistingAnalysisForDevelopment} from './task-analysis-queue.js';
import {reconcileIdlePullRequests} from './idle-pr-recovery.js';
import {reconcileTaskEvidenceQueue} from './task-evidence-queue.js';
import {acceptAnalysisAnswer,isPrEvidenceRequest,registerProjectManagerRoutes,type ManagerDeps} from './project-manager.js';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { SignJWT } from 'jose';
import {randomUUID} from 'node:crypto';
import { z } from 'zod';

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let temporalClient:Promise<Client>|null=null;
function temporal():Promise<Client>{
 return temporalClient??=Connection.connect({address:process.env.TEMPORAL_ADDRESS||'temporal:7233'})
  .then(connection=>new Client({connection,namespace:'default'}))
  .catch(error=>{temporalClient=null;throw error;});
}

const jwtKey = new TextEncoder().encode(process.env.JWT_SECRET || '');
const keyText = process.env.CREDENTIALS_KEY || '';
const encryptionKey = Buffer.from(keyText, 'hex');
if (!process.env.JWT_SECRET || jwtKey.length < 32 || encryptionKey.length !== 32) throw Error('Set secure JWT_SECRET and 64-char hex CREDENTIALS_KEY');
// Preserve the original administrator account when upgrading legacy local installs.
// A dotted reserved domain also passes conventional email validation.
function configuredAdminEmail(){
 const email=(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
 return email==='admin@localhost'?'admin@localhost.test':email;
}
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T> { return schema.parse(input); }
installDiagnosticHooks(app,pool);
app.setErrorHandler((error,_,reply) => {
 if(error instanceof z.ZodError) return reply.code(400).send({error:'Некорректные данные',details:error.flatten()});
 app.log.error(error);
 const err = error as Error & {statusCode?:number};
 const status = typeof err.statusCode==='number' && err.statusCode>=400 && err.statusCode<500 ? err.statusCode : 500;
 return reply.code(status).send({error:status<500?err.message:'Ошибка сервера'});
});
registerAuthRoutes(app,pool,jwtKey);
const accessToken=(userId:string,email:string)=>issueAccessToken(jwtKey,userId,email);
const uid=(req:any):string=>req.userId;
async function canAccess(projectId:string,userId:string) {
 const r=await pool.query('SELECT 1 FROM memberships m JOIN projects p ON p.id=m.project_id WHERE m.project_id=$1 AND m.user_id=$2 AND p.deleted_at IS NULL',[projectId,userId]);
 return !!r.rowCount;
}
async function access(req:any,reply:any,projectId:string) {
 if(!await canAccess(projectId,uid(req))){reply.code(403).send({error:'Нет доступа к проекту'});return false;}return true;
}
app.get('/api/health',async()=>({ok:true}));
registerChatImageRoutes(app,{pool,access});
registerDiagnosticRoutes(app,{pool,access});
const codexUrl=process.env.CODEX_RUNNER_URL||'http://codex:4300';
registerCodexAdminRoutes({app,pool,runnerUrl:codexUrl,runnerSecret:()=>runnerKey,adminEmail:configuredAdminEmail,requireAdmin});

registerProjectGitRoutes({app,pool,uid,access,decryptToken});

const runnerKey=process.env.RUNNER_SHARED_SECRET||'';
if(!runnerKey || runnerKey.length<32)throw Error('Set RUNNER_SHARED_SECRET (32+ chars)');
if(runnerKey===process.env.JWT_SECRET)throw Error('RUNNER_SHARED_SECRET must differ from JWT_SECRET');
async function agentCall(path:string,method:'GET'|'POST'='GET',body?:unknown){
 const resp=await fetch(codexUrl+path,{
  method,
  headers:{'X-Runner-Secret':runnerKey,...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,
  signal:AbortSignal.timeout(15000)
 });
 const data=await resp.json().catch(()=>({error:'Некорректный ответ исполнителя'}));
 if(!resp.ok)throw Object.assign(new Error(String(data.error||'Ошибка исполнителя').slice(0,600)),{statusCode:resp.status===409?409:503});
 return data as any;
}
async function requireAdmin(req:any,reply:any){
 const u=await pool.query('SELECT email FROM users WHERE id=$1',[uid(req)]);
 if(u.rows[0]?.email!==configuredAdminEmail()){
  reply.code(403).send({error:'На первом этапе запуск AI разрешён только администратору'});
  return false;
 }
 return true;
}
registerCloudDiagnosticsSettings(app,{pool,requireAdmin});
function decryptToken(packedText:string){return decryptConnectionSecret(packedText,encryptionKey);}
registerAiSettingsRoutes(app,{pool,access,requireAdmin});
app.post('/api/projects/:id/tasks/:taskId/run-ai',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const {approveAnalysis,iterationApproval}=z.object({approveAnalysis:z.boolean().default(false),
  iterationApproval:z.object({id:z.string().uuid(),revision:z.number().int().positive()}).optional()}).parse(req.body||{});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  if(approveAnalysis)await reuseExistingAnalysisForDevelopment(client,id,taskId,uid(req));
  const scope=iterationApproval
   ?{iterationId:iterationApproval.id,revision:iterationApproval.revision,taskIds:[taskId]}
   :{taskId,approveAnalysis};
  const {tasks:[intent]}=await enqueueDevelopment(client,id,uid(req),scope);
  const ai=await resolveRoleAiSettings(client,id,'development');
  await client.query('UPDATE projects SET agents_running=true WHERE id=$1',[id]);
  await client.query('COMMIT');
  return reply.code(202).send({id:intent.run_id,task_id:taskId,status:'queued',
   message:'Запуск принят. Подробности ожидания — в Центре процессов.',model:ai.model,created_at:intent.created_at});
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
});
registerQualityOperationsRoutes(app,{pool,uid,access,requireAdmin,temporal,runnerUrl:codexUrl,runnerSecret:runnerKey,decryptToken});
registerDevelopmentRunStatusRoutes({app,pool,access});

const {mergeTaskPr,startMergeBatch}=registerMergeOperationsRoutes({app,pool,uid,access,requireAdmin,temporal,decryptToken});
registerBackgroundProcessRoutes(app,pool,uid);

registerProjectCoreRoutes(app,{pool,uid,access,requireAdmin});
registerWorkflowSettingsRoutes(app,{pool,uid,access,requireAdmin});
const {updateDependency,startRequirementsReview}=registerProjectTaskRoutes(app,{pool,uid,access,requireAdmin,temporal});
registerProjectProcessRoutes(app,{pool,uid,access,requireAdmin,temporal});
registerDocumentationRoutes(app,{pool,access,requireAdmin});
registerConnectionRoutes({app,pool,uid,access,encryptionKey});
async function startIterationPlanning(runId:string){
 try{
  const client=await temporal();
  await client.workflow.start('prepareIterationPlan',{taskQueue:'agent-pipeline',workflowId:'iteration-plan-'+runId,
   workflowIdReusePolicy:'REJECT_DUPLICATE',args:[runId]});
 }catch(error){if((error as Error)?.name!=='WorkflowExecutionAlreadyStartedError')throw error;}
}
registerAgentToolRoutes(app,{pool,access,requireAdmin,runnerSecret:runnerKey,decryptToken,startIterationPlanning,startDocumentationWorkflow:async jobId=>{
 const client=await temporal();
 await client.workflow.start('prepareProjectSpecification',{taskQueue:'agent-pipeline',workflowId:'analyst-'+jobId,args:[jobId]});
},delegateManagerAction:async(session,name,args)=>{
 const projectId=session.project_id;
 if(session.role!=='manager')throw Object.assign(Error('Действие только для ПМ'),{statusCode:403});
 const user=(await pool.query('SELECT email FROM users WHERE id=$1',[session.actor_id])).rows[0];
 if(!user)throw Object.assign(Error('Пользователь не найден'),{statusCode:403});
 const id=z.string().uuid();
 const authorizeDestructiveSource=(sourceId:string)=>authorizePmDestructiveSource(pool,{
  projectId,actorId:session.actor_id,currentMessageId:session.process_id,sourceMessageId:sourceId
 });
 if(name==='tasks.update_dependency'){
   const taskId=id.parse(args.task_id);
   const parentId=z.string().uuid().nullable().parse(args.depends_on_task_id);
   const reason=z.string().trim().min(10).max(1200).parse(args.reason);
   const result=await updateDependency(projectId,taskId,parentId,session.actor_id);
   await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'pm_dependency_decision',$4)",
    [randomUUID(),taskId,session.actor_id,reason]);
   return result;
  }
  if(name==='approvals.deliver_task_answer'){
   const taskId=id.parse(args.task_id),sourceMessageId=id.parse(args.source_message_id);
   // The model must not invent, edit or substitute customer answers. Read the
   // authentic chat message and verify that this actor owns the project.
   const owner=await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[projectId,session.actor_id]);
   if(!owner.rowCount)throw Object.assign(Error('Только владелец проекта может передавать ответы аналитику'),{statusCode:403});
   const source=await pool.query(`
    SELECT body,task_id FROM manager_messages
      WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user' AND status IN ('queued','processing','completed')
    UNION ALL
    SELECT body,task_id FROM assistant_messages
      WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user' AND status IN ('queued','processing','completed')
   `,[sourceMessageId,projectId,session.actor_id]);
   if(source.rows.length!==1)throw Object.assign(Error('Исходное сообщение владельца не найдено в истории проекта'),{statusCode:403});
   if(source.rows[0].task_id&&source.rows[0].task_id!==taskId)
    throw Object.assign(Error('Нельзя передать ответ из чужой задачи. Укажи исходное сообщение из этого чата или чата проекта'),{statusCode:409});
   const saved=await acceptAnalysisAnswer(pool,projectId,taskId,session.actor_id,String(source.rows[0].body||''),sourceMessageId);
   if(!saved.accepted)throw Object.assign(Error(saved.reason),{statusCode:409});
   return {status:'analyst_queued',task_id:taskId,source_message_id:sourceMessageId,answered_questions:saved.answered,
    message:saved.reason};
  }
  if(name==='tasks.delete'){
   const taskId=id.parse(args.task_id),sourceMessageId=id.parse(args.source_message_id);
   await authorizeDestructiveSource(sourceMessageId);
   const owner=await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[projectId,session.actor_id]);
   const source=await pool.query(`
    SELECT body,task_id FROM manager_messages WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user'
    UNION ALL
    SELECT body,task_id FROM assistant_messages WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user'
   `,[sourceMessageId,projectId,session.actor_id]);
   if(!owner.rowCount||source.rows.length!==1)throw Object.assign(Error('Для удаления требуется реальное поручение владельца проекта'),{statusCode:403});
   if(source.rows[0].task_id&&source.rows[0].task_id!==taskId)
    throw Object.assign(Error('Нельзя удалять другую задачу по сообщению из этой карточки'),{statusCode:403});
   const token=await accessToken(session.actor_id,user.email);
   const response=await app.inject({method:'DELETE',url:'/api/projects/'+projectId+'/tasks/'+taskId,
    headers:{authorization:'Bearer '+token},payload:{confirm_task_id:taskId}});
   const body=response.json() as {error?:string;ok?:boolean;display_number?:number};
   if(response.statusCode===409)return {status:'blocked',task_id:taskId,reason:String(body.error||'Задачу нельзя удалить обычным способом'),blocked_tool:'tasks.delete'};
   if(response.statusCode>=400)throw Object.assign(Error(String(body.error||'Не удалось удалить задачу')),{statusCode:response.statusCode});
   return {...body,status:'deleted',task_id:taskId};
  }
  if(name==='tasks.cancel'||name==='tasks.close'||name==='workflow.move_task'){
   const taskId=id.parse(args.task_id),sourceMessageId=id.parse(args.source_message_id);
   if(name==='tasks.cancel'||name==='tasks.close')await authorizeDestructiveSource(sourceMessageId);
   const owner=await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[projectId,session.actor_id]);
   const message=await pool.query(`
    SELECT body,task_id FROM manager_messages WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user'
    UNION ALL
    SELECT body,task_id FROM assistant_messages WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user'
   `,[sourceMessageId,projectId,session.actor_id]);
   if(!owner.rowCount||message.rows.length!==1||message.rows[0].task_id&&message.rows[0].task_id!==taskId)
    throw Object.assign(Error('Нужно подтверждённое поручение владельца из общего чата или этой задачи'),{statusCode:403});
   const token=await accessToken(session.actor_id,user.email);
   const headers={authorization:'Bearer '+token};
   const taskPath='/api/projects/'+projectId+'/tasks/'+taskId;
   const call=async(method:'GET'|'PATCH'|'POST',endpoint:string,payload?:Record<string,unknown>)=>{
    const response=await app.inject({method,url:taskPath+endpoint,headers,...(payload?{payload}:{})});
    const data=response.json() as Record<string,any>;
    if(response.statusCode>=400)return {status:'blocked',stage:null,reason:String(data.error||'Сервер отклонил переход'),blockers:data.blockers||null};
    return data;
   };
   if(name==='tasks.close'){
    const db=await pool.connect();
    try{
     await db.query('BEGIN');
     const task=(await db.query(`SELECT t.id,t.stage,t.documentation_updated_at,t.pr_url,t.implementation_kind,t.implementation_commit,
      d.merge_sha,d.status AS deployment_status FROM tasks t LEFT JOIN task_deployment_records d
      ON d.task_id=t.id AND d.project_id=t.project_id WHERE t.id=$1 AND t.project_id=$2 FOR UPDATE OF t`,[taskId,projectId])).rows[0];
     if(!task){await db.query('ROLLBACK');return {status:'blocked',reason:'Задача отсутствует'};}
     if(task.stage==='done'){await db.query('ROLLBACK');return {status:'already_closed',stage:'done'};}
     const pending=await db.query("SELECT 1 FROM knowledge_document_updates u WHERE u.project_id=$1 AND u.status='pending' AND $2=ANY(u.task_ids) LIMIT 1",[projectId,taskId]);
     const verifiedExisting=task.implementation_kind==='already_implemented'&&task.implementation_commit===task.merge_sha&&
      ['skipped','manual_confirmed','automatic_verified'].includes(task.deployment_status);
     if(!canManagerCloseTask(task.stage as WorkStage,!!task.documentation_updated_at,!!task.pr_url||verifiedExisting,!!pending.rowCount)){
      await db.query('ROLLBACK');
      return {status:'blocked',stage:task.stage,reason:pending.rowCount?'Документация ожидает согласования':'Нельзя пометить задачу готовой: слияние, выкладка или обновление документации ещё не подтверждены'};
     }
     const finished=await db.query("UPDATE tasks SET stage='done',updated_at=now() WHERE project_id=$1 AND id=$2 AND stage='documentation' RETURNING id",[projectId,taskId]);
     if(!finished.rowCount)throw Object.assign(Error('Задача изменилась во время завершения'),{statusCode:409});
     await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'closed_by_manager',$4)",[randomUUID(),taskId,session.actor_id,'ПМ завершил задачу после подтверждения всех обязательных этапов и документации']);
     await db.query('COMMIT');
     return {status:'completed',stage:'done',message:'Задача закрыта по явному поручению владельца, все обязательные этапы подтверждены'};
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
   }
   if(name==='tasks.cancel'){
    // Explicitly authenticated owner message, task scope and preview are the safeguards.
    // Word matching would misroute synonyms and penalize follow-up instructions.
    const preview=await call('GET','/cancel-preview');
    if(preview.status==='blocked')return preview;
    if(Array.isArray(preview.blocked)&&preview.blocked.length)return {status:'blocked',reason:'Отмена не разрешена: есть связанные данные или активные процессы',blockers:preview.blocked};
    const result=await call('POST','/cancel',{confirm:true});
    return result.status==='blocked'?result:{...result,status:'cancelled',message:'Задача отменена через штатный процесс с аудитом и безопасной очисткой GitHub.'};
   }
   const target=z.enum(['backlog','analysis','development','testing','merge_queue','deployment','documentation','done']).parse(args.target_stage) as WorkStage;
   const reason=z.string().trim().min(5).max(1200).parse(args.reason);
   const row=(await pool.query('SELECT id,type,stage,analysis_state,pr_url,git_branch FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId])).rows[0];
   if(!row)return {status:'blocked',reason:'Задача не найдена'};
   if(['epic','question'].includes(row.type))return {status:'blocked',reason:'Эпик следует за дочерними задачами автоматически; вопросы не имеют собственного workflow'};
   const move=planManagerStageMove(row.stage as WorkStage,target,!!(row.pr_url&&row.git_branch));
   if(move.operation==='blocked')return {status:'blocked',stage:row.stage,reason:move.reason};
   if(move.operation==='same')return {status:'already_on_stage',stage:row.stage,message:move.reason};
   if(move.operation==='patch')return await call('PATCH','',{stage:target});
   if(move.operation==='approve_development')
    return await call('POST','/run-ai',{approveAnalysis:true});
   if(move.operation==='resume_development'){
    const state=await recoverTask({projectId,taskId,auth:'Bearer '+token,cookie:''});
    return state.ok?{status:'queued',stage:target,message:state.message}:{status:'blocked',stage:row.stage,reason:state.message};
   }
   if(move.operation==='retry_qa')return await call('POST','/start-testing',{});
   if(move.operation==='apply_qa')return await call('POST','/apply-qa-result',{});
   // Real rework transitions leave the PR, branch, previous QA, comments and
   // task events intact. Never mark a result passed or completed in this path.
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const current=(await client.query('SELECT stage,analysis_state,pr_url,git_branch FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,taskId])).rows[0];
    if(!current||current.stage!==row.stage||current.analysis_state!==row.analysis_state)
     throw Object.assign(Error('Стадия задачи изменилась. Прочитай карточку повторно.'),{statusCode:409});
    const sourceKey='pm-stage:'+sourceMessageId+':'+target;
    const previous=await client.query('SELECT 1 FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND source_key=$3',[projectId,taskId,sourceKey]);
    if(previous.rowCount){
     await client.query('ROLLBACK');
     return {status:'already_applied',stage:row.stage,message:'Это решение ПМ уже было применено к задаче; повторно перезапускать работу не нужно'};
    }
    const running=await client.query(`SELECT 1 FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'
     UNION ALL SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running')
     UNION ALL SELECT 1 FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running')
     UNION ALL SELECT 1 FROM agent_analysis_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running')`,[projectId,taskId]);
    if(running.rowCount)throw Object.assign(Error('В задаче уже работает агент. Сначала дождись окончания или останови активный процесс.'),{statusCode:409});
    if(move.operation==='reanalyze'&&row.stage==='analysis'&&['waiting_questions','needs_clarification'].includes(row.analysis_state))
     throw Object.assign(Error('Аналитик ожидает ответов владельца, а не повторного запуска без новых фактов'),{statusCode:409});
    const updated=await client.query(`UPDATE tasks SET stage=$3,analysis_state=CASE WHEN $3='analysis' THEN 'new' ELSE analysis_state END,
     test_feedback=CASE WHEN $3='analysis' OR $3='development' THEN $4 ELSE test_feedback END,updated_at=now()
     WHERE project_id=$1 AND id=$2 AND stage=$5 RETURNING id`,
     [projectId,taskId,target,'Доработка по поручению ПМ: '+reason,row.stage]);
    if(!updated.rowCount)throw Object.assign(Error('Этап изменился во время перехода'),{statusCode:409});
    await client.query(`INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,actor_id,status)
      VALUES($1,$2,$3,'manager','Менеджер проекта','all','handoff',$4,'human',$5,$6,'resolved') ON CONFLICT(task_id,source_key) DO NOTHING`,
     [randomUUID(),projectId,taskId,'Изменившиеся вводные или требуемая доработка: '+reason,'pm-stage:'+sourceMessageId+':'+target,session.actor_id]);
    await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'stage_changed',$4)",
     [randomUUID(),taskId,session.actor_id,row.stage+' → '+target+'. '+reason]);
    await client.query('COMMIT');
    return {status:'moved',previous_stage:row.stage,stage:target,continued:true,
     message:'Задача возвращена на '+target+'. Артефакты и история сохранены; на следующем запуске агент получит комментарии и исправит только затронутое.'};
   }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  const taskId=id.parse(args.task_id);
 const task=(await pool.query('SELECT id,iteration_id,stage FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId])).rows[0];
 if(!task)throw Object.assign(Error('Задача не найдена'),{statusCode:404});
 if(name==='workflow.release_task'){
  // Only the owner who is currently speaking in this task can authorize a release.
  const sourceMessageId=id.parse(args.source_message_id);
  const isOwner=await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[projectId,session.actor_id]);
  const message=await pool.query("SELECT 1 FROM manager_messages WHERE id=$1 AND project_id=$2 AND task_id=$3 AND actor_id=$4 AND role='user' AND status='processing'",
   [sourceMessageId,projectId,taskId,session.actor_id]);
  if(!isOwner.rowCount||!message.rowCount)throw Object.assign(Error('Для перехода требуется явное текущее поручение владельца в этой задаче'),{statusCode:403});
  if(task.stage==='testing'){
   const last=(await pool.query('SELECT status,verdict,report FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[projectId,taskId])).rows[0];
   return {status:'blocked',stage:'testing',reason:last?.verdict==='blocked'
    ?'QA не подтвердил все тест-кейсы. В карточке задачи нужно явно согласовать исключения или настроить браузер и повторить QA. Запрос на выкладку не разрешает автоматически пропускать проверки.'
    :last?.verdict==='failed'?'QA нашёл дефекты. Требуется исправление и повторное тестирование.':'Задача пока на тестировании. Дождись подтверждённого результата QA.',
    verdict:last?.verdict||null};
  }
  let mergeResult:null|{status:string;url?:string}=null;
  if(task.stage==='merge_queue'){
   mergeResult=await mergeTaskPr(projectId,taskId,session.actor_id);
  }else if(!['deployment','documentation','done'].includes(task.stage)){
   return {status:'blocked',stage:task.stage,reason:'Задача не готова к слиянию или выкладке. Дождись завершения текущего этапа.'};
  }
  const deployment=(await pool.query(
   'SELECT t.stage,d.status,d.merge_sha,s.mode,s.health_url FROM tasks t LEFT JOIN task_deployment_records d ON d.task_id=t.id AND d.project_id=t.project_id LEFT JOIN project_deployment_settings s ON s.project_id=t.project_id WHERE t.project_id=$1 AND t.id=$2',
   [projectId,taskId])).rows[0];
  if(!deployment)return {status:'blocked',reason:'Задача не найдена после проверки слияния'};
  if(deployment.stage==='documentation'||deployment.stage==='done')return {status:'completed',stage:deployment.stage,merged:!!mergeResult,
   reason:deployment.status==='skipped'?'PR слит; выкладка пропущена по настройкам проекта. Факт работы сайта не проверен.':'Этап слияния и/или выкладки уже завершён',pr_url:mergeResult?.url};
  if(deployment.stage!=='deployment'||deployment.status!=='pending')return {status:'blocked',stage:deployment.stage,reason:'Нет ожидающей выкладки по задаче'};
  if(deployment.mode!=='automatic')return {status:'waiting_user',stage:'deployment',reason:'PR слит; по настройкам проекта требуется ручная выкладка либо её явный пропуск. Автоматическая выкладка не настроена.',pr_url:mergeResult?.url};
  if(!deployment.merge_sha)return {status:'blocked',stage:'deployment',reason:'Не сохранён SHA слитого PR. Автоматическая выкладка не может быть подтверждена.'};
  if(!deployment.health_url)return {status:'blocked',stage:'deployment',reason:'Для автоматической выкладки требуется публичный HTTPS URL проверки приложения.'};
  const active=(await pool.query("SELECT id,status FROM deployment_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",[projectId,taskId])).rows[0];
  if(active)return {status:'already_running',stage:'deployment',run_id:active.id,reason:'Выкладка уже выполняется. Дублировать запуск не нужно.'};
  const token=await accessToken(session.actor_id,user.email);
  const response=await app.inject({method:'POST',url:'/api/projects/'+projectId+'/tasks/'+taskId+'/deployment/start',
   headers:{authorization:'Bearer '+token},payload:{confirm:true,commit_sha:deployment.merge_sha}});
  const result=response.json() as {error?:string;run_id?:string;status?:string};
  if(response.statusCode>=400)throw Object.assign(Error(String(result.error||'Запуск выкладки отклонён')),{statusCode:response.statusCode});
  return {status:'queued',stage:'deployment',run_id:result.run_id,pr_url:mergeResult?.url,reason:'Автоматическая выкладка поставлена в Temporal. Проверка GitHub Actions и доступности сайта ещё не завершена.'};
 }
 const token=await accessToken(session.actor_id,user.email);
 let url='/api/projects/'+projectId+'/tasks/'+taskId,payload:Record<string,unknown>={};
 if(name==='approvals.answer_question'){
  const noteId=id.parse(args.note_id);
  const answer=z.string().trim().min(3).max(3000).parse(args.answer);
  url+='/agent-notes/'+noteId+'/answer';payload={answer};
 }else if(name==='approvals.decide'){
  const requestId=id.parse(args.request_id);
  const choice=z.enum(['approve_without_visual','wait_for_tools','answer','approve_requirements','reject_requirements']).parse(args.choice);
  const answer=z.string().trim().max(3000).default('').parse(args.answer);
  url+='/manager/requests/'+requestId+'/decision';payload={choice,answer};
 }else if(name==='qa.retry'){
  url+='/start-testing';payload={};
 }else if(name==='workflow.approve_development'){
  url+='/run-ai';payload={approveAnalysis:true};
  if(task.iteration_id){
   const iteration=(await pool.query('SELECT id,revision,approved_revision FROM project_iterations WHERE project_id=$1 AND id=$2',[projectId,task.iteration_id])).rows[0];
   if(!iteration||iteration.approved_revision!==iteration.revision)
    throw Object.assign(Error('Объём итерации не согласован или изменился'),{statusCode:409});
   payload.iterationApproval={id:iteration.id,revision:iteration.revision};
  }
 }else throw Object.assign(Error('Недопустимое действие ПМ'),{statusCode:403});
 const response=await app.inject({method:'POST',url,headers:{authorization:'Bearer '+token},payload});
 let result:any;
 try{result=response.json();}catch{result={error:response.body.slice(0,300)};}
 if(response.statusCode>=400)throw Object.assign(Error(String(result.error||'Операция не выполнена').slice(0,700)),{statusCode:response.statusCode});
 return name==='qa.retry'?{...result,task_id:taskId}:result;
}});
const assistant=registerAssistantRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey,decryptToken,
 startDocumentationWorkflow:async jobId=>{
  const client=await temporal();
  await client.workflow.start('prepareProjectSpecification',{taskQueue:'agent-pipeline',workflowId:'analyst-'+jobId,args:[jobId]});
 }
});
registerProjectManagerInbox(app,{pool,uid,access,requireAdmin,start:async turn=>{
 const client=await temporal();
 const workflowId=pmInboxWorkflowId(turn);
 try{
  await client.withDeadline(Date.now()+5000,()=>client.workflow.start('processProjectManagerInbox',{
   taskQueue:'agent-pipeline',workflowId,workflowIdReusePolicy:'REJECT_DUPLICATE',
   args:[turn.project_id,turn.id,turn.pm_dispatch_attempt]
  }));
 }catch(error){
  if((error as Error)?.name!=='WorkflowExecutionAlreadyStartedError')throw error;
  const previous=await client.withDeadline(Date.now()+5000,()=>client.workflow.getHandle(workflowId).describe());
  // A legacy workflow may have exhausted its retries before persisting the failure.
  if(['FAILED','CANCELLED','TERMINATED','TIMED_OUT','COMPLETED'].includes(previous.status.name))
   await failProjectManagerInbox(pool,turn.project_id,turn.id,turn.pm_dispatch_attempt);
 }
}});
registerKnowledgeRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey});
registerKnowledgeContextRoutes(app,{pool,access,requireAdmin});
registerDocumentationResetRoutes(app,{pool,uid,access,requireAdmin});
registerSafeTaskDeletion(app,{pool,uid,access,requireAdmin});
registerProjectIterationRoutes(app,{pool,uid,access,requireAdmin,startPlanning:startIterationPlanning});
registerAutomaticDeploymentRoutes(app,{pool,uid,access,requireAdmin,decrypt:decryptToken,
 encrypt:(secret:string)=>encryptConnectionSecret(secret,encryptionKey),
 start:async runId=>{
 const client=await temporal();
 await client.workflow.start('automaticDeployment',{taskQueue:'agent-pipeline',workflowId:'deployment-'+runId,
  workflowIdReusePolicy:'REJECT_DUPLICATE',args:[runId]});
}});
registerBusinessAnalystHandoff(app,{pool,uid,access});
registerProjectTeamRoutes(app,{pool,access,requireAdmin,uid,codexUrl,runnerKey});
registerKnowledgeWorkflowRoutes(app,{pool,access,requireAdmin});
registerKnowledgeDocumentUpdateRoutes(app,{pool,uid,access,requireAdmin});
registerQaRoutes(app,{pool,uid,access,requireAdmin});
registerQaWaiverRoutes(app,{pool,uid,access,requireAdmin,decryptToken});
async function recoverTask({projectId,taskId,auth,cookie}:Parameters<ManagerDeps['recoverTask']>[0]):ReturnType<ManagerDeps['recoverTask']>{
  const task=(await pool.query("SELECT t.stage,t.analysis_state,t.pr_number,t.git_branch,t.pr_url,t.spec_review_status,t.spec_version,t.test_feedback,g.repository,c.secret_encrypted FROM tasks t LEFT JOIN project_git_repositories g ON g.project_id=t.project_id LEFT JOIN connections c ON c.id=g.connection_id WHERE t.id=$1 AND t.project_id=$2",
   [taskId,projectId])).rows[0];
  if(!task)return {ok:false,status:404,message:'Задача не найдена'};
  if(!['testing','development'].includes(task.stage))
   return {ok:false,status:409,message:'Восстановление доступно на этапе разработки или тестирования.'};
  const taskPath='/api/projects/'+projectId+'/tasks/'+taskId;
  const request=(route:string)=>app.inject({method:'POST',url:taskPath+route,headers:{authorization:auth,cookie},payload:{}});
  const owner=await pool.query("SELECT 1 FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[projectId,taskId]);
  if(owner.rowCount&&task.stage==='development')
   return {ok:false,status:409,message:'Для задачи уже зарегистрирован процесс разработки. Его состояние доступно в Центре процессов.'};
  const notes=await pool.query("SELECT id,body FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status='open' AND author_stage='analysis'",[projectId,taskId]);
  const evidenceNotes=notes.rows.filter(note=>isPrEvidenceRequest(note.body));
  const review=task.spec_review_status==='needs_approval'
   ?(await pool.query("SELECT id,classification,questions FROM task_requirement_reviews WHERE project_id=$1 AND task_id=$2 AND spec_version=$3 AND status='needs_approval' ORDER BY created_at DESC LIMIT 1",[projectId,taskId,task.spec_version])).rows[0]
   :null;
  const evidenceReview=review?.classification==='uncertain'&&Array.isArray(review.questions)
   &&review.questions.length>0&&review.questions.every(isPrEvidenceRequest);
  if(task.spec_review_status==='needs_approval'&&!evidenceReview)
   return {ok:false,status:409,message:'Сначала нужно разрешить содержательное замечание аналитика по требованиям.'};
  if(task.stage==='testing'){
   const decision=await pool.query("SELECT 1 FROM manager_requests WHERE project_id=$1 AND task_id=$2 AND kind='qa_visual' AND status IN ('open','waiting') AND source_id=(SELECT id FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1)",[projectId,taskId]);
   if(decision.rowCount)return {ok:false,status:409,message:'В Центре процессов ожидается решение по непроверенным визуальным сценариям.'};
  }
  // An existing PR may be parked in development even though no code revision is due.
  // A real rejection or QA finding still goes back through the developer.
  const handoff=task.stage==='development'&&task.analysis_state==='approved'&&task.pr_url&&task.git_branch&&!task.test_feedback&&task.spec_review_status!=='rejected';
  if(evidenceNotes.length||evidenceReview||handoff){
   if(!task.pr_number||!task.repository||!task.secret_encrypted)
    return {ok:false,status:409,message:'Не удалось найти PR через подключение GitHub проекта.'};
   const response=await fetch('https://api.github.com/repos/'+task.repository+'/pulls/'+task.pr_number,{
    headers:{Authorization:'Bearer '+decryptToken(task.secret_encrypted),Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
    signal:AbortSignal.timeout(15000)
   });
   if(!response.ok)return {ok:false,status:503,message:'Не удалось подтвердить PR в GitHub: HTTP '+response.status};
   const pr=await response.json() as any;
   if(pr.state!=='open'||pr.head?.ref!==task.git_branch||!pr.head?.sha)
    return {ok:false,status:409,message:'PR закрыт или не соответствует ветке задачи.'};
   const tx=await pool.connect();
   try{
    await tx.query('BEGIN');
    const current=(await tx.query("SELECT stage,analysis_state,spec_version,spec_review_status,pr_number,git_branch,test_feedback FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE",[taskId,projectId])).rows[0];
    if(!current||['stage','analysis_state','spec_version','spec_review_status','pr_number','git_branch','test_feedback'].some(key=>current[key]!==task[key])){
     await tx.query('ROLLBACK');return {ok:false,status:409,message:'Состояние задачи изменилось во время проверки PR.'};
    }
    if(evidenceNotes.length)await tx.query("UPDATE task_agent_notes SET status='answered',answer='PR подтверждён в GitHub. Аналитик получит изменения PR при сверке, а тестировщик проверит реализацию.',answer_author='Менеджер проекта',answered_at=now(),processing_at=NULL,requires_customer=false WHERE project_id=$1 AND task_id=$2 AND status='open' AND id=ANY($3::uuid[])",
     [projectId,taskId,evidenceNotes.map(note=>note.id)]);
    if(evidenceReview){
     const cleared=await tx.query("UPDATE task_requirement_reviews SET status='superseded',resolved_at=now() WHERE id=$1 AND status='needs_approval' RETURNING id",[review.id]);
     if(!cleared.rowCount){await tx.query('ROLLBACK');return {ok:false,status:409,message:'Решение по требованиям уже изменилось.'};}
     await tx.query("UPDATE tasks SET spec_review_status='pending',spec_review_note='Аналитик повторно сверит ТЗ по актуальному PR',updated_at=now() WHERE id=$1",[taskId]);
    }
    const pending=await tx.query("SELECT 1 FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status IN ('open','processing') AND (target_stage='all' OR requires_customer) LIMIT 1",[projectId,taskId]);
    if(handoff&&!pending.rowCount){
     const advanced=await tx.query("UPDATE tasks SET stage='testing',updated_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND state='active') AND NOT EXISTS(SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND status IN ('queued','running')) RETURNING id",[taskId]);
     if(!advanced.rowCount){
      await tx.query('ROLLBACK');return {ok:false,status:409,message:'Для задачи уже запущена разработка.'};
     }
     await tx.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'stage_changed',$3)",[randomUUID(),taskId,'Менеджер передал существующий PR на сверку и тестирование']);
     task.stage='testing';
    }
    await tx.query('COMMIT');
   }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
  }
  const response=await request(task.stage==='development'?'/run-ai':'/start-testing');
  const data=response.json() as any;
  if(response.statusCode>=400)
   return {ok:false,status:response.statusCode,message:String(data.error||'Проверка условий перехода не прошла'),details:data};
  return {ok:true,status:202,message:task.stage==='development'
   ?'Разработка в очереди. После неё автоматически запустится тестирование.'
   :'Запущено тестирование существующего PR.',details:data};
 }
registerTaskAgentNotesRoutes(app,{pool,uid,access,requireAdmin,startRequirementsReview,resumeAfterAnswer:async input=>{
 const owner=await pool.query("SELECT 1 FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[input.projectId,input.taskId]);
 if(owner.rowCount)return {started:true,message:'Ответ передан в текущий процесс.'};
 const intent=(await pool.query(`SELECT q.status,q.spec_version,t.spec_version AS current_spec,q.iteration_id,t.iteration_id AS current_iteration,
  q.approved_revision,i.approved_revision AS current_approval,i.revision
  FROM iteration_execution_queue q JOIN tasks t ON t.id=q.task_id
  LEFT JOIN project_iterations i ON i.id=q.iteration_id
  WHERE q.project_id=$1 AND q.task_id=$2 AND q.status IN ('queued','stale')`,[input.projectId,input.taskId])).rows[0];
 if(intent){
  const valid=intent.status==='queued'&&intent.spec_version===intent.current_spec&&intent.iteration_id===intent.current_iteration
   &&(!intent.iteration_id||intent.approved_revision===intent.current_approval&&intent.approved_revision===intent.revision);
  if(valid)return {started:true,message:'Ответ сохранён. Диспетчер повторно проверит условия запуска.'};
  return {started:false,message:'Ответ сохранён. Изменившийся запуск нужно подтвердить повторно.'};
 }
 const result=await recoverTask(input);
 return {started:result.ok,message:result.message};
}});
registerTaskCancellationRoutes(app,{pool,uid,access,requireAdmin,decryptToken});
registerProjectManagerRoutes(app,{pool,uid,access,requireAdmin,
 decideAction:assistant.decideTaskManagerAction,
 workerSecret:runnerKey,
 workerAuthorization:async(actorId,email)=>'Bearer '+await new SignJWT({email}).setProtectedHeader({alg:'HS256'})
  .setSubject(actorId).setIssuedAt().setExpirationTime('2m').sign(jwtKey),
 recoverTask,
 stopManagerWorkflow:async messageId=>{
  const client=await temporal();
  await client.workflow.getHandle('manager-msg-'+messageId).cancel();
 },
 startManagerWorkflow:async({projectId,taskId,messageId})=>{
  const client=await temporal();
  await client.workflow.start('projectManagerReply',{taskQueue:'agent-pipeline',workflowId:'manager-msg-'+messageId,args:[{projectId,taskId,messageId}]});
 }
});
async function main(){
 await runSchemaMigrations(pool,coreSchemaMigrations(workflowStageDescriptions));
 // These are runtime policies, not schema migrations: run on every restart.
 // Preserve the project's durable agents_running choice across deployments.
 await ensureLegacyAdministrator(pool,configuredAdminEmail());
await startDiagnosticRetention(pool);await reconcileLegacyAgentWorkQueue(pool);await reconcileProjectTeamProfiles(pool);await recoverInterruptedLegacyMergeBatches(pool);await app.listen({port:Number(process.env.PORT||3001),host:'0.0.0.0'});
  startCloudDiagnosticsSender(pool,{url:process.env.SUPABASE_DIAGNOSTICS_URL||'',apiKey:process.env.SUPABASE_DIAGNOSTICS_API_KEY||'',logger:message=>app.log.warn(message)});
 const reconcileLegacyDevelopmentRuns=createLegacyDevelopmentReconciler(
  pool,path=>agentCall(path),
  (error,runId)=>app.log.warn({error,runId},'Legacy development reconciliation failed')
 );
 const queueReconciler=createQueueReconciler([
  {label:'Agent peer queue',execute:()=>reconcileAgentPeerQueue(pool,temporal)},
  {label:'Generic delegated work',execute:()=>reconcileAgentWorkAssignments(pool,temporal)},
  {label:'Merge queue',execute:()=>recoverMergeBatches(pool,startMergeBatch)},
  {label:'PM owner questions',execute:()=>publishOwnerQuestionsToPmChat(pool)},
  {label:'PM stalled work diagnostics',execute:()=>scanStalledPmInbox(pool)},
  {label:'Task analyst queue',execute:()=>reconcileTaskAnalysisQueue(pool,temporal)},
  {label:'Agent work queue',execute:()=>reconcileAgentWorkQueue(pool,temporal)},
   {label:'Browser evidence queue',execute:()=>reconcileTaskEvidenceQueue(pool,temporal)},
   {label:'Existing PR QA recovery',execute:()=>reconcileIdlePullRequests(pool,recoverTask,accessToken)},
  {label:'Legacy development process',execute:()=>reconcileLegacyDevelopmentRuns()}
 ],(label,error)=>app.log.error({error},label+' reconciliation failed'));
 const reconcile=()=>{void queueReconciler.run();};
 reconcile();setInterval(reconcile,12000).unref();}
main().catch(e=>{console.error(e);process.exit(1);});

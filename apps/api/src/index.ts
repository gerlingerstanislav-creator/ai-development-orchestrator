import {registerWorkflowSettingsRoutes} from './modules/projects/workflow-api.js';
import {validStages} from './modules/projects/domain/workflow-stages.js';
import {registerAiSettingsRoutes} from './modules/execution/api/ai-settings.js';
import {coreSchemaMigrations} from './database/core-migrations.js';
import {registerDocumentationRoutes} from './modules/documentation/api.js';
import {registerProjectProcessRoutes} from './modules/processes/project-api.js';
import {registerProjectCoreRoutes} from './modules/projects/api.js';
import {workflowStageDescriptions} from './modules/projects/domain/workflow-defaults.js';
import {createLegacyDevelopmentReconciler} from './modules/processes/infrastructure/reconcile-legacy-development.js';
import {registerBackgroundProcessRoutes} from './modules/processes/api.js';
import {registerProjectGitRoutes} from './modules/integrations/github/api.js';
import {registerCodexAdminRoutes} from './modules/codex/api.js';
import {registerAuthRoutes} from './modules/auth/api.js';
import {issueAccessToken} from './modules/auth/application/tokens.js';
import {pauseAllProjectAgents,ensureLegacyAdministrator} from './database/legacy-bootstrap.js';
import {runSchemaMigrations} from './database/schema-migrations.js';
import {initEpicStageSync} from './epic-stage-sync.js';
import {initAnalysisFirstGate} from './analysis-first-gate.js';
import {canManagerCloseTask,planManagerStageMove,type WorkStage} from './task-stage-operations.js';
import {formatQaReportMessage,qaEventDetail} from './qa-report-message.js';
import {initDiagnosticSchema,installDiagnosticHooks,registerDiagnosticRoutes} from './diagnostics.js';
import {initCloudDiagnosticsSchema,registerCloudDiagnosticsSettings,startCloudDiagnosticsSender} from './cloud-diagnostics.js';
import Fastify from 'fastify';
import {createMergeService} from './merge-service.js';
import {createMergeBatch,initMergeBatches,readMergeBatch,recoverMergeBatches} from './merge-batch.js';
import {initAutomaticDeployment,registerAutomaticDeploymentRoutes} from './deployment-automation.js';
import {initQualityGateSchema} from './quality-gates.js';
import { registerAssistantRoutes } from './assistant.js';
import {initChatImages,registerChatImageRoutes} from './chat-images.js';
import {initProjectIterations,registerProjectIterationRoutes} from './project-iterations.js';
import {resolveRoleAiSettings} from './project-team.js';
import {initAgentToolsSchema} from './agent-tools.js';
import {registerAgentToolRoutes} from './agent-tool-routes.js';
import {registerProjectTeamRoutes,initProjectTeamSchema} from './project-team.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import {registerDocumentationResetRoutes} from './documentation-reset.js';
import {registerSafeTaskDeletion} from './task-deletion.js';
import {registerBusinessAnalystHandoff} from './business-analyst-handoff.js';
import {failProjectManagerInbox,initProjectManagerInbox,publishOwnerQuestionsToPmChat,pmInboxWorkflowId,registerProjectManagerInbox} from './project-manager-inbox.js';
import {registerKnowledgeContextRoutes} from './knowledge-context.js';
import {registerKnowledgeWorkflowRoutes} from './knowledge-workflow-routes.js';
import {registerKnowledgeDocumentUpdateRoutes} from './knowledge-document-updates.js';
import { initQaSchema,registerQaRoutes } from './qa.js';
import {initQaWaiverSchema,registerQaWaiverRoutes} from './qa-waiver.js';
import {initRequirementsSchema,saveSpecRevision,updateCurrentSpecification} from './requirements.js';
import {registerTaskAgentNotesRoutes,pendingAgentQuestions} from './task-agent-notes.js';
import {readAgentActivity} from './task-agent-activity.js';
import {initTaskCancellationSchema,registerTaskCancellationRoutes} from './task-cancellation.js';
import {initTaskOrchestrationSchema,acquireTaskOrchestration,releaseTaskOrchestration} from './task-orchestration.js';
import {enqueueDevelopment,reconcileAgentWorkQueue} from './agent-work-scheduler.js';
import {reconcileAgentPeerQueue} from './agent-peer-queue.js';
import {reconcileTaskAnalysisQueue} from './task-analysis-queue.js';
import {acceptAnalysisAnswer,initProjectManagerSchema,isPrEvidenceRequest,registerProjectManagerRoutes,tasksWithCustomerQuestions,type ManagerDeps} from './project-manager.js';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { SignJWT } from 'jose';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
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
function decryptToken(packedText:string){
 const bytes=Buffer.from(packedText,'base64');
 const d=createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(0,12));
 d.setAuthTag(bytes.subarray(12,28));
 return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');
}
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
// One project-scoped source for QA activity in Kanban, task chat and Process Center.
app.get('/api/projects/:id/test-runs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const result=await pool.query(
  "SELECT id,task_id,cycle_id,attempt,status,message,verdict,report - 'screenshots' AS report,qa_plan_snapshot,created_at,completed_at FROM ai_test_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 150",
  [id]);
 return result.rows;
});
// Recovery of a completed QA result when a historical Temporal workflow ended
// between persisting the verdict and advancing the task. Never invent a test pass.
app.post('/api/projects/:id/tasks/:taskId/apply-qa-result',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const task=await pool.query("SELECT t.id,t.stage,t.pr_number,t.spec_version,t.spec_reviewed_version,t.spec_review_status,t.spec_reviewed_commit,g.repository,c.secret_encrypted FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 WHERE t.id=$1 AND t.project_id=$2",
  [taskId,id,uid(req)]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача или GitHub-подключение не найдены'});
 if(task.rows[0].stage!=='testing')return reply.code(409).send({error:'Задача уже вышла из этапа тестирования'});
 if(await pendingAgentQuestions(pool,id,taskId))return reply.code(409).send({error:'Сначала ответь на вопросы агентов по задаче'});
 const [owner,active,latest]=await Promise.all([
  pool.query("SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND project_id=$2 AND state='active'",[taskId,id]),
  pool.query("SELECT 1 FROM ai_test_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('running','queued')",[taskId,id]),
  pool.query('SELECT id,verdict,status,qa_spec_version,report,qa_plan_snapshot FROM ai_test_runs WHERE task_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[taskId,id])
 ]);
 if(owner.rowCount||active.rowCount)return reply.code(409).send({error:'AI-цикл ещё выполняется. Итог будет применён самим процессом.'});
 const test=latest.rows[0], t=task.rows[0];
 if(!test||test.status!=='completed'||!['passed','failed'].includes(test.verdict))
  return reply.code(409).send({error:'Нет завершённого подтверждённого QA-результата. Повтори тестирование или рассмотри непроверенные сценарии.'});
 const findings=Array.isArray(test.report?.findings)?test.report.findings:[];
 const checks=Array.isArray(test.report?.checks)?test.report.checks:[];
 const cases=Array.isArray(test.report?.caseResults)?test.report.caseResults:[];
 const failed=cases.some((c:any)=>c.result==='failed')||checks.some((c:any)=>c.result==='failed')||findings.length>0;
 if(test.verdict==='passed'){
  if(t.spec_review_status!=='current'||t.spec_version!==t.spec_reviewed_version||t.spec_version!==test.qa_spec_version)
   return reply.code(409).send({error:'Результат QA относится к устаревшему ТЗ'});
  const snapshot=Array.isArray(test.qa_plan_snapshot?.cases)?test.qa_plan_snapshot.cases:[];
  const tested=new Map(cases.map((c:any)=>[c.case_id,c]));
  if(!snapshot.length||failed||!checks.length||checks.some((c:any)=>c.result!=='passed')||snapshot.some((c:any)=>!tested.has(c.id)||(tested.get(c.id) as any)?.result!=='passed'))
   return reply.code(409).send({error:'Отчёт не подтверждает успешное прохождение всех обязательных проверок'});
  if(!t.pr_number)return reply.code(409).send({error:'У задачи нет PR для проверки'});
  const gh=await fetch('https://api.github.com/repos/'+t.repository+'/pulls/'+t.pr_number,{
   headers:{Authorization:'Bearer '+decryptToken(t.secret_encrypted),Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(15000)
  });
  if(!gh.ok)return reply.code(502).send({error:'Не удалось сверить текущий PR с QA-результатом: GitHub HTTP '+gh.status});
  const pr=await gh.json() as any;
  if(pr.state!=='open'||pr.head?.sha!==test.report?.commit||pr.head?.sha!==t.spec_reviewed_commit)
   return reply.code(409).send({error:'SHA PR изменился или аналитик проверял другую версию. Нужен повторный QA.'});
 }else if(!failed){
  return reply.code(409).send({error:'Для возврата разработчику нужны воспроизводимые дефекты или проваленные проверки; сбой QA-исполнителя не является дефектом.'});
 }
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const locked=await client.query("SELECT stage,spec_version,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE",[taskId,id]);
  const still=await client.query('SELECT id,status,verdict FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[id,taskId]);
  const running=await client.query("SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND state='active'",[taskId]);
  if(!locked.rowCount||locked.rows[0].stage!=='testing'||locked.rows[0].spec_version!==t.spec_version||locked.rows[0].spec_review_status!==t.spec_review_status||still.rows[0]?.id!==test.id||running.rowCount){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Состояние задачи изменилось. Обнови историю и повтори действие.'});
  }
  const passed=test.verdict==='passed';
  await client.query("UPDATE tasks SET stage=$3,test_feedback=$4,updated_at=now() WHERE id=$1 AND project_id=$2",
   [taskId,id,passed?'merge_queue':'development',passed?'':JSON.stringify(test.report).slice(0,9000)]);
  await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
   [randomUUID(),taskId,uid(req),passed?'tests_passed':'tests_failed',passed?'Результат QA подтверждён: PR готов к слиянию':'Подтверждённые дефекты переданы разработчику. '+String(test.report?.summary||'').slice(0,1500)]);
  await client.query('COMMIT');
  return {ok:true,stage:passed?'merge_queue':'development',message:passed?'Тесты подтверждены, PR ожидает слияния':'Дефекты переданы разработчику'};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/projects/:id/tasks/:taskId/start-testing',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const task=await pool.query('SELECT stage,pr_url,git_branch,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 if(await pendingAgentQuestions(pool,id,taskId))return reply.code(409).send({error:'Сначала ответь на вопросы агентов'});
 if(!['testing','merge_queue'].includes(task.rows[0].stage)||!task.rows[0].pr_url||!task.rows[0].git_branch)
  return reply.code(409).send({error:'Сначала заверши разработку и создай PR'});
 // A stale DB lock must not hide a finished QA run or prevent an explicit retry.
 // Verify actual Temporal state before reconciling ownership. Never start a second
 // worker when the first workflow (or Codex job) is still genuinely running.
 const temporalClient=await temporal();
 const owner=await pool.query("SELECT owner_id,workflow_id,started_at FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[id,taskId]);
 if(owner.rowCount){
  const row=owner.rows[0];
  try{
   const run=await temporalClient.workflow.getHandle(row.workflow_id).describe();
   if(run.status.name==='RUNNING')return reply.code(409).send({error:'Автоматический процесс для задачи всё ещё выполняется. Проверь его в Центре процессов.'});
   await releaseTaskOrchestration(pool,id,taskId,row.owner_id);
  }catch(error){
   const e=error as {code?:number;name?:string;message?:string};
   const notFound=e.code===5||String(e.name||'').includes('NotFound')||String(e.message||'').includes('not found');
   if(!notFound)return reply.code(503).send({error:'Не удалось проверить статус Temporal: '+String(e.message||error).slice(0,250)});
   if(Date.now()-new Date(row.started_at).getTime()<120000)
    return reply.code(409).send({error:'Процесс запускается. Повторный тестировщик не нужен.'});
   await releaseTaskOrchestration(pool,id,taskId,row.owner_id);
  }
 }
 const legacy=await pool.query("SELECT id FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND id=cycle_id ORDER BY created_at DESC LIMIT 15",[id,taskId]);
 for(const old of legacy.rows){
  try{
   const workflow=await temporalClient.workflow.getHandle('task-cycle-'+old.id).describe();
   if(workflow.status.name==='RUNNING')return reply.code(409).send({error:'Автоматический цикл ещё выполняется. Повторное тестирование пока недоступно.'});
  }catch(error){
   const e=error as {code?:number;name?:string;message?:string};
   if(e.code!==5&&!String(e.name||'').includes('NotFound')&&!String(e.message||'').includes('not found'))
    return reply.code(503).send({error:'Не удалось проверить исторический Temporal-процесс: '+String(e.message||error).slice(0,250)});
  }
 }
 const stale=await pool.query("SELECT id,status FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 8",[id,taskId]);
 for(const test of stale.rows){
  let remoteStatus='missing';
  try{
   const response=await fetch(codexUrl+'/jobs/'+test.id,{headers:{'X-Runner-Secret':runnerKey},signal:AbortSignal.timeout(12000)});
   if(response.status===404)remoteStatus='missing';
   else if(!response.ok)return reply.code(503).send({error:'QA-исполнитель недоступен: HTTP '+response.status});
   else remoteStatus=String((await response.json() as any).status||'unknown');
  }catch(error){return reply.code(503).send({error:'Не удалось достоверно проверить старый QA-запуск: '+String(error).slice(0,190)});}
  if(['queued','running','unknown'].includes(remoteStatus))
   return reply.code(409).send({error:'Предыдущий тестировщик ещё работает. Не запускай второго исполнителя.'});
  if(remoteStatus==='completed'){
   // Persist the actual previous QA report before starting a new attempt.
   try{await (await import('./temporal-activities.js')).checkTesting({projectId:id,taskId,testId:test.id});}
   catch(error){return reply.code(503).send({error:'Не удалось восстановить завершённый QA-отчёт: '+String(error).slice(0,220)});}
   continue;
  }
  await pool.query("UPDATE ai_test_runs SET status='failed',message='Предыдущий QA-процесс завершён или потерян. Можно выполнить новый запуск.',completed_at=now() WHERE id=$1 AND status IN ('running','queued')",[test.id]);
  await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',[randomUUID(),taskId,'qa_retry_recovered','Предыдущий QA-процесс отсутствует или завершился с ошибкой. Запуск разблокирован.']);
 }
 const cycleId=randomUUID();
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const locked=(await db.query('SELECT stage,pr_url,git_branch,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id])).rows[0];
  if(!locked||!['testing','merge_queue'].includes(locked.stage)||!locked.pr_url||!locked.git_branch||
   await pendingAgentQuestions(db,id,taskId)){
   await db.query('ROLLBACK');
   return reply.code(409).send({error:'Условия повторной проверки изменились. Обновите карточку задачи.'});
  }
  if(!await acquireTaskOrchestration(db,id,taskId,cycleId,'manual-test-'+cycleId,'testing')){
   await db.query('ROLLBACK');
   return reply.code(409).send({error:'Для задачи уже идёт аналитика, формирование QA-плана или тестирование'});
  }
  if(locked.stage==='merge_queue'){
   await db.query("UPDATE tasks SET stage='testing',updated_at=now() WHERE project_id=$1 AND id=$2",[id,taskId]);
   await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'stage_changed','Повторное тестирование перед слиянием')",
    [randomUUID(),taskId,uid(req)]);
  }
  await db.query('UPDATE projects SET agents_running=true WHERE id=$1',[id]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
 try{
  await temporalClient.workflow.start('manualTesting',{
   taskQueue:'agent-pipeline',workflowId:'manual-test-'+cycleId,
   args:[{projectId:id,taskId,cycleId}]
  });
 }catch(error){
  await releaseTaskOrchestration(pool,id,taskId,cycleId);
  return reply.code(503).send({error:'Temporal недоступен: '+(error as Error).message});
 }
 return reply.code(202).send({cycle_id:cycleId,status:'queued',message:'QA-цикл запущен; повторный запуск заблокирован до завершения'});
});
app.get('/api/projects/:id/ai-runs/:runId',async(req:any,reply)=>{
 const {id,runId}=parse(z.object({id:z.string().uuid(),runId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const run=await pool.query('SELECT id,task_id,model,status,branch,pr_url,message,created_at,completed_at,cycle_id FROM ai_task_runs WHERE id=$1 AND project_id=$2',[runId,id]);
 if(!run.rowCount){
  const intent=(await pool.query(`SELECT q.run_id AS id,q.task_id,q.status,q.created_at,q.detail AS message,
   COALESCE(s.model,'gpt-6-luna') AS model FROM iteration_execution_queue q
   LEFT JOIN project_ai_settings s ON s.project_id=q.project_id WHERE q.project_id=$1 AND q.run_id=$2`,[id,runId])).rows[0];
  if(!intent)return reply.code(404).send({error:'Запуск не найден'});
  return {...intent,status:intent.status==='stale'?'failed':intent.status==='dispatched'?'completed':intent.status,
   message:intent.message||'Ожидает диспетчера разработки'};
 }
 const current=run.rows[0];
 if(current.cycle_id)return current; // Temporal worker is the single owner of lifecycle transitions.
 if(current.status==='running'||current.status==='queued'){
  try{
   const remote=await agentCall('/jobs/'+runId);
   const phase=String(remote.message||'').slice(0,1600);
   if(remote.branch&&remote.branch!==current.branch){
    await pool.query('UPDATE ai_task_runs SET branch=$2 WHERE id=$1',[runId,remote.branch]);
    await pool.query('UPDATE tasks SET git_branch=$2 WHERE id=$1 AND project_id=$3',[current.task_id,remote.branch,id]);
   }
   if(remote.status!==current.status)await pool.query('UPDATE ai_task_runs SET status=$2 WHERE id=$1',[runId,remote.status]);
   if(phase && phase!==current.message){
    await pool.query('UPDATE ai_task_runs SET message=$2 WHERE id=$1',[runId,phase]);
    await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,level,stage,detail) VALUES($1,$2,$3,'development',$4,$5,$6)",
     [randomUUID(),id,runId,remote.status==='failed'?'error':'info',remote.status||'running',phase]).catch(()=>{});
    await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),current.task_id,uid(req),remote.status==='failed'?'ai_failed':remote.status==='completed'?'ai_completed':'ai_progress',phase]);
   }
   if(['completed','failed'].includes(remote.status)){
    if(remote.usage){
     const u=remote.usage;
     await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,'development',$5,$6,$7,$8) ON CONFLICT(source_id) DO NOTHING",
      [randomUUID(),id,current.task_id,runId,current.model,Math.max(0,Number(u.input_tokens)||0),Math.max(0,Number(u.cached_input_tokens)||0),Math.max(0,Number(u.output_tokens)||0)]);
    }
    await pool.query('UPDATE ai_task_runs SET status=$2,branch=$3,pr_url=$4,message=$5,completed_at=now() WHERE id=$1',
     [runId,remote.status,remote.branch||null,remote.prUrl||null,String(remote.message||'').slice(0,2000)]);
    if(remote.status==='completed'&&remote.prUrl){
     const prMatch=/\/pull\/(\d+)$/.exec(remote.prUrl);
     await pool.query("UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$6,updated_at=now() WHERE id=$1 AND project_id=$5",[current.task_id,remote.branch,remote.prUrl,prMatch?Number(prMatch[1]):null,id,remote.baseBranch||null]);
    }
    return {...current,status:remote.status,branch:remote.branch,pr_url:remote.prUrl,message:remote.message};
   }
   return {...current,status:remote.status,branch:remote.branch||current.branch,message:phase,started_at:remote.startedAt||null};
  }catch(e){
   const problem=e instanceof Error?e.message:'ошибка';
   if(problem.includes('Задача не найдена (возможно, исполнитель перезапущен)')){
    await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,'Исполнитель перезапустился; повтори запуск задачи']);
    return {...current,status:'failed',message:'Исполнитель перезапустился; повтори запуск задачи'};
   }
   return {...current,message:'Нет связи с исполнителем: '+problem};
  }
 }
 return current;
});



const {mergeTaskPr}=createMergeService(pool,decryptToken);
app.post('/api/projects/:id/tasks/:taskId/merge',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 try{return await mergeTaskPr(id,taskId,uid(req));}
 catch(e){const err=e as Error&{statusCode?:number};return reply.code(err.statusCode||502).send({error:err.message});}
});

registerBackgroundProcessRoutes(app,pool,uid);

async function startMergeBatch(batchId:string){
 const client=await temporal();
 await client.withDeadline(Date.now()+5000,()=>client.workflow.start('mergeReadyBatch',{
  workflowId:'merge-ready-'+batchId,workflowIdReusePolicy:'REJECT_DUPLICATE',taskQueue:'agent-pipeline',args:[batchId]
 }));
}
app.post('/api/projects/:id/merge-ready',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const batch=await createMergeBatch(pool,id,uid(req));
 return reply.code(202).send(batch);
});
app.get('/api/projects/:id/merge-ready/:batchId',async(req:any,reply)=>{
 const {id,batchId}=parse(z.object({id:z.string().uuid(),batchId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const batch=await readMergeBatch(pool,id,batchId);
 return batch??reply.code(404).send({error:'Очередь слияния не найдена'});
});

registerProjectCoreRoutes(app,{pool,uid,access,requireAdmin});
registerWorkflowSettingsRoutes(app,{pool,uid,access,requireAdmin});
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
registerProjectProcessRoutes(app,{pool,uid,access,requireAdmin,temporal});
registerDocumentationRoutes(app,{pool,access,requireAdmin});
app.get('/api/connections',async(req)=>{return (await pool.query('SELECT id,name,provider,created_at FROM connections WHERE owner_id=$1 ORDER BY created_at DESC',[uid(req)])).rows;});
app.post('/api/connections',async(req,reply)=>{
 const {name,provider,secret}=parse(z.object({name:z.string().min(1).max(100),provider:z.enum(['openai_api','github_token']),secret:z.string().min(8).max(2000)}),req.body);
 const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
 const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);const packed=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
 const id=randomUUID();await pool.query('INSERT INTO connections(id,owner_id,name,provider,secret_encrypted) VALUES($1,$2,$3,$4,$5)',[id,uid(req),name,provider,packed]);return reply.code(201).send({id,name,provider});
});
app.get('/api/projects/:id/connections',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT c.id,c.name,c.provider FROM connections c JOIN project_connections pc ON pc.connection_id=c.id WHERE pc.project_id=$1 AND c.owner_id=$2',[id,uid(req)])).rows;});
app.post('/api/projects/:id/connections',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const {connectionId}=parse(z.object({connectionId:z.string().uuid()}),req.body);const r=await pool.query('INSERT INTO project_connections(project_id,connection_id) SELECT $1,id FROM connections WHERE id=$2 AND owner_id=$3 ON CONFLICT DO NOTHING RETURNING connection_id',[id,connectionId,uid(req)]);if(!r.rowCount)return reply.code(400).send({error:'Подключение не найдено или уже добавлено'});return {ok:true};});
async function startIterationPlanning(runId:string){
 try{
  const client=await temporal();
  await client.workflow.start('prepareIterationPlan',{taskQueue:'agent-pipeline',workflowId:'iteration-plan-'+runId,
   workflowIdReusePolicy:'REJECT_DUPLICATE',args:[runId]});
 }catch(error){if((error as Error)?.name!=='WorkflowExecutionAlreadyStartedError')throw error;}
}
registerAgentToolRoutes(app,{pool,access,requireAdmin,runnerSecret:runnerKey,startIterationPlanning,startDocumentationWorkflow:async jobId=>{
 const client=await temporal();
 await client.workflow.start('prepareProjectSpecification',{taskQueue:'agent-pipeline',workflowId:'analyst-'+jobId,args:[jobId]});
},delegateManagerAction:async(session,name,args)=>{
 const projectId=session.project_id;
 if(session.role!=='manager')throw Object.assign(Error('Действие только для ПМ'),{statusCode:403});
 const user=(await pool.query('SELECT email FROM users WHERE id=$1',[session.actor_id])).rows[0];
 if(!user)throw Object.assign(Error('Пользователь не найден'),{statusCode:403});
 const id=z.string().uuid();
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
   const owner=await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[projectId,session.actor_id]);
   const source=await pool.query(`
    SELECT body,task_id FROM manager_messages WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user'
    UNION ALL
    SELECT body,task_id FROM assistant_messages WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND role='user'
   `,[sourceMessageId,projectId,session.actor_id]);
   if(!owner.rowCount||source.rows.length!==1)throw Object.assign(Error('Для удаления требуется реальное поручение владельца проекта'),{statusCode:403});
   if(source.rows[0].task_id&&source.rows[0].task_id!==taskId)
    throw Object.assign(Error('Нельзя удалять другую задачу по сообщению из этой карточки'),{statusCode:403});
   const text=String(source.rows[0].body||'').trim();
   if(!/(?:удал(?:и|ить|ите|яй)|delete|remove)/i.test(text)||/(?:не|нельзя|запрещено)\s+удал/i.test(text))
    throw Object.assign(Error('В сообщении владельца нет явного поручения удалить задачу'),{statusCode:409});
   const token=await accessToken(session.actor_id,user.email);
   const response=await app.inject({method:'DELETE',url:'/api/projects/'+projectId+'/tasks/'+taskId,
    headers:{authorization:'Bearer '+token},payload:{confirm_task_id:taskId}});
   const body=response.json() as {error?:string;ok?:boolean;display_number?:number};
   if(response.statusCode>=400)throw Object.assign(Error(String(body.error||'Не удалось удалить задачу')),{statusCode:response.statusCode});
   return {...body,status:'deleted',task_id:taskId};
  }
  if(name==='tasks.cancel'||name==='tasks.close'||name==='workflow.move_task'){
   const taskId=id.parse(args.task_id),sourceMessageId=id.parse(args.source_message_id);
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
    const body=String(message.rows[0].body||'');
    if(!/(?:закр(?:ой|ыть|ойте)|заверш(?:и|ить|ите)|отметь[^\n]{0,70}(?:готов|выполн)|пометь[^\n]{0,70}(?:готов|выполн)|mark[^\n]{0,70}done|close[^\n]{0,70}task)/i.test(body))
     return {status:'blocked',reason:'В исходном сообщении владельца нет поручения завершить задачу'};
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
    if(!/(?:отмен|удал|cancel|remove)/i.test(String(message.rows[0].body||''))||/(?:не|не надо|не нужно)\s+(?:отмен|удал|cancel|remove)/i.test(String(message.rows[0].body||'')))
     throw Object.assign(Error('В исходном сообщении нет явного поручения закрыть/отменить задачу'),{statusCode:409});
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
   if(move.operation==='approve_development'){
    if(row.analysis_state!=='ready_for_development')
     return {status:'blocked',stage:row.stage,
      reason:'Аналитик ещё не подтвердил готовность требований. Готовая постановка автоматически перейдёт в разработку после анализа; технические консультации не блокируют передачу.'};
    return await call('POST','/run-ai',{approveAnalysis:true});
   }
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
 encrypt:(secret:string)=>{const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
  const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');},
 start:async runId=>{
 const client=await temporal();
 await client.workflow.start('automaticDeployment',{taskQueue:'agent-pipeline',workflowId:'deployment-'+runId,
  workflowIdReusePolicy:'REJECT_DUPLICATE',args:[runId]});
}});
app.get('/api/projects/:id/tasks/:taskId/quality-gates',async(req:any,reply)=>{
 const {id,taskId}=z.object({id:z.string().uuid(),taskId:z.string().uuid()}).parse(req.params);
 if(!await access(req,reply,id))return;
 return {runs:(await pool.query("SELECT id,kind,head_sha,base_sha,status,verdict,report,message,started_at,completed_at FROM quality_gate_runs WHERE project_id=$1 AND task_id=$2 ORDER BY started_at DESC LIMIT 30",[id,taskId])).rows};
});
app.post('/api/projects/:id/tasks/:taskId/quality-gates',async(req:any,reply)=>{
 const {id,taskId}=z.object({id:z.string().uuid(),taskId:z.string().uuid()}).parse(req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const task=await pool.query("SELECT id FROM tasks WHERE project_id=$1 AND id=$2 AND stage IN ('testing','merge_queue') AND pr_number IS NOT NULL",[id,taskId]);
 if(!task.rowCount)return reply.code(409).send({error:'Требуется открытый PR на стадии тестирования или слияния'});
 const client=await temporal();
 const runId=randomUUID();
 await client.workflow.start('manualQualityGates',{taskQueue:'agent-pipeline',workflowId:'quality-gates-'+runId,args:[{projectId:id,taskId,runId}]});
 return reply.code(202).send({run_id:runId,status:'queued'});
});
registerBusinessAnalystHandoff(app,{pool,uid,access});
registerProjectTeamRoutes(app,{pool,access,requireAdmin,uid});
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
 await pauseAllProjectAgents(pool);
 await ensureLegacyAdministrator(pool,configuredAdminEmail());
await initEpicStageSync(pool);await initDiagnosticSchema(pool);await initCloudDiagnosticsSchema(pool);await initAutomaticDeployment(pool);await initQualityGateSchema(pool);await initProjectIterations(pool);await initAgentToolsSchema(pool);await initProjectTeamSchema(pool);await initQaSchema(pool);await initRequirementsSchema(pool);await initQaWaiverSchema(pool);await initTaskOrchestrationSchema(pool);await initAnalysisFirstGate(pool);await initTaskCancellationSchema(pool);await initProjectManagerSchema(pool);await initChatImages(pool);await initProjectManagerInbox(pool);await initMergeBatches(pool);await app.listen({port:Number(process.env.PORT||3001),host:'0.0.0.0'});
  startCloudDiagnosticsSender(pool,{url:process.env.SUPABASE_DIAGNOSTICS_URL||'',apiKey:process.env.SUPABASE_DIAGNOSTICS_API_KEY||'',logger:message=>app.log.warn(message)});
 const reconcileLegacyDevelopmentRuns=createLegacyDevelopmentReconciler(
  pool,path=>agentCall(path),
  (error,runId)=>app.log.warn({error,runId},'Legacy development reconciliation failed')
 );
 const reconcile=()=>void (async()=>{
  try{await reconcileAgentPeerQueue(pool,temporal);}catch(error){app.log.error({error},'Agent peer queue reconciliation failed');}
  try{await recoverMergeBatches(pool,startMergeBatch);}catch(error){app.log.error({error},'Merge queue reconciliation failed');}
  try{await publishOwnerQuestionsToPmChat(pool);}catch(error){app.log.error({error},'PM owner questions reconciliation failed');}
  try{await reconcileTaskAnalysisQueue(pool,temporal);}catch(error){app.log.error({error},'Task analyst queue reconciliation failed');}
  try{await reconcileAgentWorkQueue(pool,temporal);}catch(error){app.log.error({error},'Agent work queue reconciliation failed');}
  try{await reconcileLegacyDevelopmentRuns();}catch(error){app.log.error({error},'Legacy development process reconciliation failed');}
 })();
 reconcile();setInterval(reconcile,12000).unref();}
main().catch(e=>{console.error(e);process.exit(1);});

import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import type {Client} from '@temporalio/client';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pendingAgentQuestions} from '../../task-agent-notes.js';
import {acquireTaskOrchestration,releaseTaskOrchestration} from '../../task-orchestration.js';

type Deps={
 pool:Pool;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 temporal:()=>Promise<Client>;
 runnerUrl:string;
 runnerSecret:string;
 decryptToken:(encrypted:string)=>string;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/** Manual QA operations and evidence-aware recovery.
 *
 * The Temporal QA executor and the pure quality verdict domain remain separate.
 * This layer only handles project-scoped HTTP authorization and transitions.
 */
export function registerQualityOperationsRoutes(
 app:FastifyInstance,{pool,uid,access,requireAdmin,temporal,
 runnerUrl:codexUrl,runnerSecret:runnerKey,decryptToken}:Deps
){
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
 const task=await pool.query("SELECT t.id,t.stage,t.execution_mode,t.pr_number,t.spec_version,t.spec_reviewed_version,t.spec_review_status,t.spec_reviewed_commit,g.repository,c.secret_encrypted FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 WHERE t.id=$1 AND t.project_id=$2",
  [taskId,id,uid(req)]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача или GitHub-подключение не найдены'});
 if(task.rows[0].stage!=='testing')return reply.code(409).send({error:'Задача уже вышла из этапа тестирования'});
 if(task.rows[0].execution_mode==='browser_evidence')return reply.code(409).send({error:'Для задач без изменений кода применяется отдельное подтверждение скриншотов; переход в разработку или к PR запрещён'});
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
   try{await (await import('../../temporal-activities.js')).checkTesting({projectId:id,taskId,testId:test.id});}
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
}

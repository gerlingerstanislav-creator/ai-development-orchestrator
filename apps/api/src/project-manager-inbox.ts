import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createAgentSession,finishAgentSession,agentSessionEffects} from './agent-tools.js';
import {agentLearnedContext} from './agent-tools.js';
import {conversationInstructions,resolveRoleAiSettings} from './project-team.js';

type RouteDeps={
 pool:Pool;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 start:(projectId:string,messageId:string)=>Promise<void>;
};

export function registerProjectManagerInbox(app:FastifyInstance,deps:RouteDeps){
 const {pool,uid,access,requireAdmin,start}=deps;
 app.post('/api/projects/:id/manager/inbox',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message,replyTo,topicId}=z.object({
   message:z.string().trim().min(1).max(4000),
   replyTo:z.string().uuid().nullable().optional(),
   topicId:z.string().uuid().nullable().optional()
  }).parse(req.body);
  if(replyTo){
   const target=await pool.query("SELECT 1 FROM assistant_messages WHERE id=$1 AND project_id=$2 AND task_id IS NULL AND channel='project'",[replyTo,id]);
   if(!target.rowCount)return reply.code(400).send({error:'Сообщение, на которое вы отвечаете, не найдено'});
  }
  if(topicId){
   const topic=await pool.query("SELECT 1 FROM project_chat_topics WHERE id=$1 AND project_id=$2 AND status='open'",[topicId,id]);
   if(!topic.rowCount)return reply.code(409).send({error:'Тема закрыта или отсутствует'});
  }
  const messageId=randomUUID();

  const client=await pool.connect();
  let orderId:string='';

  try{
   await client.query('BEGIN');

   // A reply within a topic resumes the waiting order rather than opening
   // an unrelated order and losing its decision context.
   const parent=replyTo?(await client.query("SELECT pm_order_id FROM assistant_messages WHERE id=$1 AND project_id=$2",[replyTo,id])).rows[0]?.pm_order_id:null;
   const waiting=topicId?(await client.query("SELECT id FROM project_pm_orders WHERE project_id=$1 AND topic_id=$2 AND status='waiting_user' ORDER BY updated_at DESC LIMIT 1",[id,topicId])).rows[0]?.id:null;
   const existing=parent?(await client.query("SELECT id FROM project_pm_orders WHERE id=$1 AND project_id=$2 AND status='waiting_user'",[parent,id])).rows[0]?.id:null;
   orderId=existing||waiting||randomUUID();
   // Insert the order before the message: assistant_messages.pm_order_id has an immediate FK.
   // source_message_id is linked after the message exists, avoiding a circular FK violation.
   if(existing||waiting)
    await client.query("UPDATE project_pm_orders SET status='queued',updated_at=now() WHERE id=$1",[orderId]);
   else
    await client.query("INSERT INTO project_pm_orders(id,project_id,actor_id,source_message_id,topic_id,summary) VALUES($1,$2,$3,NULL,$4,$5)",
     [orderId,id,uid(req),topicId||null,message.slice(0,500)]);
   await client.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status,reply_to,topic_id,pm_order_id) VALUES($1,$2,$3,'user',$4,'project','queued',$5,$6,$7)",
    [messageId,id,uid(req),message,replyTo||null,topicId||null,orderId]);
   if(!existing&&!waiting)
    await client.query("UPDATE project_pm_orders SET source_message_id=$2 WHERE id=$1",[orderId,messageId]);
   await client.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,$3,$4)",
    [randomUUID(),orderId,existing||waiting?'owner_reply':'created',existing||waiting?'Владелец ответил на вопрос ПМ':'Поручение принято от владельца']);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  try{await start(id,messageId);}
  catch(e){
   await pool.query("UPDATE assistant_messages SET status='failed' WHERE id=$1",[messageId]);
   await pool.query("UPDATE project_pm_orders SET status='failed',updated_at=now() WHERE id=$1",[orderId]);
   return reply.code(503).send({error:'Сообщение сохранено, но не удалось поставить его в очередь Temporal',message_id:messageId});
  }
  return reply.code(202).send({id:messageId,status:'queued'});
 });
 app.post('/api/projects/:id/manager/inbox/:messageId/retry',async(req:any,reply)=>{
  const {id,messageId}=z.object({id:z.string().uuid(),messageId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const changed=await pool.query("UPDATE assistant_messages SET status='queued' WHERE project_id=$1 AND id=$2 AND channel='project' AND role='user' AND status='failed' RETURNING id",[id,messageId]);
  if(!changed.rowCount)return reply.code(409).send({error:'Повторить можно только сообщение с ошибкой'});
  await pool.query("UPDATE project_pm_orders SET status='queued',updated_at=now() WHERE id=(SELECT pm_order_id FROM assistant_messages WHERE id=$1)",[messageId]);
  await start(id,messageId).catch(error=>req.log.warn({error,messageId},'PM retry will be recovered'));
  return reply.code(202).send({id:messageId,status:'queued'});
 });
 // Crash recovery: persisted turns must not depend on the browser or a single
 // successful dispatch attempt. Temporal workflow IDs are deterministic.
 let timer:ReturnType<typeof setInterval>|null=null,recovering=false;
 const recover=async()=>{
  if(recovering)return;recovering=true;
  try{
   const rows=await pool.query("SELECT id,project_id FROM assistant_messages WHERE channel IN ('project','pm-internal') AND role='user' AND status='queued' AND created_at>now()-interval '30 days' ORDER BY created_at LIMIT 15");
   for(const row of rows.rows){
    try{await start(row.project_id,row.id);}
    catch(error){
     if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error)?.name))
      app.log.warn({error,messageId:row.id},'Could not dispatch queued PM message');
    }
   }
  }finally{recovering=false;}
 };
 app.addHook('onReady',async()=>{
  await recover().catch(error=>app.log.error({error},'PM inbox recovery failed'));
  timer=setInterval(()=>void recover().catch(error=>app.log.error({error},'PM inbox recovery failed')),20000);
  timer.unref?.();
 });
 app.addHook('onClose',async()=>{if(timer)clearInterval(timer);});
}

export type ProjectManagerWatch={projectId:string;processId:string;kind:'iteration_plan'|'document_import'|'development';orderId?:string;topicId?:string|null;actorId?:string};
export async function executeProjectManagerInbox(pool:Pool,projectId:string,messageId:string,runnerUrl:string,runnerKey:string):Promise<ProjectManagerWatch[]>{
 const claim=await pool.query("UPDATE assistant_messages SET status='processing' WHERE id=$1 AND project_id=$2 AND channel IN ('project','pm-internal') AND role='user' AND status IN ('queued','processing') RETURNING id,actor_id,body,reply_to,topic_id,pm_order_id,channel",[messageId,projectId]);
 if(!claim.rowCount)return [];
 const turn=claim.rows[0];
 const orderId:string|null=turn.pm_order_id??null;
 if(orderId)await pool.query("UPDATE project_pm_orders SET status='working',updated_at=now() WHERE id=$1",[orderId]);
 let sessionId:string|null=null;
 let watchers:ProjectManagerWatch[]=[];
 try{
  const [configResult,projectResult,contextResult,tasksResult,questionsResult,historyResult,replyResult,topicResult]=await Promise.all([
   pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]),
   pool.query('SELECT name,description FROM projects WHERE id=$1',[projectId]),
   pool.query('SELECT stage,label,agent_name,mode FROM workflow_stages WHERE project_id=$1 ORDER BY position',[projectId]),
   pool.query("SELECT id,title,stage,analysis_state,spec_review_status FROM tasks WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 45",[projectId]),
   pool.query("SELECT id,task_id,author_stage,body,status FROM task_agent_notes WHERE project_id=$1 AND kind='question' AND status='open' ORDER BY created_at DESC LIMIT 35",[projectId]),
   pool.query("SELECT role,body FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL AND channel='project' AND id<>$2 AND status='completed' ORDER BY created_at DESC LIMIT 16",[projectId,messageId]),
   turn.reply_to?pool.query("SELECT role,body FROM assistant_messages WHERE project_id=$1 AND id=$2",[projectId,turn.reply_to]):Promise.resolve({rows:[]}),
   turn.topic_id?pool.query('SELECT title,status FROM project_chat_topics WHERE project_id=$1 AND id=$2',[projectId,turn.topic_id]):Promise.resolve({rows:[]})
  ]);
  const config=await resolveRoleAiSettings(pool,projectId,'manager',configResult.rows[0]);
  if(!config?.enabled)throw Error('AI выключен в настройках проекта');
  const session=await createAgentSession(pool,projectId,turn.actor_id,'manager');
  sessionId=session.id;
  const [instructions,learned]=await Promise.all([
   conversationInstructions(pool,projectId,'manager'),agentLearnedContext(pool,projectId,'manager')
  ]);
  const [orders,orderEvents,decisions]=await Promise.all([
   pool.query("SELECT id,summary,status,topic_id FROM project_pm_orders WHERE project_id=$1 AND status NOT IN ('completed','failed') ORDER BY updated_at DESC LIMIT 15",[projectId]),
   orderId?pool.query('SELECT kind,detail,created_at FROM project_pm_order_events WHERE order_id=$1 ORDER BY created_at DESC LIMIT 25',[orderId]):Promise.resolve({rows:[]}),
   pool.query("SELECT i.title,d.question,d.answer,d.created_at FROM iteration_owner_decisions d JOIN project_iterations i ON i.id=d.iteration_id WHERE i.project_id=$1 ORDER BY d.created_at DESC LIMIT 35",[projectId])
  ]);
  const prompt=[
   'Ты ПМ проекта AI Development Orchestrator. Ты единственная точка взаимодействия владельца с агентами.',
   'Текущее поручение: '+String(orderId||'не задано')+'. Сохраняй связь с ним при уточнениях и продолжении после событий. Не считай поручение выполненным, пока работа не проверена.',
   'При завершении процесса ты будешь вызван повторно системой. Продолжай исходное поручение, а не просто пересказывай событие. Используй инструменты iterations.preview_plan, iterations.publish_plan и workflow.approve_development в рамках согласований.',
   'При необходимости задавай вопрос в отдельной теме через discussions.open и помечай поручение как waiting_user через pm.orders.update. Пока ответ не получен, не считай его закрытым.',
   'Когда пользователь уже дал ответ, используй сохранённые решения вместо повторного вопроса. Зафиксируй новое решение через pm.decisions.record с ID сообщения пользователя, если оно влияет на требования/итерацию.',
   'Твоя работа: оперативно распределять поручения через инструменты, отслеживать статусы, собирать результаты, не подменять собой разработчика, БА, СА, QA или DevOps.',
   'Обрабатывай этот запрос независимо от других сообщений. Не ожидай окончания других процессов и не запускай работу агента у себя синхронно.',
   'У тебя есть MCP orchestrator. Реальные операции выполняй только через доступные инструменты. Не заявляй о создании задач или запуске процессов, если инструмент этого не подтвердил.',
   'Согласования этапов: покажи владельцу конкретную задачу, текущий и следующий этап, критерии, риски и ссылку на нужный экран/процесс. Не обходи обязательные проверки. Если доступный инструмент не поддерживает подтверждение, сообщи об этом и предложи конкретное действие в интерфейсе, но не выдавай согласование за выполненное.',
   'Вопросы агентов: прежде чем спрашивать владельца, прочитай задачи и принятые решения. Владелец может отвечать на вопросы других агентов через ПМ. Не выдумывай ответы на нерешённые вопросы.',
   'Обсуждения: соблюдай тему и контекст сообщения, на которое пользователь отвечает. При закрытии вопроса рекомендуй завершить тему. Не закрывай сам без доступного инструмента.',
   'Инструкции ПМ: '+instructions.slice(0,4400),
   'Накопленные знания: '+learned.slice(0,3200),
   'Проект: '+JSON.stringify(projectResult.rows[0]||{}).slice(0,1500),
   'Workflow: '+JSON.stringify(contextResult.rows).slice(0,3500),
   'Задачи: '+JSON.stringify(tasksResult.rows).slice(0,6500),
   'Вопросы от агентов: '+JSON.stringify(questionsResult.rows).slice(0,4800),
   'Тема: '+JSON.stringify(topicResult.rows[0]||null),
   'Активные поручения: '+JSON.stringify(orders.rows).slice(0,3300),
   'Контрольные точки поручения: '+JSON.stringify(orderEvents.rows).slice(0,4500),
   'Подтверждённые решения владельца: '+JSON.stringify(decisions.rows).slice(0,5500),
   'Реестр принятых решений проекта: '+JSON.stringify((await pool.query('SELECT question,answer,iteration_id FROM project_pm_decisions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 40',[projectId])).rows).slice(0,6000),
   'ID текущего сообщения владельца: '+String(turn.channel==='project'?messageId:'внутреннее системное событие'),
   'Ответ на сообщение: '+JSON.stringify(replyResult.rows[0]||null).slice(0,2500),
   'Недавняя история: '+JSON.stringify(historyResult.rows.reverse()).slice(0,5500),
   'НОВОЕ СООБЩЕНИЕ ВЛАДЕЛЬЦА: '+String(turn.body)
  ].join('\n\n').slice(0,22500);
  const response=await fetch(runnerUrl+'/agent',{
   method:'POST',headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt,session_token:session.secret,agent_role:'manager',project_id:projectId}),
   signal:AbortSignal.timeout(255000)
  });
  const data=await response.json().catch(()=>({})) as any;
  if(!response.ok||typeof data.message!=='string'||!data.message.trim())throw Error(String(data.error||'ПМ не вернул ответ').slice(0,700));
  const effects=await agentSessionEffects(pool,session.id);
  const toolEvents=await pool.query("SELECT tool,result FROM agent_tool_events WHERE project_id=$1 AND session_id=$2 AND success=true AND tool IN ('iterations.prepare_plan','documentation.import','documentation.rebuild','documentation.organize','workflow.approve_development','discussions.open','iterations.ask_question','pm.orders.update','pm.decisions.record')",[projectId,session.id]);
  const seen=new Set<string>();
  const effectiveTopicForWatch=turn.topic_id||toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string')||null;
  watchers=toolEvents.rows.flatMap(row=>{
   const kind:ProjectManagerWatch['kind']=['iterations.prepare_plan','pm.decisions.record'].includes(row.tool)?'iteration_plan':row.tool==='workflow.approve_development'?'development':'document_import';
   const id=kind==='iteration_plan'?row.result?.planning_run_id:kind==='development'?row.result?.id:row.result?.import_job_id;
   if(typeof id!=='string'||seen.has(id))return [];
   seen.add(id);
   return [{projectId,processId:id,kind,orderId:orderId||undefined,topicId:effectiveTopicForWatch,actorId:turn.actor_id}];
  });
  const openedTopic=toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string');
  const effectiveTopic=turn.topic_id||openedTopic||null;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const finished=await client.query("UPDATE assistant_messages SET status='completed' WHERE id=$1 AND status='processing' RETURNING id",[messageId]);
   if(finished.rowCount){
    if(effectiveTopic)await client.query("UPDATE assistant_messages SET topic_id=$2 WHERE id=$1",[messageId,effectiveTopic]);
    await client.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id,pm_order_id,created_task_id,created_document_id,documentation_reset_requested,owner_question_cleanup_requested) VALUES($1,$2,'assistant',$3,'project','completed',$4,$5,$6,$7,$8,$9)",
     [randomUUID(),projectId,data.message,effectiveTopic,orderId,effects.created_task_id,effects.created_document_id,effects.documentation_reset_requested||false,effects.owner_question_cleanup_requested||false]);
   }
   if(orderId){
    const hasOpenQuestion=toolEvents.rows.some(row=>row.tool==='iterations.ask_question');
    const explicitlySet=toolEvents.rows.some(row=>row.tool==='pm.orders.update'&&row.result?.id===orderId);
    const status=watchers.length?'waiting_agents':hasOpenQuestion?'waiting_user':'completed';
    if(!explicitlySet||watchers.length)await client.query('UPDATE project_pm_orders SET status=$2,topic_id=COALESCE($3,topic_id),updated_at=now() WHERE id=$1',[orderId,status,effectiveTopic]);
    else await client.query('UPDATE project_pm_orders SET topic_id=COALESCE($2,topic_id),updated_at=now() WHERE id=$1',[orderId,effectiveTopic]);
    await client.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,'pm_step',$3)",[randomUUID(),orderId,'ПМ завершил шаг; статус '+status]);
   }
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }catch(error){
  const message=String(error instanceof Error?error.message:error);
  const retryable=/busy|concurren|перегруз|несколько AI|лимит одноврем|429|503|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|AbortError/i.test(message);
  await pool.query("UPDATE assistant_messages SET status=$2 WHERE id=$1 AND status='processing'",[messageId,retryable?'queued':'failed']);
  if(orderId)await pool.query("UPDATE project_pm_orders SET status=$2,updated_at=now() WHERE id=$1",[orderId,retryable?'queued':'failed']).catch(()=>{});
  if(!retryable)throw Object.assign(new Error(message.slice(0,650)),{nonRetryable:true});
  throw error;
 }finally{
  if(sessionId)await finishAgentSession(pool,sessionId).catch(()=>{});
 }
 return watchers;
}

/** Polling is a short database activity; the waiting happens in Temporal,
 * not in the PM AI session or an HTTP request. */
export async function checkProjectManagerWatch(pool:Pool,watch:ProjectManagerWatch):Promise<'pending'|'completed'>{
 const where=watch.kind==='iteration_plan'?'r.id=$1 AND i.project_id=$2':'r.id=$1 AND r.project_id=$2';
 const sql=watch.kind==='iteration_plan'
  ? "SELECT r.id,r.status,r.message,r.plan_id,i.title AS name,i.id AS iteration_id FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id WHERE "+where
  :watch.kind==='development'
  ? "SELECT r.id,r.status,r.message,r.pr_url,t.title AS name FROM ai_task_runs r JOIN tasks t ON t.id=r.task_id AND t.project_id=r.project_id WHERE "+where
  : "SELECT r.id,r.status,r.message,r.saved_documents,r.result FROM document_import_jobs r WHERE "+where;
 const result=await pool.query(sql,[watch.processId,watch.projectId]);
 let process=result.rows[0];
 if(!process)return 'completed';
 if(watch.kind==='iteration_plan'&&process.status==='completed'&&!process.plan_id){
  // An owner answer arrived during generation; planning transparently
  // continued in a newer run. Wait for that final draft instead.
  const next=await pool.query("SELECT r.id,r.status,r.message,r.plan_id,i.title AS name,i.id AS iteration_id FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id WHERE i.project_id=$1 AND i.id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 1",[watch.projectId,process.iteration_id]);
  if(next.rows[0]?.id!==process.id)process=next.rows[0];
 }
 if(process.status==='queued'||process.status==='running')return 'pending';
 const client=await pool.connect();
 try{
 await client.query('BEGIN');
 const mark=await client.query("INSERT INTO project_pm_process_reports(project_id,process_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING process_id",
  [watch.projectId,watch.processId,watch.kind]);
 if(!mark.rowCount){await client.query('ROLLBACK');return 'completed';}
 const title=watch.kind==='iteration_plan'?'Подготовка задач итерации «'+process.name+'»':watch.kind==='development'?'Разработка задачи «'+process.name+'»':'Работа с документацией';
 const message=process.status==='completed'
  ?watch.kind==='iteration_plan'
   ?title+' завершена. Актуальный план доступен на вкладке «План разработки». ID плана: '+String(process.plan_id||'не указан')+'. Перед публикацией необходимо проверить состав задач.'
   :watch.kind==='development'
   ?title+' завершена. '+String(process.message||'')+(process.pr_url?' PR: '+process.pr_url:'')
   :title+' завершена. '+String(process.message||'Документация обновлена')
  :title+' завершилась со статусом «'+process.status+'». '+String(process.message||'Посмотри детали в Центре процессов');
 await client.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id,pm_order_id) VALUES($1,$2,'assistant',$3,'project','completed',$4,$5)",
  [randomUUID(),watch.projectId,message.slice(0,3500),watch.topicId||null,watch.orderId||null]);
 if(watch.orderId&&watch.actorId){
  const resumeMessageId=randomUUID();
  await client.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status,topic_id,pm_order_id) VALUES($1,$2,$3,'user',$4,'pm-internal','queued',$5,$6)",
   [resumeMessageId,watch.projectId,watch.actorId,'СИСТЕМНОЕ СОБЫТИЕ: '+message+' Продолжи исходное поручение, проверь результат, примени допустимые дальнейшие действия или запроси решение владельца.',watch.topicId||null,watch.orderId]);
  await client.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail,process_id) VALUES($1,$2,'resume',$3,$4)",
   [randomUUID(),watch.orderId,resumeMessageId,watch.processId]);
  await client.query("UPDATE project_pm_orders SET status='queued',updated_at=now() WHERE id=$1",[watch.orderId]);
 }
 await client.query('COMMIT');
 return 'completed';
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
}

/** Resume reference is persisted transactionally with the completion report.
 * Temporal can retry safely without enqueuing a duplicate PM turn. */
export async function readProjectManagerWatchResume(pool:Pool,watch:ProjectManagerWatch):Promise<{status:'pending'|'completed';messageId?:string}>{
 const status=await checkProjectManagerWatch(pool,watch);
 if(status==='pending'||!watch.orderId)return {status};
 const result=await pool.query("SELECT detail FROM project_pm_order_events WHERE order_id=$1 AND process_id=$2 AND kind='resume' ORDER BY created_at DESC LIMIT 1",[watch.orderId,watch.processId]);
 return {status,messageId:result.rows[0]?.detail};
}

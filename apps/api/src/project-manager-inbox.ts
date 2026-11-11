import {workflowResponsibility} from './workflow-responsibilities.js';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createAgentSession,finishAgentSession,agentSessionEffects} from './agent-tools.js';
import {agentLearnedContext} from './agent-tools.js';
import {conversationInstructions,resolveRoleAiSettings,roleCapacity} from './project-team.js';

type PendingTurn={id:string;project_id:string;channel:'project'|'pm-internal';pm_dispatch_attempt:number};
type RouteDeps={
 pool:Pool;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 start:(turn:PendingTurn)=>Promise<void>;
};

export async function initProjectManagerInbox(pool:Pick<Pool,'query'>){
 await pool.query(`
  ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS pm_request_id uuid;
  ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS pm_request_digest text;
  ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS pm_dispatch_attempt int NOT NULL DEFAULT 1;
  ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS pm_dispatched_at timestamptz;
  ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS pm_next_dispatch_at timestamptz NOT NULL DEFAULT now();
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_inbox_request ON assistant_messages(project_id,actor_id,pm_request_id)
   WHERE pm_request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_pm_inbox_delivery ON assistant_messages(pm_next_dispatch_at,created_at,id)
   WHERE role='user' AND channel IN ('project','pm-internal') AND status='queued' AND pm_dispatched_at IS NULL;
 `);
}

export function pmInboxWorkflowId(turn:PendingTurn){
 const prefix=turn.channel==='pm-internal'?'pm-resume-':'project-pm-';
 return prefix+turn.id+(turn.pm_dispatch_attempt>1?'-retry-'+turn.pm_dispatch_attempt:'');
}

/** Deliver explicit owner questions even when no PM turn is running. */
export async function publishOwnerQuestionsToPmChat(pool:Pick<Pool,'query'>){
 // Older analyses stored their owner questions directly on the task.
 // Move them into the same reply flow without changing the wording.
 await pool.query(`
  WITH legacy AS (
   SELECT t.id,t.project_id,t.spec_version,t.clarification_questions
   FROM tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
   WHERE t.stage='analysis' AND t.type='task' AND t.analysis_state NOT IN ('paused','failed')
    AND jsonb_array_length(t.clarification_questions)>0
   ORDER BY t.updated_at,t.id LIMIT 25 FOR UPDATE OF t SKIP LOCKED
  ), copied AS (
   INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status,requires_customer)
   SELECT gen_random_uuid(),t.project_id,t.id,'analysis','Системный аналитик','all','question',
    left(trim(q.body),3000),'agent','legacy-clarification:'||t.spec_version||':'||md5(trim(q.body)),'open',true
   FROM legacy t CROSS JOIN LATERAL jsonb_array_elements_text(t.clarification_questions) AS q(body)
   WHERE trim(q.body)<>'' AND NOT EXISTS(
    SELECT 1 FROM task_agent_notes n WHERE n.task_id=t.id AND n.project_id=t.project_id
     AND n.kind='question' AND n.status='open' AND n.requires_customer AND n.body=left(trim(q.body),3000))
   ON CONFLICT(task_id,source_key) DO NOTHING
   RETURNING task_id
  )
  UPDATE tasks t SET clarification_questions='[]'::jsonb,analysis_state=CASE
   WHEN EXISTS(SELECT 1 FROM copied c WHERE c.task_id=t.id)
    OR EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.task_id=t.id AND n.project_id=t.project_id
     AND n.kind='question' AND n.status IN ('open','processing'))
   THEN 'waiting_questions' ELSE 'new' END,updated_at=now()
  FROM legacy l WHERE t.id=l.id
 `);
 await pool.query(`
  WITH pending AS (
   SELECT n.id AS note_id,n.project_id,n.task_id,n.body,p.owner_id,t.display_number,t.title,
    gen_random_uuid() AS order_id,gen_random_uuid() AS message_id
   FROM task_agent_notes n
   JOIN tasks t ON t.id=n.task_id AND t.project_id=n.project_id AND t.stage<>'done'
   JOIN projects p ON p.id=n.project_id AND p.deleted_at IS NULL
   WHERE n.kind='question' AND n.status='open' AND n.requires_customer
    AND NOT EXISTS(SELECT 1 FROM project_pm_process_reports r WHERE r.project_id=n.project_id AND r.process_id=n.id)
   ORDER BY n.created_at,n.id LIMIT 25
  ), claimed AS (
   INSERT INTO project_pm_process_reports(project_id,process_id,kind)
   SELECT project_id,note_id,'owner_question' FROM pending
   ON CONFLICT DO NOTHING RETURNING project_id,process_id
  ), orders AS (
   INSERT INTO project_pm_orders(id,project_id,actor_id,status,summary)
   SELECT p.order_id,p.project_id,p.owner_id,'waiting_user',left(p.body,500)
   FROM pending p JOIN claimed c ON c.project_id=p.project_id AND c.process_id=p.note_id
   RETURNING id
  ), events AS (
   INSERT INTO project_pm_order_events(id,order_id,kind,detail,process_id)
   SELECT gen_random_uuid(),p.order_id,'owner_question','Ожидается ответ владельца',p.note_id
   FROM pending p JOIN orders o ON o.id=p.order_id
  )
  INSERT INTO assistant_messages(id,project_id,role,body,channel,status,pm_order_id,created_task_id)
  SELECT p.message_id,p.project_id,'assistant',
   'По задаче #'||p.display_number||' «'||p.title||'» нужно твоё решение.'||chr(10)||chr(10)||p.body,
   'project','completed',p.order_id,p.task_id
  FROM pending p JOIN orders o ON o.id=p.order_id
 `);
}

export async function deliverProjectManagerInbox(pool:Pick<Pool,'query'>,start:RouteDeps['start'],onError:(error:unknown,turn:PendingTurn)=>void){
 const pending=await pool.query<PendingTurn>(`SELECT id,project_id,channel,pm_dispatch_attempt FROM assistant_messages
  WHERE channel IN ('project','pm-internal') AND role='user' AND status='queued'
   AND pm_dispatched_at IS NULL AND pm_next_dispatch_at<=now()
  ORDER BY pm_next_dispatch_at,created_at,id LIMIT 15`);
 await Promise.all(pending.rows.map(async turn=>{
  try{await start(turn);}
  catch(error){
   if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error)?.name)){
    await pool.query(`UPDATE assistant_messages SET pm_next_dispatch_at=now()+interval '15 seconds'
     WHERE id=$1 AND pm_dispatch_attempt=$2 AND pm_dispatched_at IS NULL`,[turn.id,turn.pm_dispatch_attempt]);
    onError(error,turn);
    return;
   }
  }
  await pool.query('UPDATE assistant_messages SET pm_dispatched_at=now() WHERE id=$1 AND pm_dispatch_attempt=$2',
   [turn.id,turn.pm_dispatch_attempt]);
 }));
}

export function registerProjectManagerInbox(app:FastifyInstance,deps:RouteDeps){
 const {pool,uid,access,requireAdmin,start}=deps;
 let recovering=false;
 let timer:ReturnType<typeof setInterval>|null=null;
 let closing=false;
 const kick=()=>{
  if(recovering||closing)return;
  recovering=true;
  void deliverProjectManagerInbox(pool,start,(error,turn)=>app.log.warn({error,messageId:turn.id},'PM delivery will be retried'))
   .catch(error=>app.log.error({error},'PM inbox recovery failed'))
   .finally(()=>{recovering=false;});
 };
 app.post('/api/projects/:id/manager/inbox',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message,replyTo=null,topicId=null,requestId}=z.object({
   message:z.string().trim().min(1).max(4000),
   replyTo:z.string().uuid().nullable().optional(),
   topicId:z.string().uuid().nullable().optional(),
   requestId:z.string().uuid().optional()
  }).parse(req.body);
  const actorId=uid(req);
  const messageId=randomUUID();
  const digest=requestId?createHash('sha256').update(JSON.stringify([message,replyTo,topicId])).digest('hex'):null;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   if(requestId){
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id+':'+actorId+':pm-inbox:'+requestId]);
    const previous=(await client.query(`SELECT id,status,pm_order_id AS order_id,pm_request_digest FROM assistant_messages
     WHERE project_id=$1 AND actor_id=$2 AND pm_request_id=$3`,[id,actorId,requestId])).rows[0];
    if(previous){
     await client.query('COMMIT');
     if(previous.pm_request_digest!==digest)return reply.code(409).send({error:'Идентификатор запроса уже используется для другого сообщения'});
     return reply.code(202).send({id:previous.id,order_id:previous.order_id,status:previous.status});
    }
   }
   const target=replyTo?(await client.query(`SELECT pm_order_id FROM assistant_messages
    WHERE id=$1 AND project_id=$2 AND task_id IS NULL AND channel='project'`,[replyTo,id])).rows[0]:null;
   if(replyTo&&!target){
    await client.query('ROLLBACK');
    return reply.code(400).send({error:'Сообщение, на которое вы отвечаете, не найдено'});
   }
   if(topicId){
    const topic=await client.query("SELECT 1 FROM project_chat_topics WHERE id=$1 AND project_id=$2 AND status='open'",[topicId,id]);
    if(!topic.rowCount){
     await client.query('ROLLBACK');
     return reply.code(409).send({error:'Тема закрыта или отсутствует'});
    }
   }
   const waiting=(await client.query(`SELECT id FROM project_pm_orders WHERE project_id=$1 AND status='waiting_user'
    AND (id=$2 OR topic_id=$3) ORDER BY (id IS DISTINCT FROM $2),updated_at DESC,id LIMIT 1 FOR UPDATE`,
   [id,target?.pm_order_id??null,topicId])).rows[0];
   const orderId=waiting?.id??randomUUID();
   if(waiting)
    await client.query("UPDATE project_pm_orders SET status='queued',updated_at=now() WHERE id=$1",[orderId]);
   else
    await client.query('INSERT INTO project_pm_orders(id,project_id,actor_id,topic_id,summary) VALUES($1,$2,$3,$4,$5)',
     [orderId,id,actorId,topicId,message.slice(0,500)]);
   await client.query(`INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status,reply_to,topic_id,pm_order_id,pm_request_id,pm_request_digest)
    VALUES($1,$2,$3,'user',$4,'project','queued',$5,$6,$7,$8,$9)`,
    [messageId,id,actorId,message,replyTo,topicId,orderId,requestId??null,digest]);
   if(!waiting)await client.query('UPDATE project_pm_orders SET source_message_id=$2 WHERE id=$1',[orderId,messageId]);
   await client.query('INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,$3,$4)',
    [randomUUID(),orderId,waiting?'owner_reply':'created',waiting?'Владелец ответил на вопрос ПМ':'Поручение принято от владельца']);
   await client.query('COMMIT');
   return reply.code(202).send({id:messageId,order_id:orderId,status:'queued'});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 });
 app.post('/api/projects/:id/manager/inbox/:messageId/retry',async(req:any,reply)=>{
  const {id,messageId}=z.object({id:z.string().uuid(),messageId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const result=await pool.query(`WITH retried AS (
   UPDATE assistant_messages SET status='queued',pm_dispatch_attempt=pm_dispatch_attempt+1,
    pm_dispatched_at=NULL,pm_next_dispatch_at=now()
   WHERE project_id=$1 AND id=$2 AND channel='project' AND role='user' AND status='failed'
   RETURNING id,pm_order_id
  ), order_update AS (
   UPDATE project_pm_orders o SET status='queued',updated_at=now() FROM retried r
   WHERE o.id=r.pm_order_id AND o.status='failed'
  ) SELECT id FROM retried`,[id,messageId]);
  if(!result.rowCount)return reply.code(409).send({error:'Повторить можно только сообщение с ошибкой'});
  return reply.code(202).send({id:messageId,status:'queued'});
 });
 // The response acknowledges PostgreSQL. Delivery starts after the response
 // and the periodic scan also covers disconnects, restarts and internal turns.
 app.addHook('onResponse',async req=>{if(req.method==='POST'&&req.routeOptions.url?.includes('/manager/inbox'))kick();});
 app.addHook('onReady',async()=>{
  kick();
  timer=setInterval(kick,5000);
  timer.unref?.();
 });
 app.addHook('onClose',async()=>{closing=true;if(timer)clearInterval(timer);});
}

export async function failProjectManagerInbox(pool:Pick<Pool,'query'>,projectId:string,messageId:string,attempt:number){
 await pool.query(`WITH failed AS (
  UPDATE assistant_messages SET status='failed' WHERE project_id=$1 AND id=$2 AND pm_dispatch_attempt=$3
   AND status IN ('queued','processing') RETURNING pm_order_id
 ) UPDATE project_pm_orders o SET status='failed',updated_at=now() FROM failed f
   WHERE o.id=f.pm_order_id AND o.status IN ('working','queued')`,[projectId,messageId,attempt]);
}

export type ProjectManagerWatch={projectId:string;processId:string;kind:'iteration_plan'|'document_import'|'development'|'iteration_execution';orderId?:string;topicId?:string|null;actorId?:string};
export async function executeProjectManagerInbox(pool:Pool,projectId:string,messageId:string,runnerUrl:string,runnerKey:string,attempt=1):Promise<ProjectManagerWatch[]>{
 const claim=await pool.query("UPDATE assistant_messages SET status='processing' WHERE id=$1 AND project_id=$2 AND channel IN ('project','pm-internal') AND role='user' AND pm_dispatch_attempt=$3 AND status IN ('queued','processing') RETURNING id,actor_id,body,reply_to,topic_id,pm_order_id,channel",[messageId,projectId,attempt]);
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
   pool.query("SELECT id,task_id,author_stage,body,status,requires_customer FROM task_agent_notes WHERE project_id=$1 AND kind='question' AND status='open' ORDER BY requires_customer DESC,created_at DESC LIMIT 35",[projectId]),
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
   orderId?pool.query('SELECT kind,detail,process_id,created_at FROM project_pm_order_events WHERE order_id=$1 ORDER BY created_at DESC LIMIT 25',[orderId]):Promise.resolve({rows:[]}),
   pool.query("SELECT i.title,d.question,d.answer,d.created_at FROM iteration_owner_decisions d JOIN project_iterations i ON i.id=d.iteration_id WHERE i.project_id=$1 ORDER BY d.created_at DESC LIMIT 35",[projectId])
  ]);
  const ownerQuestion=orderId?(await pool.query(`SELECT n.id,n.task_id,n.body,n.status FROM project_pm_order_events e
   JOIN task_agent_notes n ON n.id=e.process_id AND n.project_id=$2
   WHERE e.order_id=$1 AND e.kind='owner_question' LIMIT 1`,[orderId,projectId])).rows[0]:null;
  const prompt=[
   'Ты ПМ проекта AI Development Orchestrator. Ты единственная точка взаимодействия владельца с агентами.',
   'Текущее поручение: '+String(orderId||'не задано')+'. Сохраняй связь с ним при уточнениях и продолжении после событий. Не считай поручение выполненным, пока работа не проверена.',
   ownerQuestion?'Это ответ на конкретный вопрос: '+JSON.stringify(ownerQuestion)+'. Если решение явно дано и вопрос открыт, сохрани его через approvals.answer_question с указанными ID. Если владелец просит уточнить вопрос, ответь и оставь поручение в waiting_user.':'',
   'НОВОЕ СООБЩЕНИЕ ВЛАДЕЛЬЦА: '+String(turn.body),
   'При завершении процесса ты будешь вызван повторно системой. Продолжай исходное поручение, а не просто пересказывай событие. Используй iterations.preview_plan и iterations.publish_plan при планировании. После прямой команды владельца «приступай к разработке» используй iterations.launch для утверждённой итерации, не пингуй разработчиков по каждой задаче.',
   'При необходимости задавай вопрос в отдельной теме через discussions.open и помечай поручение как waiting_user через pm.orders.update. Пока ответ не получен, не считай его закрытым.',
   'Если пользователь просит дозапустить, проверь processes.list и development_queue. Существующие поручения с актуальной ревизией подхватит диспетчер; сообщи конкретные причины ожидания. Устаревший запуск требует новой явной команды владельца на актуальную итерацию.',
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
   'Workflow: '+JSON.stringify(contextResult.rows.map(stage=>({...stage,responsibility:workflowResponsibility(stage.stage)}))).slice(0,4200),
   'Задачи: '+JSON.stringify(tasksResult.rows).slice(0,6500),
   'Вопросы от агентов: '+JSON.stringify(questionsResult.rows).slice(0,4800),
   'Тема: '+JSON.stringify(topicResult.rows[0]||null),
   'Активные поручения: '+JSON.stringify(orders.rows).slice(0,3300),
   'Контрольные точки поручения: '+JSON.stringify(orderEvents.rows).slice(0,4500),
   'Подтверждённые решения владельца: '+JSON.stringify(decisions.rows).slice(0,5500),
   'Реестр принятых решений проекта: '+JSON.stringify((await pool.query('SELECT question,answer,iteration_id FROM project_pm_decisions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 40',[projectId])).rows).slice(0,6000),
   'ID текущего сообщения владельца: '+String(turn.channel==='project'?messageId:'внутреннее системное событие'),
   'Ответ на сообщение: '+JSON.stringify(replyResult.rows[0]||null).slice(0,2500),
   'Недавняя история: '+JSON.stringify(historyResult.rows.reverse()).slice(0,5500)
  ].join('\n\n').slice(0,22500);
  const response=await fetch(runnerUrl+'/agent',{
   method:'POST',headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt,session_token:session.secret,agent_role:'manager',project_id:projectId,role_capacity:1}),
   signal:AbortSignal.timeout(255000)
  });
  const data=await response.json().catch(()=>({})) as any;
  if(!response.ok||typeof data.message!=='string'||!data.message.trim())throw Error(String(data.error||'ПМ не вернул ответ').slice(0,700));
  const effects=await agentSessionEffects(pool,session.id);
  const toolEvents=await pool.query("SELECT tool,result FROM agent_tool_events WHERE project_id=$1 AND session_id=$2 AND success=true AND tool IN ('iterations.prepare_plan','documentation.import','documentation.rebuild','documentation.organize','workflow.approve_development','iterations.launch','discussions.open','iterations.ask_question','pm.orders.update','pm.decisions.record')",[projectId,session.id]);
  const seen=new Set<string>();
  const effectiveTopicForWatch=turn.topic_id||toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string')||null;
  watchers=toolEvents.rows.flatMap(row=>{
   const kind:ProjectManagerWatch['kind']=row.tool==='iterations.launch'?'iteration_execution':['iterations.prepare_plan','pm.decisions.record'].includes(row.tool)?'iteration_plan':row.tool==='workflow.approve_development'?'development':'document_import';
   const id=kind==='iteration_execution'?row.result?.iteration_id:kind==='iteration_plan'?row.result?.planning_run_id:kind==='development'?row.result?.id:row.result?.import_job_id;
   if(typeof id!=='string'||seen.has(id))return [];
   seen.add(id);
   return [{projectId,processId:id,kind,orderId:orderId||undefined,topicId:effectiveTopicForWatch,actorId:turn.actor_id}];
  });
  const openedTopic=toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string');
  const effectiveTopic=turn.topic_id||openedTopic||null;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const finished=await client.query("UPDATE assistant_messages SET status='completed' WHERE id=$1 AND status='processing' AND pm_dispatch_attempt=$2 RETURNING id",[messageId,attempt]);
   if(finished.rowCount){
    if(effectiveTopic)await client.query("UPDATE assistant_messages SET topic_id=$2 WHERE id=$1",[messageId,effectiveTopic]);
    await client.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id,pm_order_id,created_task_id,created_document_id,documentation_reset_requested,owner_question_cleanup_requested) VALUES($1,$2,'assistant',$3,'project','completed',$4,$5,$6,$7,$8,$9)",
     [randomUUID(),projectId,data.message,effectiveTopic,orderId,effects.created_task_id,effects.created_document_id,effects.documentation_reset_requested||false,effects.owner_question_cleanup_requested||false]);
   }
   if(orderId&&finished.rowCount){
    const hasOpenQuestion=toolEvents.rows.some(row=>row.tool==='iterations.ask_question');
    const explicitlySet=toolEvents.rows.some(row=>row.tool==='pm.orders.update'&&row.result?.id===orderId);
    const questionOpen=ownerQuestion&&!!(await client.query("SELECT 1 FROM task_agent_notes WHERE id=$1 AND status IN ('open','processing')",[ownerQuestion.id])).rowCount;
    const status=questionOpen?'waiting_user':watchers.length?'waiting_agents':hasOpenQuestion?'waiting_user':'completed';
    if(!explicitlySet||watchers.length||ownerQuestion)await client.query('UPDATE project_pm_orders SET status=$2,topic_id=COALESCE($3,topic_id),updated_at=now() WHERE id=$1',[orderId,status,effectiveTopic]);
    else await client.query('UPDATE project_pm_orders SET topic_id=COALESCE($2,topic_id),updated_at=now() WHERE id=$1',[orderId,effectiveTopic]);
    await client.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,'pm_step',$3)",[randomUUID(),orderId,'ПМ завершил шаг; статус '+status]);
   }
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }catch(error){
  const message=String(error instanceof Error?error.message:error);
  const retryable=/busy|concurren|перегруз|несколько AI|лимит одноврем|429|503|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|AbortError/i.test(message);
  if(retryable){
   await pool.query(`WITH waiting AS (
    UPDATE assistant_messages SET status='queued' WHERE id=$1 AND pm_dispatch_attempt=$2
     AND status='processing' RETURNING pm_order_id
   ) UPDATE project_pm_orders o SET status='queued',updated_at=now() FROM waiting w WHERE o.id=w.pm_order_id`,
    [messageId,attempt]);
  }else await failProjectManagerInbox(pool,projectId,messageId,attempt);
  if(!retryable)throw Object.assign(new Error(message.slice(0,650)),{nonRetryable:true});
  throw error;
 }finally{
  if(sessionId)await finishAgentSession(pool,sessionId).catch(()=>{});
 }
 return watchers;
}

async function reportIterationExecutionWatch(pool:Pool,watch:ProjectManagerWatch,total:number,finished:number,stale:number):Promise<'completed'>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const mark=await client.query("INSERT INTO project_pm_process_reports(project_id,process_id,kind) VALUES($1,$2,'iteration_execution') ON CONFLICT DO NOTHING RETURNING process_id",[watch.projectId,watch.processId]);
  if(mark.rowCount){
   const message='Обработка очереди итерации завершена: '+finished+' из '+total+'.'+
    (stale?' Запуск '+stale+' задач требует повторного подтверждения.':'')+
    ' Проверь результаты и сообщи владельцу.';
   await client.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id,pm_order_id) VALUES($1,$2,'assistant',$3,'project','completed',$4,$5)",[randomUUID(),watch.projectId,message,watch.topicId||null,watch.orderId||null]);
   if(watch.orderId&&watch.actorId){
    const next=randomUUID();
    await client.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status,topic_id,pm_order_id) VALUES($1,$2,$3,'user',$4,'pm-internal','queued',$5,$6)",[next,watch.projectId,watch.actorId,'СИСТЕМНОЕ СОБЫТИЕ: '+message,watch.topicId||null,watch.orderId]);
    await client.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail,process_id) VALUES($1,$2,'resume',$3,$4)",[randomUUID(),watch.orderId,next,watch.processId]);
    await client.query("UPDATE project_pm_orders SET status='queued',updated_at=now() WHERE id=$1",[watch.orderId]);
   }
  }
  await client.query('COMMIT');return 'completed';
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Polling is a short database activity; the waiting happens in Temporal,
 * not in the PM AI session or an HTTP request. */
export async function checkProjectManagerWatch(pool:Pool,watch:ProjectManagerWatch):Promise<'pending'|'completed'>{
 if(watch.kind==='iteration_execution'){
  const status=await pool.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE t.stage='done' OR q.status IN ('cancelled','stale'))::int AS finished,count(*) FILTER (WHERE q.status='stale')::int AS stale FROM iteration_execution_queue q JOIN tasks t ON t.id=q.task_id WHERE q.project_id=$1 AND q.iteration_id=$2`,[watch.projectId,watch.processId]);
  const total=Number(status.rows[0]?.total||0),finished=Number(status.rows[0]?.finished||0);
  if(!total||finished!==total)return 'pending';
  return reportIterationExecutionWatch(pool,watch,total,finished,Number(status.rows[0]?.stale||0));
 }
 const where=watch.kind==='iteration_plan'?'r.id=$1 AND i.project_id=$2':'r.id=$1 AND r.project_id=$2';
 const sql=watch.kind==='iteration_plan'
  ? "SELECT r.id,r.status,r.message,r.plan_id,i.title AS name,i.id AS iteration_id FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id WHERE "+where
  :watch.kind==='development'
  ? `SELECT r.id,r.status,r.message,r.pr_url,t.title AS name
     FROM ai_task_runs r JOIN tasks t ON t.id=r.task_id AND t.project_id=r.project_id WHERE ${where}
     UNION ALL
     SELECT q.run_id,q.status,q.detail,NULL,t.title FROM iteration_execution_queue q JOIN tasks t ON t.id=q.task_id
      WHERE q.run_id=$1 AND q.project_id=$2 AND NOT EXISTS(SELECT 1 FROM ai_task_runs r WHERE r.id=q.run_id)`
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
 if(['queued','running','dispatching'].includes(process.status))return 'pending';
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

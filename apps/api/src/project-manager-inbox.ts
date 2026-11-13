import {reportPmWatchCompletion,type PmWatchReport} from './modules/planning/application/pm-watch-report.js';
import {composeAgentPrompt,recordAgentPrompt} from './agent-prompt.js';
import {workflowResponsibility} from './workflow-responsibilities.js';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {chatImagesSchema,validateChatImages,saveChatImages,readChatImages} from './chat-images.js';
import {createAgentSession,finishAgentSession,agentSessionEffects,isProjectManagerOrderAction} from './agent-tools.js';
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

type CompletedPmTool={tool:string;result?:unknown};

export function shouldCreateProjectManagerOrder(events:readonly CompletedPmTool[],delegated=false){
 return delegated||events.some(event=>{
  if(!isProjectManagerOrderAction(event.tool))return false;
  const result=event.result;
  return !(result&&typeof result==='object'&&'recorded' in result&&result.recorded===false);
 });
}

/** Link a successful action to its source message, transactionally and once. */
export async function ensureProjectManagerActionOrder(
 db:Pick<Pool,'query'>,
 args:{projectId:string;messageId:string;actorId:string;topicId:string|null;summary:string;events:readonly CompletedPmTool[];delegated?:boolean}
):Promise<string|null>{
 if(!shouldCreateProjectManagerOrder(args.events,!!args.delegated))return null;
 const current=await db.query('SELECT pm_order_id FROM assistant_messages WHERE project_id=$1 AND id=$2 FOR UPDATE',[args.projectId,args.messageId]);
 if(!current.rowCount)throw Error('Сообщение ПМ для поручения не найдено');
 if(current.rows[0].pm_order_id)return current.rows[0].pm_order_id as string;
 const orderId=randomUUID();
 await db.query(`INSERT INTO project_pm_orders(id,project_id,actor_id,source_message_id,topic_id,status,summary)
  VALUES($1,$2,$3,$4,$5,'working',$6)`,[orderId,args.projectId,args.actorId,args.messageId,args.topicId,args.summary.slice(0,500)]);
 await db.query('UPDATE assistant_messages SET pm_order_id=$2 WHERE project_id=$1 AND id=$3',[args.projectId,orderId,args.messageId]);
 // Decisions are recorded by their authenticated message ID before the order exists.
 await db.query('UPDATE project_pm_decisions SET order_id=$2 WHERE project_id=$1 AND source_message_id=$3 AND order_id IS NULL',
  [args.projectId,orderId,args.messageId]);
 await db.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,'created',$3)",
  [randomUUID(),orderId,'Поручение создано после подтверждённого действия ПМ']);
 return orderId;
}

export function pmInboxWorkflowId(turn:PendingTurn){
 const prefix=turn.channel==='pm-internal'?'pm-resume-':'project-pm-';
 return prefix+turn.id+(turn.pm_dispatch_attempt>1?'-retry-'+turn.pm_dispatch_attempt:'');
}

/** Normalize old task questions and deliver explicit non-analyst requests to the PM chat. */
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
    AND n.author_stage NOT IN ('analysis','analyst','business_analyst')
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
 app.post('/api/projects/:id/manager/inbox',{bodyLimit:9*1024*1024},async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message,replyTo=null,topicId=null,requestId,images}=z.object({
   message:z.string().trim().max(4000),
   images:chatImagesSchema,
   replyTo:z.string().uuid().nullable().optional(),
   topicId:z.string().uuid().nullable().optional(),
   requestId:z.string().uuid().optional()
  }).refine(value=>!!value.message||value.images.length>0,{message:'Добавь сообщение или изображение'}).parse(req.body);
  const validatedImages=validateChatImages(images);
  const actorId=uid(req);
  const messageId=randomUUID();
  const digest=requestId?createHash('sha256').update(JSON.stringify([message,replyTo,topicId,images.map(image=>createHash('sha256').update(image.data).digest('hex'))])).digest('hex'):null;
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
   // Message dispatch is durable. New orders are created only after a real action.
   const orderId:string|null=waiting?.id??null;
   if(waiting)
    await client.query("UPDATE project_pm_orders SET status='queued',updated_at=now() WHERE id=$1",[orderId]);
   await client.query(`INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status,reply_to,topic_id,pm_order_id,pm_request_id,pm_request_digest)
    VALUES($1,$2,$3,'user',$4,'project','queued',$5,$6,$7,$8,$9)`,
    [messageId,id,actorId,message,replyTo,topicId,orderId,requestId??null,digest]);
   await saveChatImages(client,{projectId:id,actorId,messageId,scope:'assistant'},validatedImages);
   if(waiting)await client.query('INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,$3,$4)',
    [randomUUID(),orderId,'owner_reply','Владелец ответил на вопрос ПМ']);
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

export type ProjectManagerWatch=PmWatchReport;
export async function executeProjectManagerInbox(pool:Pool,projectId:string,messageId:string,runnerUrl:string,runnerKey:string,attempt=1):Promise<ProjectManagerWatch[]>{
 const claim=await pool.query("UPDATE assistant_messages SET status='processing' WHERE id=$1 AND project_id=$2 AND channel IN ('project','pm-internal') AND role='user' AND pm_dispatch_attempt=$3 AND status IN ('queued','processing') RETURNING id,actor_id,body,reply_to,topic_id,pm_order_id,channel",[messageId,projectId,attempt]);
 if(!claim.rowCount)return [];
 const turn=claim.rows[0];
 const orderId:string|null=turn.pm_order_id??null;
 if(orderId)await pool.query("UPDATE project_pm_orders SET status='working',updated_at=now() WHERE id=$1",[orderId]);
 let sessionId:string|null=null;
 let watchers:ProjectManagerWatch[]=[];
 try{
  // No project-wide task snapshots or chat history on each PM turn.
  // Current order and explicit reply are sufficient; tools provide everything else.
  const [configResult,projectResult,replyResult,topicResult,orderResult,eventResult,recentResult]=await Promise.all([
   pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]),
   pool.query('SELECT name,description FROM projects WHERE id=$1',[projectId]),
   turn.reply_to?pool.query("SELECT role,body FROM assistant_messages WHERE project_id=$1 AND id=$2",[projectId,turn.reply_to]):Promise.resolve({rows:[]}),
   turn.topic_id?pool.query('SELECT title,status FROM project_chat_topics WHERE project_id=$1 AND id=$2',[projectId,turn.topic_id]):Promise.resolve({rows:[]}),
   orderId?pool.query('SELECT summary,status,topic_id FROM project_pm_orders WHERE project_id=$1 AND id=$2',[projectId,orderId]):Promise.resolve({rows:[]}),
   orderId?pool.query('SELECT kind,detail,process_id FROM project_pm_order_events WHERE order_id=$1 ORDER BY created_at DESC LIMIT 3',[orderId]):Promise.resolve({rows:[]}),
   !turn.reply_to?pool.query("SELECT role,left(body,450) AS body FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL AND channel='project' AND status='completed' AND id<>$2 AND ((topic_id=$3) OR ($3::uuid IS NULL AND topic_id IS NULL)) ORDER BY created_at DESC,id DESC LIMIT 3",[projectId,messageId,turn.topic_id||null]):Promise.resolve({rows:[]})
  ]);
  const config=await resolveRoleAiSettings(pool,projectId,'manager',configResult.rows[0]);
  if(!config?.enabled)throw Error('AI выключен в настройках проекта');
  const session=await createAgentSession(pool,projectId,turn.actor_id,'manager');
  sessionId=session.id;
  const instructions=await conversationInstructions(pool,projectId,'manager');
  const ownerQuestion=orderId?(await pool.query(
   "SELECT n.id,n.task_id,n.body,n.status FROM project_pm_order_events e JOIN task_agent_notes n ON n.id=e.process_id AND n.project_id=$2 WHERE e.order_id=$1 AND e.kind='owner_question' LIMIT 1",
   [orderId,projectId])).rows[0]:null;
  const images=await readChatImages(pool,projectId,messageId,'assistant');
  const prompt=composeAgentPrompt({
   role:'Менеджер проекта AI Development Orchestrator. Один логический ПМ, независимые поручения.',
   objective:String(turn.body||'Изучи приложенные изображения'),
   tools:'MCP orchestrator. Получай задачи через tasks.list/read, процессы через processes.list, решения через pm.decisions.list, историю по необходимости через discussions.read/history.search, итерации через iterations.list/read. Вызывай инструмент только когда информация нужна для текущего сообщения; не читай весь проект автоматически.',
   instructions:[
    instructions.slice(0,3200),
    'Координируй работу специалистов; не подменяй аналитика, разработчика, QA или DevOps.',
    'При просьбе подготовить или уточнить ТЗ передай вводные аналитику через documentation.prepare_spec. Для плана используй iterations.prepare_plan: аналитик обновляет текущие карточки и создаёт недостающие. Готовые задачи автоматически идут в разработку.',
    'Если запрос просто вопрос — отвечай без побочных изменений. При неизвестном факте используй адресное чтение.',
    'Если владелец явно просит удалить ошибочную карточку, используй tasks.delete с подтверждёнными task_id и source_message_id его сообщения. Действуй только после серверного разрешения. Не утверждай, что удаление в принципе невозможно, пока не проверил соответствующий инструмент.',
    'Если поступило событие завершения, продолжи соответствующее поручение; новые вопросы ПМ оформляй через discussions.open, после ответа закрывай тему.',
    'Если аналитик попросил данные, сначала попробуй найти их в контексте проекта и документах. При наличии подтверждённых сведений вызови documentation.resume_spec с его job_id и ответом. Иначе спроси владельца в обсуждении; после ответа продолжи именно то же поручение через documentation.resume_spec, не запускай повторную подготовку с нуля.',
    orderId?'Текущее поручение: '+orderId+'.':'Новый ход чата: order_id отсутствует. При успешном действии поручение создаст backend. Не вызывай pm.orders.update без существующего order_id.',
    'Для повторного QA используй qa.retry после проверки текущих процессов. При неполном QA укажи, что не проверено. Для подробностей используй processes.list с process_id.',
    'Для возврата на анализ, адресного исправления существующего PR или повторного QA используй workflow.move_task с target_stage, source_message_id владельца и причиной. Не запускай работу с нуля, учитывай сохранённые результаты и новые комментарии. Статус merge_queue и последующие этапы устанавливают штатные проверки, а не ПМ вручную.',
    'Для завершения готовой задачи вызывай tasks.close: операция подтвердит слияние, выкладку и документацию. Для ОТМЕНЫ ненужной начатой задачи есть tasks.cancel (это удаление с аудитом), для удаления ошибочной неисполненной карточки tasks.delete. Не путай закрытие успешно сделанной задачи с отменой, не выставляй done без проверки.',
    'На каждый новый комментарий, который меняет требования или исправляет результат, проверь tasks.read и инициируй уточнение, доработку или повторное тестирование только затронутой части. Если действие не требуется, не ставь фиктивных процессов и не сообщай, что всё переделано.',
    'Для вопросов по существующей задаче сначала прочитай tasks.read или approvals.list: там есть реальные ID открытых вопросов. Если владелец уже ответил в общем чате, найди сохранённое сообщение через history.search и вызови approvals.deliver_task_answer с task_id и source_message_id — это переносит дословный ответ в карточку и возвращает её аналитику. Не говори, что инструментов передачи ответа нет, не проси переписать ранее данный ответ и не создавай отдельную задачу для уточнения. Для вопросов документации используй documentation.answer_question. Прочие решения — pm.decisions.record.',
    'Не запускай несколько одинаковых процессов и не ожидай другие поручения синхронно.',
    'После завершения подготовки проверь iterations.read: карточки должны быть на доске. При отсутствии GitHub сообщи: «Задачи созданы, но разработка ожидает подключения/доступа GitHub». GitHub не нужен для создания задач. При ошибке публикации назови конкретную причину; не перезапускай СА без новых требований.',
   ].join('\n'),
   scope:JSON.stringify({project:projectResult.rows[0]||{},order_id:orderId,order:orderResult.rows[0]||null,topic:topicResult.rows[0]||null,message_id:messageId}),
   continuation:[
    ownerQuestion?'Вопрос, на который отвечает пользователь: '+JSON.stringify(ownerQuestion):'',
    replyResult.rows[0]?'Ответ на сообщение: '+JSON.stringify(replyResult.rows[0]).slice(0,1600):'',
    eventResult.rows.length?'Последние события этого поручения: '+JSON.stringify(eventResult.rows).slice(0,1000):'',
    recentResult.rows.length?'Короткий контекст текущего диалога: '+JSON.stringify(recentResult.rows.reverse()).slice(0,950):'',
     images.length?'Приложены изображения: '+images.map(image=>image.name).join(', ')+'. Рассмотри их визуальное содержимое.':''
   ].filter(Boolean).join('\n\n'),
    output:'Ответь по-русски. При действиях назови подтверждённый результат. При ожидании объясни конкретную причину. Для запроса подробностей получи относящиеся к нему факты через доступные инструменты.'
  });
  // First turn uses the complete PM role contract; subsequent turns keep that
  // contract in the same Codex thread and supply only fresh owner input.
  const resumePrompt=[
   'Новое сообщение владельца. source_message_id='+messageId,
   'Текст: '+String(turn.body||'Изучи приложенные изображения').slice(0,4000),
   orderId?'Текущее поручение: '+orderId:'',
   turn.reply_to?'Ответ на сообщение '+turn.reply_to+': '+JSON.stringify(replyResult.rows[0]||{}).slice(0,1000):'',
   turn.topic_id?'Тема '+turn.topic_id+': '+JSON.stringify(topicResult.rows[0]||{}).slice(0,350):'',
   ownerQuestion?'Решаемый вопрос: '+JSON.stringify(ownerQuestion).slice(0,850):'',
   eventResult.rows.length?'Новые события поручения: '+JSON.stringify(eventResult.rows).slice(0,850):'',
   images.length?'Приложены изображения: '+images.map(image=>image.name).join(', '):'',
   'Не пересказывай всю историю. При необходимости используй адресные MCP-инструменты; '+
    'сохранённые фоновые поручения отслеживаются Temporal, не ожидай их синхронно.'
  ].filter(Boolean).join('\\n');
  await recordAgentPrompt(pool,{projectId,processId:orderId||messageId,role:'manager',operation:'pm_turn',prompt}).catch(()=>{});
  const response=await fetch(runnerUrl+'/agent',{
   method:'POST',headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt,resume_prompt:resumePrompt,request_id:messageId,actor_id:turn.actor_id,session_token:session.secret,agent_role:'manager',project_id:projectId,role_capacity:1,images}),
   signal:AbortSignal.timeout(255000)
  });
  const data=await response.json().catch(()=>({})) as any;
  if(!response.ok||typeof data.message!=='string'||!data.message.trim())throw Error(String(data.error||'ПМ не вернул ответ').slice(0,700));
  const effects=await agentSessionEffects(pool,session.id);
  const toolEvents=await pool.query('SELECT tool,result FROM agent_tool_events WHERE project_id=$1 AND session_id=$2 AND success=true',[projectId,session.id]);
  const seen=new Set<string>();
  const effectiveTopicForWatch=turn.topic_id||toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string')||null;
  watchers=toolEvents.rows.flatMap(row=>{
   const kind:ProjectManagerWatch['kind']=row.tool==='qa.retry'?'testing':row.tool==='iterations.launch'?'iteration_execution':['iterations.prepare_plan','pm.decisions.record'].includes(row.tool)?'iteration_plan':row.tool==='workflow.approve_development'?'development':'document_import';
   const id=kind==='testing'?row.result?.cycle_id:kind==='iteration_execution'?row.result?.iteration_id:kind==='iteration_plan'?row.result?.planning_run_id:kind==='development'?row.result?.id:row.result?.import_job_id;
   if(typeof id!=='string'||seen.has(id))return [];
   seen.add(id);
   return [{projectId,processId:id,kind,orderId:orderId||undefined,topicId:effectiveTopicForWatch,actorId:turn.actor_id}];
  });
  const openedTopic=toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string');
  const effectiveTopic=turn.topic_id||openedTopic||null;
  const client=await pool.connect();
  let confirmedOrderId=orderId;
  try{
   await client.query('BEGIN');
   const finished=await client.query("UPDATE assistant_messages SET status='completed' WHERE id=$1 AND status='processing' AND pm_dispatch_attempt=$2 RETURNING id",[messageId,attempt]);
   if(finished.rowCount&&!confirmedOrderId&&turn.channel==='project'){
    confirmedOrderId=await ensureProjectManagerActionOrder(client,{
     projectId,messageId,actorId:turn.actor_id,topicId:effectiveTopic,summary:String(turn.body||'Действие ПМ'),
     events:toolEvents.rows,delegated:watchers.length>0
    });
   }
   if(finished.rowCount){
    // Keep the original question in the main chat when the PM opens a topic.
    // Only the PM's answer is assigned to the new topic; both remain visible in the main timeline.
    await client.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id,pm_order_id,created_task_id,created_document_id,documentation_reset_requested,owner_question_cleanup_requested) VALUES($1,$2,'assistant',$3,'project','completed',$4,$5,$6,$7,$8,$9)",
     [randomUUID(),projectId,data.message,effectiveTopic,confirmedOrderId,effects.created_task_id,effects.created_document_id,effects.documentation_reset_requested||false,effects.owner_question_cleanup_requested||false]);
   }
   if(confirmedOrderId&&finished.rowCount){
    const hasOpenQuestion=toolEvents.rows.some(row=>row.tool==='iterations.ask_question'||row.tool==='discussions.open'&&row.result?.awaiting_reply===true);
    const explicitlySet=toolEvents.rows.some(row=>row.tool==='pm.orders.update'&&row.result?.id===confirmedOrderId);
    const questionOpen=ownerQuestion&&!!(await client.query("SELECT 1 FROM task_agent_notes WHERE id=$1 AND status IN ('open','processing')",[ownerQuestion.id])).rowCount;
    const status=questionOpen||hasOpenQuestion?'waiting_user':watchers.length?'waiting_agents':'completed';
    if(!explicitlySet||watchers.length||ownerQuestion||hasOpenQuestion)await client.query('UPDATE project_pm_orders SET status=$2,topic_id=COALESCE($3,topic_id),updated_at=now() WHERE id=$1',[confirmedOrderId,status,effectiveTopic]);
    else await client.query('UPDATE project_pm_orders SET topic_id=COALESCE($2,topic_id),updated_at=now() WHERE id=$1',[confirmedOrderId,effectiveTopic]);
    if(effectiveTopic)await client.query(`UPDATE project_chat_topics t SET status='closed',closed_at=now()
     WHERE t.id=$1 AND t.project_id=$2 AND t.status='open'
      AND EXISTS(SELECT 1 FROM project_pm_orders o WHERE o.id=$3 AND o.status='completed')
      AND NOT EXISTS(SELECT 1 FROM project_pm_orders o WHERE o.project_id=t.project_id AND o.topic_id=t.id
       AND o.status IN ('queued','working','waiting_agents','waiting_user'))`,[effectiveTopic,projectId,confirmedOrderId]);
    await client.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,'pm_step',$3)",[randomUUID(),confirmedOrderId,'ПМ завершил шаг; статус '+status]);
   }
   await client.query('COMMIT');
   if(confirmedOrderId)watchers=watchers.map(watch=>({...watch,orderId:confirmedOrderId||undefined}));
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }catch(error){
  // Codex may perform a mutation and fail before producing a final reply.
  // Keep the side effect associated with a durable order for recovery.
  if(!orderId&&sessionId&&turn.channel==='project'){
   const events=await pool.query('SELECT tool,result FROM agent_tool_events WHERE project_id=$1 AND session_id=$2 AND success=true',[projectId,sessionId]);
   if(shouldCreateProjectManagerOrder(events.rows)){
    const recovery=await pool.connect();
    try{
     await recovery.query('BEGIN');
     await ensureProjectManagerActionOrder(recovery,{
      projectId,messageId,actorId:turn.actor_id,topicId:turn.topic_id,
      summary:String(turn.body||'Действие ПМ'),events:events.rows
     });
     await recovery.query('COMMIT');
    }catch(e){await recovery.query('ROLLBACK').catch(()=>{});throw e;}finally{recovery.release();}
   }
  }
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
 const message='Обработка очереди итерации завершена: '+finished+' из '+total+'.'+
  (stale?' Запуск '+stale+' задач требует повторного подтверждения.':'')+
  ' Проверь результаты и сообщи владельцу.';
 return reportPmWatchCompletion(pool,watch,{message,resumeInstruction:''});
}

/** Polling is a short database activity; the waiting happens in Temporal,
 * not in the PM AI session or an HTTP request. */
export async function checkProjectManagerWatch(pool:Pool,watch:ProjectManagerWatch):Promise<'pending'|'completed'>{
 if(watch.kind==='testing'){
  // A QA retry is a Temporal manualTesting cycle. The workflow owner is
  // durable even if QA planning fails before ai_test_runs is created.
  const run=await pool.query(`SELECT o.state,t.title AS name,t.stage,
    q.status AS qa_status,q.message AS qa_message,q.verdict AS qa_verdict,
    q.report->>'summary' AS qa_summary
   FROM task_orchestration_owners o
   JOIN tasks t ON t.id=o.task_id AND t.project_id=o.project_id
   LEFT JOIN LATERAL (
     SELECT status,message,verdict,report FROM ai_test_runs
     WHERE project_id=o.project_id AND task_id=o.task_id AND cycle_id=o.owner_id
     ORDER BY created_at DESC,id DESC LIMIT 1
   ) q ON true
   WHERE o.project_id=$1 AND o.owner_id=$2 AND o.kind='testing'`,[watch.projectId,watch.processId]);
  if(!run.rowCount)return 'completed';
  const qa=run.rows[0];
  if(qa.state==='active')return 'pending';
  // Use the common reporting/resume path, never a second QA launch.
  const outcome=qa.qa_status==='completed'&&qa.qa_verdict==='passed'?'completed':'failed';
  const explanation=qa.qa_status==='completed'
   ?'Вердикт QA: '+String(qa.qa_verdict||'не установлен')+'. '+String(qa.qa_summary||qa.qa_message||'')
   :String(qa.qa_message||'QA завершился до получения подтверждённого отчёта. Проверь журнал процесса.');
  const message='Повторная проверка QA задачи «'+String(qa.name)+'» завершена: '+(outcome==='completed'?'тестирование пройдено. ':'требуется внимание. ')+explanation.slice(0,2100);
  return reportPmWatchCompletion(pool,watch,{
   message,
   resumeInstruction:' Проанализируй результат QA и продолжи исходное поручение. Не запускай бесконечные повторы, не объявляй непроверенное успешным.'
  });
 }
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
 const title=watch.kind==='iteration_plan'?'Подготовка задач итерации «'+process.name+'»':watch.kind==='development'?'Разработка задачи «'+process.name+'»':'Работа с документацией';
 const docsWritten=Number(process.saved_documents||process.result?.changed_documents||process.result?.generated_documents||0);
 const verifiedCount=Array.isArray(process.result?.document_ids)?process.result.document_ids.length:0;
 const needsContext=watch.kind==='document_import'&&process.status==='waiting_input';
 const emptyDocumentation=watch.kind==='document_import'&&process.status==='completed'&&docsWritten===0&&verifiedCount===0;
 const message=needsContext
  ?'Аналитик запросил сведения для выполнения поручения. Вопрос: '+String(process.result?.question||process.message||'Не уточнён')+
   '. Контекст: '+String(process.result?.context||'')+'. ID поручения: '+watch.processId+
   '. ПМ должен найти подтверждённые данные и вызвать documentation.resume_spec, либо задать вопрос владельцу. Повторять подготовку с нуля не нужно.'
  :emptyDocumentation
  ?'Аналитик завершил ответ, но не создал и не изменил ни одной страницы ТЗ. Поручение НЕ выполнено. Проверь доступность источников проекта; не запускай повтор без новых данных или устранения причины.'
  :process.status==='completed'
  ?watch.kind==='iteration_plan'
   ?title+' завершена. '+String(process.message||'')+' План разработки: '+String(process.plan_id||'не указан')+'. Карточки готовы. Задачи без открытых вопросов передаются в разработку.'
   :watch.kind==='development'
   ?title+' завершена. '+String(process.message||'')+(process.pr_url?' PR: '+process.pr_url:'')
   :title+' завершена. Сохранено страниц: '+docsWritten+'. Подтверждено страниц: '+verifiedCount+'. '+String(process.result?.summary||process.message||'Документация обновлена')
  :title+' завершилась со статусом «'+process.status+'». '+String(process.message||'Посмотри детали в Центре процессов');
 return reportPmWatchCompletion(pool,watch,{
  message,
  resumeInstruction:' Продолжи исходное поручение, проверь результат, примени допустимые дальнейшие действия или запроси решение владельца.',
  visibleLimit:3500
 });

}

/** Resume reference is persisted transactionally with the completion report.
 * Temporal can retry safely without enqueuing a duplicate PM turn. */
export async function readProjectManagerWatchResume(pool:Pool,watch:ProjectManagerWatch):Promise<{status:'pending'|'completed';messageId?:string}>{
 const status=await checkProjectManagerWatch(pool,watch);
 if(status==='pending'||!watch.orderId)return {status};
 const result=await pool.query("SELECT detail FROM project_pm_order_events WHERE order_id=$1 AND process_id=$2 AND kind='resume' ORDER BY created_at DESC LIMIT 1",[watch.orderId,watch.processId]);
 return {status,messageId:result.rows[0]?.detail};
}

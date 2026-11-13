import type {PmWatchReport} from './modules/planning/application/pm-watch-report.js';
import {createProjectManagerTurnExecutor} from './modules/planning/application/pm-turn.js';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {chatImagesSchema,validateChatImages,saveChatImages} from './chat-images.js';
import {isProjectManagerOrderAction} from './agent-tools.js';

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
/** Preserve the public PM inbox API while execution lives in an application use case. */
export const executeProjectManagerInbox=createProjectManagerTurnExecutor({
 ensureProjectManagerActionOrder,shouldCreateProjectManagerOrder,failProjectManagerInbox
});
export {checkProjectManagerWatch,readProjectManagerWatchResume} from './modules/planning/application/pm-watch-monitor.js';

import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createAgentSession,finishAgentSession,agentSessionEffects} from './agent-tools.js';
import {agentLearnedContext} from './agent-tools.js';
import {conversationInstructions} from './project-team.js';

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
  await pool.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status,reply_to,topic_id) VALUES($1,$2,$3,'user',$4,'project','queued',$5,$6)",
   [messageId,id,uid(req),message,replyTo||null,topicId||null]);
  try{await start(id,messageId);}
  catch(e){
   await pool.query("UPDATE assistant_messages SET status='failed' WHERE id=$1",[messageId]);
   return reply.code(503).send({error:'Сообщение сохранено, но не удалось поставить его в очередь Temporal',message_id:messageId});
  }
  return reply.code(202).send({id:messageId,status:'queued'});
 });
 app.post('/api/projects/:id/manager/inbox/:messageId/retry',async(req:any,reply)=>{
  const {id,messageId}=z.object({id:z.string().uuid(),messageId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const changed=await pool.query("UPDATE assistant_messages SET status='queued' WHERE project_id=$1 AND id=$2 AND channel='project' AND role='user' AND status='failed' RETURNING id",[id,messageId]);
  if(!changed.rowCount)return reply.code(409).send({error:'Повторить можно только сообщение с ошибкой'});
  await start(id,messageId).catch(error=>req.log.warn({error,messageId},'PM retry will be recovered'));
  return reply.code(202).send({id:messageId,status:'queued'});
 });
 // Crash recovery: persisted turns must not depend on the browser or a single
 // successful dispatch attempt. Temporal workflow IDs are deterministic.
 let timer:ReturnType<typeof setInterval>|null=null,recovering=false;
 const recover=async()=>{
  if(recovering)return;recovering=true;
  try{
   const rows=await pool.query("SELECT id,project_id FROM assistant_messages WHERE channel='project' AND role='user' AND status='queued' AND created_at>now()-interval '30 days' ORDER BY created_at LIMIT 15");
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

export async function executeProjectManagerInbox(pool:Pool,projectId:string,messageId:string,runnerUrl:string,runnerKey:string):Promise<void>{
 const claim=await pool.query("UPDATE assistant_messages SET status='processing' WHERE id=$1 AND project_id=$2 AND channel='project' AND role='user' AND status IN ('queued','processing') RETURNING id,actor_id,body,reply_to,topic_id",[messageId,projectId]);
 if(!claim.rowCount)return;
 const turn=claim.rows[0];
 let sessionId:string|null=null;
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
  const config=configResult.rows[0];
  if(!config?.enabled)throw Error('AI выключен в настройках проекта');
  const session=await createAgentSession(pool,projectId,turn.actor_id,'manager');
  sessionId=session.id;
  const [instructions,learned]=await Promise.all([
   conversationInstructions(pool,projectId,'manager'),agentLearnedContext(pool,projectId,'manager')
  ]);
  const prompt=[
   'Ты ПМ проекта AI Development Orchestrator. Ты единственная точка взаимодействия владельца с агентами.',
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
   'Ответ на сообщение: '+JSON.stringify(replyResult.rows[0]||null).slice(0,2500),
   'Недавняя история: '+JSON.stringify(historyResult.rows.reverse()).slice(0,5500),
   'НОВОЕ СООБЩЕНИЕ ВЛАДЕЛЬЦА: '+String(turn.body)
  ].join('\n\n').slice(0,22500);
  const response=await fetch(runnerUrl+'/agent',{
   method:'POST',headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt,session_token:session.secret}),
   signal:AbortSignal.timeout(255000)
  });
  const data=await response.json().catch(()=>({})) as any;
  if(!response.ok||typeof data.message!=='string'||!data.message.trim())throw Error(String(data.error||'ПМ не вернул ответ').slice(0,700));
  const effects=await agentSessionEffects(pool,session.id);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const finished=await client.query("UPDATE assistant_messages SET status='completed' WHERE id=$1 AND status='processing' RETURNING id",[messageId]);
   if(finished.rowCount){
    await client.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id,created_task_id,created_document_id,documentation_reset_requested,owner_question_cleanup_requested) VALUES($1,$2,'assistant',$3,'project','completed',$4,$5,$6,$7,$8)",
     [randomUUID(),projectId,data.message,turn.topic_id||null,effects.created_task_id,effects.created_document_id,effects.documentation_reset_requested||false,effects.owner_question_cleanup_requested||false]);
   }
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }catch(error){
  await pool.query("UPDATE assistant_messages SET status='failed' WHERE id=$1 AND status='processing'",[messageId]);
  throw error;
 }finally{
  if(sessionId)await finishAgentSession(pool,sessionId).catch(()=>{});
 }
}

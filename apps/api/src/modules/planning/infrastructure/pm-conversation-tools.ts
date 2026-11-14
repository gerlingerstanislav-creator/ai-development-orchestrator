import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {AgentSession} from '../../../agent-tools.js';
import {readPmTaskGoal} from '../../../pm-task-goal.js';
import {recordIterationDecision,queueIterationPlanning} from '../../../project-iterations.js';

type Db=Pick<Pool,'query'>;
const uuid=z.string().uuid();
const rejected=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});

/** PM chat topics, decisions and orders share the existing MCP transaction
 * and caller authorization. This allowlist is the sole dispatch entry point.
 * Topic reads never create orders, and durable watch requires the live PM inbox.
 */
const pmConversationTools=new Set([
 'discussions.read','history.search','discussions.list','discussions.open',
 'discussions.close','discussions.reopen','pm.decisions.list','pm.decisions.record',
 'pm.orders.watch_task','pm.orders.list','pm.orders.update'
]);
export function isPmConversationTool(name:string){return pmConversationTools.has(name);}

export async function executePmConversationTool(pool:Db,session:AgentSession,
 name:string,params:Record<string,unknown>):Promise<unknown>{
 const projectId=session.project_id,actorId=session.actor_id;
 switch(name){
 case 'discussions.read':{
  const {topic_id,limit}=z.object({topic_id:uuid,limit:z.number().int().min(1).max(20).default(6)}).parse(params);
  const topic=await pool.query('SELECT id,title,status FROM project_chat_topics WHERE id=$1 AND project_id=$2',[topic_id,projectId]);
  if(!topic.rowCount)throw rejected('Тема не найдена',404);
  const messages=await pool.query(
   "SELECT id,role,left(body,1300) AS body,reply_to,created_at FROM assistant_messages WHERE project_id=$1 AND topic_id=$2 AND channel='project' AND status='completed' ORDER BY created_at DESC,id DESC LIMIT $3",
   [projectId,topic_id,limit]);
  return {topic:topic.rows[0],messages:messages.rows.reverse()};
 }
 case 'history.search':{
  const {query,limit}=z.object({query:z.string().trim().min(2).max(120),limit:z.number().int().min(1).max(12).default(6)}).parse(params);
  const messages=await pool.query(
   "SELECT id,role,left(body,1400) AS excerpt,topic_id,created_at FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL AND channel='project' AND status='completed' AND body ILIKE $2 ORDER BY created_at DESC,id DESC LIMIT $3",
   [projectId,'%'+query+'%',limit]);
  return {messages:messages.rows};
 }
 case 'discussions.list':{
  const topics=await pool.query('SELECT id,title,status,created_at,closed_at FROM project_chat_topics WHERE project_id=$1 ORDER BY status,created_at DESC LIMIT 100',[projectId]);
  return {topics:topics.rows};
 }
 case 'discussions.open':{
  const {title,opening_message,awaiting_reply}=z.object({
   title:z.string().trim().min(3).max(180),opening_message:z.string().trim().min(3).max(4000),awaiting_reply:z.boolean().default(true)
  }).parse(params);
  await pool.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
  const existing=await pool.query("SELECT id,title,status FROM project_chat_topics WHERE project_id=$1 AND status='open' AND lower(title)=lower($2) LIMIT 1",[projectId,title]);
  const topic=existing.rows[0]??(await pool.query("INSERT INTO project_chat_topics(id,project_id,title) VALUES($1,$2,$3) RETURNING id,title,status",[randomUUID(),projectId,title])).rows[0];
  await pool.query(`INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id)
   SELECT $1,$2,'assistant',$3,'project','completed',$4
   WHERE NOT EXISTS(SELECT 1 FROM assistant_messages WHERE project_id=$2 AND topic_id=$4 AND channel='project')`,
   [randomUUID(),projectId,opening_message,topic.id]);
  return {topic,existing:!!existing.rowCount,awaiting_reply};
 }
 case 'discussions.close':
 case 'discussions.reopen':{
  const {topic_id}=z.object({topic_id:uuid}).parse(params);
  const status=name==='discussions.close'?'closed':'open';
  const updated=await pool.query("UPDATE project_chat_topics SET status=$3,closed_at=CASE WHEN $3='closed' THEN now() ELSE NULL END WHERE project_id=$1 AND id=$2 RETURNING id,title,status",[projectId,topic_id,status]);
  if(!updated.rowCount)throw rejected('Тема не найдена',404);
  return {topic:updated.rows[0]};
 }
 case 'pm.decisions.list':{
  return {decisions:(await pool.query('SELECT id,question,answer,iteration_id,order_id,created_at FROM project_pm_decisions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[projectId])).rows};
 }
 case 'pm.decisions.record':{
  const {source_message_id,question,answer,iteration_id,order_id}=z.object({
   source_message_id:uuid,question:z.string().trim().min(3).max(2000),answer:z.string().trim().min(1).max(5000),
   iteration_id:uuid.optional(),order_id:uuid.optional()
  }).parse(params);
  const source=(await pool.query("SELECT id,pm_order_id FROM assistant_messages WHERE id=$1 AND project_id=$2 AND role='user' AND channel='project'",[source_message_id,projectId])).rows[0];
  if(!source)throw rejected('Решение должно иметь подтверждённый исходный ответ владельца',409);
  const parent=order_id||source.pm_order_id||null;
  if(parent){
   const exists=await pool.query('SELECT 1 FROM project_pm_orders WHERE id=$1 AND project_id=$2',[parent,projectId]);
   if(!exists.rowCount)throw rejected('Поручение не найдено',404);
  }
  if(iteration_id){
   const valid=await pool.query('SELECT 1 FROM project_iterations WHERE id=$1 AND project_id=$2',[iteration_id,projectId]);
   if(!valid.rowCount)throw rejected('Итерация не найдена',404);
  }
  const id=randomUUID();
  const saved=await pool.query("INSERT INTO project_pm_decisions(id,project_id,order_id,source_message_id,iteration_id,question,answer) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,source_message_id,question) WHERE source_message_id IS NOT NULL DO NOTHING RETURNING id",
   [id,projectId,parent,source_message_id,iteration_id||null,question,answer]);
  let planning:{planning_run_id?:string;status?:string}|null=null;
  if(saved.rowCount&&iteration_id){
   await recordIterationDecision(pool,projectId,iteration_id,actorId,question,answer);
   planning=await queueIterationPlanning(pool,projectId,actorId,{iteration_id,request:'Перепроверь план с новым подтверждённым решением: '+question.slice(0,250)});
  }
  return {id:saved.rows[0]?.id||null,recorded:!!saved.rowCount,iteration_id:iteration_id||null,planning_run_id:planning?.planning_run_id,status:planning?.status};
 }
 case 'pm.orders.watch_task':{
  if(session.role!=='manager')throw rejected('Контроль целей доступен только ПМ',403);
  const {task_id}=z.object({task_id:uuid}).parse(params);
  const state=await readPmTaskGoal(pool,projectId,task_id);
  if(state.status==='missing')throw rejected('Задача не найдена',404);
  if(state.status==='done')return {...state,watch_registered:false};
  if(state.status!=='running')return {...state,watch_registered:false};
  // Only PM Inbox starts the existing Temporal watch workflow. A task-chat or
  // legacy session must not return "watching" without actually scheduling it.
  const inbox=!!session.process_id&&(await pool.query(`SELECT 1 FROM assistant_messages
   WHERE id=$1 AND project_id=$2 AND role='user' AND channel IN ('project','pm-internal')
    AND status='processing'`,[session.process_id,projectId])).rowCount;
  if(!inbox)return {...state,status:'needs_action',watch_registered:false,
   reason:'Долгосрочное наблюдение запускается из общего чата ПМа. В этом канале доступны только текущие действия без регистрации Temporal-watch.'};
  return {...state,status:'watching',watch_registered:true,watch_id:randomUUID()};
 }
 case 'pm.orders.list':{
  return {orders:(await pool.query("SELECT id,summary,status,topic_id,updated_at FROM project_pm_orders WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 40",[projectId])).rows};
 }
 case 'pm.orders.update':{
  const {order_id,status,summary}=z.object({order_id:uuid,status:z.enum(['working','waiting_agents','waiting_user','completed','failed']),summary:z.string().trim().max(1000).optional()}).parse(params);
  const result=await pool.query("UPDATE project_pm_orders SET status=$3,summary=COALESCE($4,summary),updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING id,status",[projectId,order_id,status,summary??null]);
  if(!result.rowCount)throw rejected('Поручение не найдено',404);
  await pool.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,'status',$3)",[randomUUID(),order_id,status+': '+(summary||'')]);
  return result.rows[0];
 }
  default:throw rejected('Неизвестный инструмент обсуждений ПМ',404);
 }
}

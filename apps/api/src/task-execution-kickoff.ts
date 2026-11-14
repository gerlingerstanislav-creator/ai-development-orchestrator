import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});

/**
 * Start is a durable PM-inbox turn, not a second workflow executor.
 * The PM chooses live MCP tools (direct action, one delegate or a DAG plan).
 * The existing inbox dispatcher and Temporal watchers own all retries and
 * resumptions, including recovery after an API restart.
 *
 * Must be called inside the caller's transaction while the tasks row is locked.
 */
export async function queueTaskExecutionKickoff(db:Db,input:{
 projectId:string;taskId:string;actorId:string;
}):Promise<{message_id:string;order_id:string;status:string;reused:boolean}>{
 const task=(await db.query(`SELECT t.id,t.title,t.description,t.type,t.stage,t.board_status,t.spec_version,
   t.postponed_at,t.archived_at,p.agents_running,COALESCE(ai.enabled,false) AS ai_enabled
   FROM tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
   LEFT JOIN project_ai_settings ai ON ai.project_id=p.id
   WHERE t.id=$1 AND t.project_id=$2 FOR UPDATE OF t`,[input.taskId,input.projectId])).rows[0];
 if(!task)throw conflict('Задача отсутствует или проект удалён');
 if(!['task','bug','improvement','epic'].includes(task.type))throw conflict('Этот тип задачи нельзя запускать из Kanban');
 if(task.archived_at||task.postponed_at||['done','acceptance'].includes(task.board_status)||task.stage==='done')
  throw conflict('Завершённую или отложенную задачу нельзя запустить');
 if(task.board_status!=='in_progress')throw conflict('Сначала переведи задачу в «В работе»');
 if(!task.ai_enabled)throw conflict('Включи AI в настройках проекта, чтобы PM сформировал план');
 if(!task.agents_running)throw conflict('Запусти агентов проекта, чтобы PM мог выполнить план');

 // The task ID is an idempotency key for the initial launch. Further changes
 // are planned by the same PM/order; no duplicate work graph on a second click.
 const previous=(await db.query(`SELECT id,status,pm_order_id
   FROM assistant_messages WHERE project_id=$1 AND task_id=$2
   AND pm_request_id=$2 AND channel='pm-internal' AND role='user'
   FOR UPDATE`,[input.projectId,input.taskId])).rows[0];
 if(previous){
  if(previous.status==='failed'){
   await db.query(`UPDATE assistant_messages SET status='queued',pm_dispatch_attempt=pm_dispatch_attempt+1,
    pm_dispatched_at=NULL,pm_next_dispatch_at=now()
    WHERE id=$1 AND status='failed'`,[previous.id]);
   if(previous.pm_order_id)await db.query(`UPDATE project_pm_orders SET status='queued',updated_at=now()
    WHERE id=$1`,[previous.pm_order_id]);
   await db.query(`INSERT INTO task_events(id,task_id,actor_id,event,detail)
    VALUES($1,$2,$3,'execution_kickoff_retried',$4)`,
    [randomUUID(),input.taskId,input.actorId,'Повторный запуск сохранённого поручения PM']);
   return {message_id:previous.id,order_id:previous.pm_order_id,status:'queued',reused:true};
  }
  return {message_id:previous.id,order_id:previous.pm_order_id,status:previous.status,reused:true};
 }
 const messageId=randomUUID(),orderId=randomUUID();
 const body=[
  'СИСТЕМНОЕ ПОРУЧЕНИЕ: владелец перевёл существующую задачу в «В работе».',
  'task_id='+input.taskId+'; spec_version='+task.spec_version+'.',
  'Цель: '+String(task.title).slice(0,300)+'.',
  'Прочитай актуальную задачу через tasks.read, её историю и связанные поручения work.list.',
  'Выбери МИНИМАЛЬНЫЙ достаточный путь из доступных возможностей: непосредственное действие PM, work.delegate либо work.plan с зависимостями. Не запускай все роли по порядку автоматически.',
  'Если требуется менять код, используй существующие безопасные механизмы разработки, независимого QA, PR и CI; не подменяй их одним отчётом исполнителя.',
  'Весь маршрут отслеживай через один текущий PM order и Temporal, ошибки разбирай по инструментам, а не переводом карточки на другие этапы.',
  'При блокировке зафиксируй конкретную причину. Не объявляй успех до подтверждённых артефактов и выполнения критериев. При необходимости согласования оставь задачу на приёмке.'
 ].join('\n');
 await db.query(`INSERT INTO assistant_messages(
  id,project_id,task_id,actor_id,role,body,channel,status,pm_request_id)
  VALUES($1,$2,$3,$4,'user',$5,'pm-internal','queued',$3)`,
  [messageId,input.projectId,input.taskId,input.actorId,body]);
 await db.query(`INSERT INTO project_pm_orders(
  id,project_id,actor_id,source_message_id,status,summary)
  VALUES($1,$2,$3,$4,'queued',$5)`,
  [orderId,input.projectId,input.actorId,messageId,'Выполнить задачу: '+String(task.title).slice(0,340)]);
 await db.query('UPDATE assistant_messages SET pm_order_id=$2 WHERE id=$1',[messageId,orderId]);
 await db.query(`INSERT INTO project_pm_order_events(id,order_id,kind,detail,process_id)
  VALUES($1,$2,'created',$3,$4)`,
  [randomUUID(),orderId,'Владелец запустил динамическое планирование задачи '+input.taskId,messageId]);
 await db.query(`INSERT INTO task_events(id,task_id,actor_id,event,detail)
  VALUES($1,$2,$3,'execution_kickoff',$4)`,
  [randomUUID(),input.taskId,input.actorId,'PM получил задачу на формирование плана; поручение '+orderId]);
 await db.query(`INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level,task_id)
  VALUES($1,$2,$3,'pm_inbox','queued',$4,'info',$5)`,
  [randomUUID(),input.projectId,messageId,'Планирование задачи '+String(task.title).slice(0,300),input.taskId]);
 return {message_id:messageId,order_id:orderId,status:'queued',reused:false};
}

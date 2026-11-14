import {randomUUID} from 'node:crypto';
import {composeAgentPrompt,recordAgentPrompt} from '../../../agent-prompt.js';
import {createAgentSession,finishAgentSession,agentSessionEffects} from '../../../agent-tools.js';
import {readChatImages} from '../../../chat-images.js';
import {conversationInstructions,resolveRoleAiSettings} from '../../../project-team.js';
import type {PmWatchReport} from './pm-watch-report.js';
import {PM_GOAL_POLICY,pmOrderStateFromResults} from '../../../pm-goal-policy.js';
import {buildPmConversationContext} from '../domain/pm-conversation-context.js';

// Derive infrastructure-provided DB port without coupling application code to pg.
type Pool=Parameters<typeof recordAgentPrompt>[0];
type ProjectManagerWatch=PmWatchReport;
type PmToolEvent={tool:string;result?:unknown};
type ActionOrder={
 projectId:string;messageId:string;actorId:string;topicId:string|null;
 summary:string;events:readonly PmToolEvent[];delegated?:boolean
};
type PmDiagnosticStage='turn_started'|'runner_request'|'runner_response'|'turn_completed'|'retry_scheduled'|'turn_failed';
type PmTurnPorts={
 ensureProjectManagerActionOrder:(db:Pick<Pool,'query'>,args:ActionOrder)=>Promise<string|null>;
 shouldCreateProjectManagerOrder:(events:readonly PmToolEvent[],delegated?:boolean)=>boolean;
 failProjectManagerInbox:(db:Pick<Pool,'query'>,projectId:string,messageId:string,attempt:number)=>Promise<void>;
 recordDiagnostic:(db:Pick<Pool,'query'>,args:{projectId:string;messageId:string;orderId:string|null;attempt:number;stage:PmDiagnosticStage;level:'info'|'warning'|'error';error?:unknown;statusCode?:number;sessionId:string|null;elapsedMs:number})=>Promise<void>;
};

/** One model turn with durable, transactional confirmation of effects.
 * Scheduling, HTTP routes and retry ownership remain in the PM inbox adapter.
 */
export function createProjectManagerTurnExecutor({
 ensureProjectManagerActionOrder,shouldCreateProjectManagerOrder,failProjectManagerInbox,recordDiagnostic
}:PmTurnPorts){
async function executeProjectManagerInbox(pool:Pool,projectId:string,messageId:string,runnerUrl:string,runnerKey:string,attempt=1):Promise<ProjectManagerWatch[]>{
 const startedAt=Date.now();
 const claim=await pool.query("UPDATE assistant_messages SET status='processing' WHERE id=$1 AND project_id=$2 AND channel IN ('project','pm-internal') AND role='user' AND pm_dispatch_attempt=$3 AND status IN ('queued','processing') RETURNING id,actor_id,body,reply_to,topic_id,pm_order_id,channel",[messageId,projectId,attempt]);
 if(!claim.rowCount)return [];
 const turn=claim.rows[0];
 const orderId:string|null=turn.pm_order_id??null;
 if(orderId)await pool.query("UPDATE project_pm_orders SET status='working',updated_at=now() WHERE id=$1",[orderId]);
 let sessionId:string|null=null;
 let watchers:ProjectManagerWatch[]=[];
 const audit=(stage:PmDiagnosticStage,level:'info'|'warning'|'error'='info',error?:unknown,statusCode?:number)=>
  recordDiagnostic(pool,{projectId,messageId,orderId,attempt,stage,level,error,statusCode,sessionId,elapsedMs:Date.now()-startedAt}).catch(()=>{});
 await audit('turn_started');
 try{
  // No project-wide task snapshots or chat history on each PM turn.
  // Current order and explicit reply are sufficient; tools provide everything else.
  const [configResult,projectResult,replyResult,topicResult,orderResult,eventResult,recentResult,goalsResult,decisionsResult]=await Promise.all([
   pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]),
   pool.query('SELECT name,description FROM projects WHERE id=$1',[projectId]),
   turn.reply_to?pool.query("SELECT role,body FROM assistant_messages WHERE project_id=$1 AND id=$2",[projectId,turn.reply_to]):Promise.resolve({rows:[]}),
   turn.topic_id?pool.query('SELECT title,status FROM project_chat_topics WHERE project_id=$1 AND id=$2',[projectId,turn.topic_id]):Promise.resolve({rows:[]}),
   orderId?pool.query('SELECT summary,status,topic_id FROM project_pm_orders WHERE project_id=$1 AND id=$2',[projectId,orderId]):Promise.resolve({rows:[]}),
   orderId?pool.query('SELECT kind,detail,process_id FROM project_pm_order_events WHERE order_id=$1 ORDER BY created_at DESC LIMIT 6',[orderId]):Promise.resolve({rows:[]}),
   !turn.reply_to?pool.query("SELECT role,left(body,450) AS body FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL AND channel='project' AND status='completed' AND id<>$2 AND ((topic_id=$3) OR ($3::uuid IS NULL AND topic_id IS NULL)) ORDER BY created_at DESC,id DESC LIMIT 6",[projectId,messageId,turn.topic_id||null]):Promise.resolve({rows:[]}),
   pool.query("SELECT id,objective,criteria,status,order_id FROM project_pm_goals WHERE project_id=$1 AND status<>'completed' ORDER BY updated_at DESC LIMIT 6",[projectId]),
   pool.query("SELECT question,answer FROM project_pm_decisions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 4",[projectId])
  ]);
  const config=await resolveRoleAiSettings(pool,projectId,'manager',configResult.rows[0]);
  if(!config?.enabled)throw Error('AI выключен в настройках проекта');
  const session=await createAgentSession(pool,projectId,turn.actor_id,'manager',messageId);
  sessionId=session.id;
  const instructions=await conversationInstructions(pool,projectId,'manager');
  const ownerQuestion=orderId?(await pool.query(
   "SELECT n.id,n.task_id,n.body,n.status FROM project_pm_order_events e JOIN task_agent_notes n ON n.id=e.process_id AND n.project_id=$2 WHERE e.order_id=$1 AND e.kind='owner_question' LIMIT 1",
   [orderId,projectId])).rows[0]:null;
  const images=await readChatImages(pool,projectId,messageId,'assistant');
  const durableContext=buildPmConversationContext(goalsResult.rows,decisionsResult.rows);
  const prompt=composeAgentPrompt({
   role:'Менеджер проекта AI Development Orchestrator. Один логический ПМ, независимые поручения.',
   objective:String(turn.body||'Изучи приложенные изображения'),
   tools:'MCP orchestrator: capabilities.list/describe для выбора инструментов, tasks.list/read/history и processes.list для фактов, pm.orders.list для состояния поручений. При конкретной цели запрашивай только относящиеся к ней данные, не загружай весь проект.',
   instructions:[
    instructions.slice(0,2800),
    PM_GOAL_POLICY,
    'Координируй работу специалистов; не подменяй аналитика, разработчика, QA или DevOps.',
    'Для принятой цели используй goals.plan(goal_id,task_id,steps): он атомарно свяжет все результаты с целью. Для работы вне принятой цели используй work.plan(task_id,steps) с произвольными зависимостями needs по ключам шагов; для одиночной работы — work.delegate. Сначала узнай разрешённые возможности через agents.capabilities(role). Если специалисту нужны дополнительные безопасные инструменты, назначь их в tools конкретного work.delegate или шага work.plan: права действуют только пока выполняется поручение. Не выдавай глобальных прав, секретов, обходов QA/CI, слияния или выкладки. Для статуса используй work.list, для реального результата work.review. Поручение не является PR, обходом QA или автоматическим закрытием самой задачи. Делегируй по смыслу и необходимым инструментам, а не по типу заявки. Когда нужен результат наблюдения существующего работающего интерфейса, используй специалиста с проверяемым браузерным исполнением (обычно testing), а не этап изменения кода. Подтверждай реальные browser-артефакты через work.artifacts и SHA, не считай текстовый отчёт скриншотом. Если исполнитель заблокирован отсутствующим безопасным инструментом, используй work.grant для того же поручения: предыдущие доказательства и история остаются. Если инструмент не может быть выдан, поручай среду соответствующему специалисту. Не запрашивай у пользователя секреты без необходимости.',
    'При просьбе подготовить или уточнить ТЗ передай вводные аналитику через documentation.prepare_spec. Для плана используй iterations.prepare_plan: аналитик обновляет текущие карточки и создаёт недостающие. Готовые задачи автоматически идут в разработку.',
    'Если запрос просто вопрос — отвечай без побочных изменений. При неизвестном факте используй адресное чтение.',
    'Различай удаление пустой карточки (tasks.delete) и безопасную отмену начатой задачи с PR (tasks.cancel). При отказе проверяй альтернативы и блокировки, а не прекращай поручение.',
    'Если поступило событие завершения, продолжи соответствующее поручение; новые вопросы ПМ оформляй через discussions.open, после ответа закрывай тему.',
    'Если аналитик попросил данные, сначала попробуй найти их в контексте проекта и документах. При наличии подтверждённых сведений вызови documentation.resume_spec с его job_id и ответом. Иначе спроси владельца в обсуждении; после ответа продолжи именно то же поручение через documentation.resume_spec, не запускай повторную подготовку с нуля.',
    orderId?'Текущее поручение: '+orderId+'.':'Новый ход чата: order_id отсутствует. При успешном действии поручение создаст backend. Не вызывай pm.orders.update без существующего order_id.',
    'Для повторного QA используй qa.retry после проверки текущих процессов. При неполном QA укажи, что не проверено. Для подробностей используй processes.list с process_id.',
    'Для возврата на анализ, адресного исправления существующего PR или повторного QA используй workflow.move_task с target_stage, source_message_id владельца и причиной. Не запускай работу с нуля, учитывай сохранённые результаты и новые комментарии. Статус merge_queue и последующие этапы устанавливают штатные проверки, а не ПМ вручную.',
    'При долговременной цели отслеживай полное выполнение, а не только запуск. Для отмены старой работы с PR используй tasks.cancel и затем создавай новую задачу лишь если владелец всё ещё этого хочет. При блокировках сначала ищи безопасный путь в рамках workflow, не отменяй обязательный QA/CI.',
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
    durableContext,
    recentResult.rows.length?'Короткий контекст текущего диалога: '+JSON.stringify(recentResult.rows.reverse()).slice(0,2200):'',
     images.length?'Приложены изображения: '+images.map(image=>image.name).join(', ')+'. Рассмотри их визуальное содержимое.':''
   ].filter(Boolean).join('\n\n'),
    output:'Отвечай по-русски естественно и прямо, как универсальный AI-помощник. На вопросы давай содержательный ответ без формального отчёта и без лишних действий. При поручении обозначь фактически достигнутый результат, оставшиеся шаги и ответственного; при блокировке предложи конкретные альтернативы. Никогда не выдавай запуск процесса за выполнение цели.'
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
   durableContext,
   images.length?'Приложены изображения: '+images.map(image=>image.name).join(', '):'',
   'Не пересказывай всю историю. При необходимости используй адресные MCP-инструменты; '+
    'сохранённые фоновые поручения отслеживаются Temporal, не ожидай их синхронно.'
  ].filter(Boolean).join('\n');
  await recordAgentPrompt(pool,{projectId,processId:orderId||messageId,role:'manager',operation:'pm_turn',prompt}).catch(()=>{});
  await audit('runner_request');
  const response=await fetch(runnerUrl+'/agent',{
   method:'POST',headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt,resume_prompt:resumePrompt,request_id:messageId,progress_attempt:attempt,actor_id:turn.actor_id,session_token:session.secret,agent_role:'manager',project_id:projectId,role_capacity:1,images}),
   signal:AbortSignal.timeout(255000)
  });
  const data=await response.json().catch(()=>({})) as any;
  await audit('runner_response',response.ok?'info':'warning',undefined,response.status);
  if(!response.ok||typeof data.message!=='string'||!data.message.trim())throw Error(('Runner HTTP '+response.status+': '+String(data.error||'ПМ не вернул ответ')).slice(0,700));
  const effects=await agentSessionEffects(pool,session.id);
  const toolEvents=await pool.query('SELECT tool,result FROM agent_tool_events WHERE project_id=$1 AND session_id=$2 AND success=true ORDER BY created_at,id',[projectId,session.id]);
  const seen=new Set<string>();
  const completedGoals=new Set(toolEvents.rows.filter(row=>row.tool==='goals.complete')
   .map(row=>row.result?.id).filter((id:unknown):id is string=>typeof id==='string'));
  const goalsWithLinkedWatch=new Set(toolEvents.rows.filter(row=>row.tool==='goals.link'&&row.result?.watch)
   .map(row=>row.result?.goal_id).filter((id:unknown):id is string=>typeof id==='string'));
  const effectiveTopicForWatch=turn.topic_id||toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string')||null;
  watchers=toolEvents.rows.flatMap(row=>{
   if(row.tool==='goals.open'&&row.result?.watch?.kind==='goal'){
    const watch=row.result.watch;
    if(typeof watch.process_id!=='string'||typeof watch.goal_id!=='string'||
       seen.has(watch.process_id)||completedGoals.has(watch.goal_id)||goalsWithLinkedWatch.has(watch.goal_id))return [];
    seen.add(watch.process_id);
    return [{projectId,processId:watch.process_id,kind:'goal' as const,
      goalId:watch.goal_id,orderId:orderId||undefined,
      topicId:effectiveTopicForWatch,actorId:turn.actor_id}];
   }
   if(row.tool==='goals.link'&&row.result?.watch){
    const watch=row.result.watch;
    if(!['task_goal','delegated_work'].includes(watch.kind)||typeof watch.process_id!=='string'||
       seen.has(watch.process_id))return [];
    seen.add(watch.process_id);
    return [{projectId,processId:watch.process_id,kind:watch.kind as 'task_goal'|'delegated_work',
      ...(watch.kind==='task_goal'?{taskId:watch.task_id}:{}),
      orderId:orderId||undefined,topicId:effectiveTopicForWatch,actorId:turn.actor_id}];
   }
   if(['work.plan','goals.plan'].includes(row.tool)&&Array.isArray(row.result?.assignments)){
    return row.result.assignments.flatMap((item:{id?:unknown;role?:unknown})=>{
     const id=item.id;
     if(typeof id!=='string'||seen.has(id))return [];
     seen.add(id);
     return [{projectId,processId:id,kind:'delegated_work' as const,
      orderId:orderId||undefined,topicId:effectiveTopicForWatch,actorId:turn.actor_id}];
    });
   }
   const kind:ProjectManagerWatch['kind']=row.tool==='pm.orders.watch_task'?'task_goal':
    (row.tool==='work.delegate'||row.tool==='work.grant'||(row.tool==='work.review'&&row.result?.status==='queued'))?'delegated_work':
    row.tool==='qa.retry'?'testing':row.tool==='iterations.launch'?'iteration_execution':
    ['iterations.prepare_plan','pm.decisions.record'].includes(row.tool)?'iteration_plan':
    row.tool==='workflow.approve_development'?'development':'document_import';
   const id=kind==='task_goal'?row.result?.watch_id:kind==='delegated_work'?row.result?.id:kind==='testing'?row.result?.cycle_id:
    kind==='iteration_execution'?row.result?.iteration_id:kind==='iteration_plan'?row.result?.planning_run_id:
    kind==='development'?row.result?.id:row.result?.import_job_id;
   if(typeof id!=='string'||seen.has(id))return [];
   seen.add(id);
   return [{projectId,processId:id,kind,
    ...(kind==='task_goal'?{taskId:row.result?.task_id}:{}),
    orderId:orderId||undefined,topicId:effectiveTopicForWatch,actorId:turn.actor_id}];
  });
  const openedTopic=toolEvents.rows.filter(row=>row.tool==='discussions.open').map(row=>row.result?.topic?.id).find((id:unknown)=>typeof id==='string');
  const effectiveTopic=turn.topic_id||openedTopic||null;
  const client=await pool.connect();
  let confirmedOrderId=orderId;
  try{
   await client.query('BEGIN');
   // Follow-up chat instructions that change one existing goal remain attached
   // to its original order, not an unrelated second PM assignment.
   if(!confirmedOrderId){
    const touchedGoals=[...new Set(toolEvents.rows
     .filter(row=>['goals.link','goals.plan','goals.update','goals.complete'].includes(row.tool))
     .map(row=>row.result?.goal_id||row.result?.id)
     .filter((id:unknown):id is string=>typeof id==='string'))];
    if(touchedGoals.length===1){
     const original=await client.query(`SELECT order_id FROM project_pm_goals
      WHERE project_id=$1 AND id=$2 AND order_id IS NOT NULL`,[projectId,touchedGoals[0]]);
     if(original.rowCount){
      confirmedOrderId=original.rows[0].order_id;
      await client.query('UPDATE assistant_messages SET pm_order_id=$2 WHERE project_id=$1 AND id=$3',
       [projectId,confirmedOrderId,messageId]);
     }
    }
   }
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
    // The goal can be opened before its order exists. Bind them atomically.
    await client.query(`UPDATE project_pm_goals SET order_id=$3,updated_at=now()
     WHERE project_id=$1 AND source_message_id=$2 AND order_id IS NULL`,
     [projectId,messageId,confirmedOrderId]);
    const hasOpenQuestion=toolEvents.rows.some(row=>row.tool==='iterations.ask_question'||row.tool==='discussions.open'&&row.result?.awaiting_reply===true);
    const explicitlySet=toolEvents.rows.some(row=>row.tool==='pm.orders.update'&&row.result?.id===confirmedOrderId);
    const touchedGoal=toolEvents.rows.some(row=>row.tool==='goals.complete');
    const questionOpen=ownerQuestion&&!!(await client.query("SELECT 1 FROM task_agent_notes WHERE id=$1 AND status IN ('open','processing')",[ownerQuestion.id])).rowCount;
    const initialStatus=pmOrderStateFromResults(toolEvents.rows,watchers.length,Boolean(questionOpen||hasOpenQuestion));
    const goalResult=await client.query(`SELECT id,status FROM project_pm_goals
     WHERE project_id=$1 AND order_id=$2 ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
     [projectId,confirmedOrderId]);
    const goalStatus=goalResult.rows[0]?.status as string|undefined;
    // A scheduled operation isn't success. Never close an accepted goal
    // until goals.complete has checked linked evidence.
    const status=goalStatus==='completed'?'completed':
     goalStatus
     ?goalStatus==='waiting_user'||goalStatus==='needs_action'?'waiting_user':
       watchers.length?'waiting_agents':'working'
     :initialStatus;
    if(!explicitlySet||status!=='completed'||ownerQuestion||touchedGoal)await client.query('UPDATE project_pm_orders SET status=$2,topic_id=COALESCE($3,topic_id),updated_at=now() WHERE id=$1',[confirmedOrderId,status,effectiveTopic]);
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
  await audit('turn_completed');
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
  const retryable=/busy|concurren|перегруз|несколько AI|лимит одноврем|исполнитель.{0,40}занят|429|503|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|AbortError/i.test(message);
  if(retryable){
   await pool.query(`WITH waiting AS (
    UPDATE assistant_messages SET status='queued' WHERE id=$1 AND pm_dispatch_attempt=$2
     AND status='processing' RETURNING pm_order_id
   ) UPDATE project_pm_orders o SET status='queued',updated_at=now() FROM waiting w WHERE o.id=w.pm_order_id`,
    [messageId,attempt]);
  }else await failProjectManagerInbox(pool,projectId,messageId,attempt);
  await audit(retryable?'retry_scheduled':'turn_failed',retryable?'warning':'error',error);
  if(!retryable)throw Object.assign(new Error(message.slice(0,650)),{nonRetryable:true});
  throw error;
 }finally{
  if(sessionId)await finishAgentSession(pool,sessionId).catch(()=>{});
 }
 return watchers;
}
 return executeProjectManagerInbox;
}

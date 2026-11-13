import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PENDING_OWNER_QUESTION_SQL} from '../../../task-question-gates.js';
import {preserveAcceptanceCriteria} from '../../../acceptance-criteria.js';

type AnalysisQueryResult={rows:any[];rowCount:number|null};
type AnalysisDatabase={query:(sql:string,values?:any[])=>Promise<AnalysisQueryResult>};
type AnalysisClient=AnalysisDatabase & {release:()=>void};
type AnalysisDependencies<TClient extends AnalysisClient>={
 pool:AnalysisDatabase & {connect:()=>Promise<TClient>};
 updateSpecification:(client:TClient,projectId:string,taskId:string,title:string,description:string)=>Promise<void>;
 taskHandoffContext:(projectId:string,taskId:string,stage:string)=>Promise<string>;
 assistantCompletion:(prompt:string,projectId:string,taskId:string,operation:string,processId?:string)=>Promise<string>;
 event:(projectId:string,processId:string,kind:string,stage:string,detail:string,level?:string)=>Promise<void>;
};

/** A short, side-effectful Temporal Activity delegate, not a new workflow or queue.
 * External services are supplied by the worker; SQL and transaction boundaries
 * remain exactly as before to preserve compatibility with running workflows.
 */
export function createTaskStageAnalysisActivity<TClient extends AnalysisClient>({pool,updateSpecification,taskHandoffContext,assistantCompletion,event}:AnalysisDependencies<TClient>){
const taskAnalysisResult=z.object({
 outcome:z.enum(['ready','needs_input']),
 summary:z.string().trim().min(8).max(1500),
 refined_description:z.string().trim().min(20).max(16000),
 questions:z.array(z.string().trim().min(5).max(650)).max(8).default([]),
 documentation_notes:z.array(z.string().trim().min(5).max(1000)).max(5).default([])
}).strict();
function parseTaskAnalysisResult(text:string){
 const cleaned=text.trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
 const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');
 if(start<0||end<start)throw Error('Аналитик не вернул структурированный результат');
 return taskAnalysisResult.parse(JSON.parse(cleaned.slice(start,end+1)));
}
/** A worker-owned task is analyzed once until it reaches an explicit result.
 * The analyst can hand off an approved specification without PM micromanagement.
 */
async function runTaskStageAnalysis(runId:string):Promise<void>{
 const run=(await pool.query("SELECT id,project_id,task_id,spec_version,status FROM agent_analysis_runs WHERE id=$1",[runId])).rows[0];
 if(!run||['completed','waiting','failed','cancelled'].includes(run.status))return;
 const active=await pool.query("UPDATE agent_analysis_runs SET status='running',updated_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING id,updated_at",[runId]);
 if(!active.rowCount)return;
 const {project_id:projectId,task_id:taskId}=run;
 try{
  const [record,history,ownerEvidence]=await Promise.all([
   pool.query("SELECT id,project_id,title,description,stage,analysis_state,clarification_questions,spec_review_status,spec_version,iteration_work_kind FROM tasks WHERE project_id=$1 AND id=$2",[projectId,taskId]),
   taskHandoffContext(projectId,taskId,'analysis'),
   pool.query(`SELECT kind,body,answer,answer_author FROM task_agent_notes
    WHERE project_id=$1 AND task_id=$2 AND
     ((kind='resolution' AND source_key LIKE 'owner-answer:%') OR
      (kind='question' AND status='answered' AND answer IS NOT NULL))
    ORDER BY created_at DESC LIMIT 10`,[projectId,taskId])
  ]);
  const task=record.rows[0];
  if(!task||task.stage!=='analysis'||task.spec_version!==run.spec_version||task.analysis_state!=='processing'){
   await pool.query("UPDATE agent_analysis_runs SET status='completed',message='Состояние задачи изменилось, старая работа пропущена',updated_at=now() WHERE id=$1",[runId]);
   return;
  }
  const instructions=(await pool.query("SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage='analysis'",[projectId])).rows[0];
  const prompt=[
   'Ты системный аналитик проекта. Задача находится в колонке «Анализ», и ты обязан закончить работу над ней.',
   'Уточни содержание именно задачи, используя документацию как справочный контекст. Не редактируй страницы проектного ТЗ, не ставь завершение документации условием разработки. Не придумывай продуктовые решения вместо владельца.',
   'Если обнаружено противоречие со старым ТЗ, укажи его в documentation_notes как неблокирующее замечание для будущего обновления документации. Продолжай работу по ясной задаче и решениям владельца. Вопрос задавай только когда без ответа невозможно однозначно определить реализацию.',
   'Если описание достаточно для разработки, верни outcome="ready", уточнённые требования и критерии именно этой задачи в refined_description, затем коротко передай её разработчику. Сохраняй все действующие критерии приёмки из постановки; не повторяй одинаковые критерии.',
   'Для технического вопроса сначала проверь доступные факты, используй MCP agents.consult с архитектором/разработчиком и blockers.report при настоящем ограничении. Неполадки Git, CI, Chromium, discovery supported tests и отсутствие доступа к внутренней конфигурации Runner — технические вопросы, а не продуктовые требования. Если ТЗ достаточно для реализации, outcome="ready" даже при открытой технической консультации; передай ограничение через историю задачи. Только если выбор пользовательского поведения реально неоднозначен, верни needs_input с коротким вопросом владельцу. Полное уточнение сохрани в refined_description, а в summary объясни результат в 1–3 предложениях.',
   'Не создавай новый функционал за пределами согласованного объёма. Если outcome="ready", questions должен быть пустым. Если needs_input, вопросы обязательны.',
   'Ответь ТОЛЬКО JSON: {"outcome":"ready|needs_input","summary":"...","refined_description":"...","questions":["..."],"documentation_notes":["неблокирующее расхождение или рекомендация"]}.',
   'Инструкции агента: '+String(instructions?.agent_instructions||'').slice(0,6000),
   'Задача: '+task.title+'\n'+task.description,
   'Последние сообщения и выполненная работа (новые вводные приоритетнее старых): '+history.slice(0,3100),
   'ПОДТВЕРЖДЁННЫЕ ОТВЕТЫ ВЛАДЕЛЬЦА ИЗ КАРТОЧКИ (используй их в первую очередь; не спрашивай повторно): '+JSON.stringify(ownerEvidence.rows.reverse().map((r:{kind:string;body:string;answer:string|null;answer_author:string|null})=>({question:r.kind==='question'?r.body:null,answer:r.answer||r.body,source:r.answer_author||'Владелец'}))).slice(0,3200),
   'Если сохранённый ответ относится к ранее заданному вопросу, проверь, достаточно ли его для выполнения. При полноте ответов верни ready; при реальной неоднозначности задай только недостающий вопрос.'
  ].join('\n\n');
  const output=parseTaskAnalysisResult(await assistantCompletion(prompt,projectId,taskId,'task_analysis',runId));
  if(output.outcome==='ready'&&output.questions.length)throw Error('Аналитик завершил задачу с неразрешёнными вопросами');
  if(output.outcome==='needs_input'&&!output.questions.length)throw Error('Аналитик запросил уточнение без вопроса');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const stillActive=await client.query("SELECT status FROM agent_analysis_runs WHERE id=$1 FOR UPDATE",[runId]);
   const latest=(await client.query("SELECT * FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE",[projectId,taskId])).rows[0];
   if(stillActive.rows[0]?.status==='cancelled'||!latest||latest.stage!=='analysis'||latest.analysis_state!=='processing'||(latest.title!==task.title||latest.description!==task.description)){
    await client.query("UPDATE agent_analysis_runs SET status='completed',message='Задача изменилась до сохранения результата',updated_at=now() WHERE id=$1 AND status<>'cancelled'",[runId]);
    await client.query('COMMIT');return;
   }
   // Comments submitted while the analyst was reading the earlier snapshot
   // must not be silently skipped. Requeue analysis and retain every message.
   const fresh=await client.query(`SELECT 1 FROM task_agent_notes n WHERE n.project_id=$1 AND n.task_id=$2
    AND n.source_kind='human' AND n.created_at>$3
    UNION ALL SELECT 1 FROM manager_messages m WHERE m.project_id=$1 AND m.task_id=$2
    AND m.role='user' AND m.created_at>$3
    UNION ALL SELECT 1 FROM assistant_messages m WHERE m.project_id=$1 AND m.task_id=$2
    AND m.role='user' AND m.created_at>$3 LIMIT 1`,[projectId,taskId,active.rows[0].updated_at]);
   if(fresh.rowCount){
    await client.query("UPDATE tasks SET analysis_state='new',updated_at=now() WHERE project_id=$1 AND id=$2",[projectId,taskId]);
    await client.query("UPDATE agent_analysis_runs SET status='completed',message='Получены новые комментарии. Пересмотр актуального ввода поставлен в очередь.',updated_at=now() WHERE id=$1",[runId]);
    await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_inputs_changed',$3)",[randomUUID(),taskId,'Новый комментарий поступил во время анализа. Следующий запуск учтёт его до разработки.']);
    await client.query('COMMIT');return;
   }
   if(output.outcome==='ready'){
    await updateSpecification(client,projectId,taskId,latest.title,preserveAcceptanceCriteria(latest.description,output.refined_description));
    const questions=await client.query(`SELECT 1 FROM task_agent_notes n WHERE n.task_id=$1 AND ${PENDING_OWNER_QUESTION_SQL} LIMIT 1`,[taskId]);
    if(questions.rowCount||latest.clarification_questions?.length){
     await client.query("UPDATE tasks SET analysis_state='waiting_questions',updated_at=now() WHERE id=$1",[taskId]);
    }else{
     await client.query("UPDATE tasks SET analysis_state='ready_for_development',updated_at=now() WHERE id=$1",[taskId]);
     await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_completed',$3)",[randomUUID(),taskId,output.summary]);
    }
    await client.query("INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status) VALUES($1,$2,$3,'analysis',$4,'development','handoff',$5,'agent',$6,'resolved') ON CONFLICT(task_id,source_key) DO NOTHING",
     [randomUUID(),projectId,taskId,instructions?.agent_name||'Системный аналитик',output.summary,'task-analysis:'+runId]);
   }else{
    await client.query("UPDATE tasks SET analysis_state='waiting_questions',updated_at=now() WHERE id=$1",[taskId]);
    for(let index=0;index<output.questions.length;index++){
     await client.query("INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status,requires_customer) VALUES($1,$2,$3,'analysis',$4,'all','question',$5,'agent',$6,'open',true) ON CONFLICT(task_id,source_key) DO NOTHING",
      [randomUUID(),projectId,taskId,instructions?.agent_name||'Системный аналитик',output.questions[index],'task-analysis:'+runId+':question:'+index]);
    }
    await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_blocked',$3)",[randomUUID(),taskId,'Аналитик запросил решения: '+output.questions.join('; ').slice(0,1200)]);
   }
   for(const [index,note] of output.documentation_notes.entries()){
    await client.query("INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status) VALUES($1,$2,$3,'analysis',$4,'documentation','observation',$5,'agent',$6,'resolved') ON CONFLICT(task_id,source_key) DO NOTHING",
     [randomUUID(),projectId,taskId,instructions?.agent_name||'Системный аналитик',note,'task-analysis:'+runId+':doc-note:'+index]);
   }
   await client.query("UPDATE agent_analysis_runs SET status=$2,message=$3,updated_at=now() WHERE id=$1",[runId,output.outcome==='ready'?'completed':'waiting',output.summary]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await event(projectId,runId,'analysis',output.outcome==='ready'?'completed':'waiting',output.summary);
 }catch(error){
  const message=String(error).slice(0,650);
  await pool.query("UPDATE agent_analysis_runs SET status='failed',message=$2,updated_at=now() WHERE id=$1 AND status IN ('queued','running')",[runId,message]);
  await pool.query("UPDATE tasks SET analysis_state='failed',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='analysis' AND analysis_state='processing' AND spec_version=$3 AND EXISTS(SELECT 1 FROM agent_analysis_runs WHERE id=$4 AND status='failed')",[taskId,projectId,run.spec_version,runId]);
  await event(projectId,runId,'analysis','failed',message,'error');
 }
}


 return runTaskStageAnalysis;
}

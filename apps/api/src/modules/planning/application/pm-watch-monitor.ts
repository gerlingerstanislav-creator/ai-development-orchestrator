import {reportPmWatchCompletion,type PmWatchReport} from './pm-watch-report.js';
import {readPmTaskGoal} from '../../../pm-task-goal.js';

type ProjectManagerWatch=PmWatchReport;
/** The watch application needs only scoped reads and a transactional writer. */
type Pool=Parameters<typeof reportPmWatchCompletion>[0] & {
 query:(sql:string,values?:any[])=>Promise<{rows:any[];rowCount:number|null}>;
};

/** Project-scoped, read-only process projection followed by an exactly-once
 * transactional PM report. Temporal owns the durable poll/wait lifecycle.
 */
async function reportIterationExecutionWatch(pool:Pool,watch:ProjectManagerWatch,total:number,finished:number,stale:number):Promise<'completed'>{
 const message='Обработка очереди итерации завершена: '+finished+' из '+total+'.'+
  (stale?' Запуск '+stale+' задач требует повторного подтверждения.':'')+
  ' Проверь результаты и сообщи владельцу.';
 return reportPmWatchCompletion(pool,watch,{message,resumeInstruction:''});
}

/** Polling is a short database activity; the waiting happens in Temporal,
 * not in the PM AI session or an HTTP request. */
export async function checkProjectManagerWatch(pool:Pool,watch:ProjectManagerWatch):Promise<'pending'|'completed'>{
 if(watch.kind==='task_goal'){
  if(!watch.taskId)return 'completed';
  const task=await readPmTaskGoal(pool,watch.projectId,watch.taskId);
  if(task.status==='running')return 'pending';
  const name=task.display_number?'#'+task.display_number+' «'+task.title+'»':'«'+task.title+'»';
  const message=task.status==='done'?'Цель достигнута: задача '+name+' прошла все этапы и имеет подтверждённый done.':
   task.status==='missing'?'Контролируемая задача отсутствует. Проверь историю отмены и исходное поручение.':
   'Цель пока не достигнута: задача '+name+' остановилась на этапе '+task.stage+'. '+task.reason;
  return reportPmWatchCompletion(pool,watch,{message,
   resumeInstruction:task.status==='done'?' Проверь связанные поручения и заверши исходную цель.':
    ' Это не успех. Проверь состояние и блокировки, делегируй допустимое исправление или задай владельцу конкретный вопрос. Не регистрируй тот же watch_task до изменения состояния или запуска новой работы.'});
 }
 if(watch.kind==='delegated_work'){
  const assignment=(await pool.query(`SELECT a.status,a.result,a.evidence,a.role,a.objective,
   t.title AS task_title,t.display_number
   FROM agent_work_assignments a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
   WHERE a.project_id=$1 AND a.id=$2`,[watch.projectId,watch.processId])).rows[0];
  if(!assignment)return reportPmWatchCompletion(pool,watch,{
   message:'Поручение агенту больше недоступно. Проверь исходную задачу и историю.',
   resumeInstruction:' Не считать неизвестное поручение завершённым.'});
  if(['queued','running'].includes(assignment.status))return 'pending';
  const message='Поручение '+assignment.role+' по задаче #'+assignment.display_number+
   ' «'+assignment.task_title+'» завершило попытку со статусом '+assignment.status+
   '. Цель: '+assignment.objective+'. Результат: '+String(assignment.result||'нет подтверждения').slice(0,1400)+
   '. Доказательства: '+String(assignment.evidence||'не представлены').slice(0,900);
  return reportPmWatchCompletion(pool,watch,{message,
   resumeInstruction:assignment.status==='submitted'
    ?' Прочитай work.list и проверь представленные доказательства, затем work.review(accept или retry). Принятие поручения не означает закрытие самой задачи.'
    :' Это не успех. Прочитай work.list и blockers.list, устрани блокировку или запроси решение владельца. Не объявляй выполнение только по тексту агента.'});
 }
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

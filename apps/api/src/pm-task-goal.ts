type Db={query:(sql:string,values?:any[])=>Promise<{rows:any[]}>};
export type PmTaskGoalState={
 task_id:string; title:string;display_number:number|null;stage:string;analysis_state:string;
 status:'running'|'needs_action'|'done'|'missing';reason:string;
};
/** Facts shared by MCP and Temporal. Never infer workflow success from a queued
 * command or a previous QA report. A PM watch only waits while work is active. */
export async function readPmTaskGoal(db:Db,projectId:string,taskId:string):Promise<PmTaskGoalState>{
 const task=(await db.query(`SELECT id,title,display_number,stage,board_status,analysis_state,type
  FROM tasks WHERE id=$1 AND project_id=$2`,[taskId,projectId])).rows[0];
 if(!task)return {task_id:taskId,title:'',display_number:null,stage:'',analysis_state:'',
  status:'missing',reason:'Задача отсутствует: проверь, не была ли отменена'};
 if(task.stage==='done'&&task.board_status==='acceptance')return {
  task_id:taskId,title:task.title,display_number:task.display_number,
  stage:task.stage,analysis_state:task.analysis_state,status:'needs_action',
  reason:'Техническое выполнение завершено; задача ожидает явной приёмки владельцем'
 };
 if(task.stage==='done')return {task_id:taskId,title:task.title,display_number:task.display_number,
  stage:task.stage,analysis_state:task.analysis_state,status:'done',reason:'Этап done подтверждён в БД'};
 if(!['task','bug','improvement'].includes(task.type))return {task_id:taskId,title:task.title,display_number:task.display_number,
  stage:task.stage,analysis_state:task.analysis_state,status:'needs_action',
  reason:'Эпик/вопрос не проходит отдельный workflow: контролируй дочерние задачи'};
 const activity=(await db.query(`SELECT
  EXISTS(SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND project_id=$2 AND state='active')
  OR EXISTS(SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM ai_test_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM agent_analysis_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM requirement_review_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  -- A specialist assignment is real work even when it does not create a PR or QA run.
  -- Submitted/blocked work needs PM review, not an infinite 'running' indicator.
  OR EXISTS(SELECT 1 FROM agent_work_assignments WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  AS active`,[taskId,projectId])).rows[0]?.active===true;
 return {task_id:taskId,title:task.title,display_number:task.display_number,
  stage:task.stage,analysis_state:task.analysis_state,
  status:activity?'running':'needs_action',
  reason:activity?'Выполнение продолжается: наблюдай через Temporal':
   'Задача ещё не завершена и сейчас не выполняется активный процесс. Проверь блокировки и инициируй разрешённый следующий этап или запроси необходимое решение'};
}

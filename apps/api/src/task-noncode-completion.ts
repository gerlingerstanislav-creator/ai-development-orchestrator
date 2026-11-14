import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;
const blocked=(reason:string)=>Object.assign(new Error(reason),{statusCode:409});

/**
 * The only shortcut through the legacy technical-stage machine is a proven
 * NON-CODE outcome. This is not another scheduler: every deliverable was
 * produced by an existing scoped assignment and accepted via work.review.
 *
 * Code changes, PR/CI/deploy and browser screenshot QA must keep their
 * established workflows. No stage jumps are allowed for those tasks.
 * Called with the existing MCP transactional DB handle.
 */
export async function completeNonCodeTask(db:Db,input:{
 projectId:string;taskId:string;actorId:string;
 kind:'research'|'documentation';summary:string;evidence:string;
}){
 const t=(await db.query(`SELECT id,type,stage,board_status,acceptance_mode,spec_version,git_branch,pr_url,
  implementation_commit,execution_mode,postponed_at,archived_at
  FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE`,[input.projectId,input.taskId])).rows[0];
 if(!t)throw blocked('Задача не найдена');
 if(t.stage==='done'){
  const completed=(await db.query(`SELECT 1 FROM task_events WHERE task_id=$1 AND event='noncode_completed' LIMIT 1`,[input.taskId]));
  if(completed.rowCount)return {task_id:input.taskId,status:'existing',board_status:t.board_status};
  throw blocked('Задача уже завершена другим техническим маршрутом');
 }
 if(t.type!=='task'||!['backlog','analysis'].includes(t.stage)||t.board_status!=='in_progress'||t.postponed_at||t.archived_at)
  throw blocked('Нельзя завершить этот тип работы без подтверждённого технического workflow');
 if(t.git_branch||t.pr_url||t.implementation_commit||t.execution_mode==='browser_evidence')
  throw blocked('Для кода, PR и браузерных снимков обязателен штатный QA/PR/CI маршрут');

 const legacy=await db.query(`SELECT
  EXISTS(SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND project_id=$2 AND state='active')
  OR EXISTS(SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND project_id=$2)
  OR EXISTS(SELECT 1 FROM ai_test_runs WHERE task_id=$1 AND project_id=$2)
  OR EXISTS(SELECT 1 FROM agent_analysis_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM requirement_review_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  AS legacy_work`,[input.taskId,input.projectId]);
 if(legacy.rows[0]?.legacy_work)throw blocked('Существует кодовая разработка, QA или незавершённая проверка: не обходи существующий workflow');

 const assignments=await db.query(`SELECT id,role,status,result,evidence,spec_version,reviewer_note
  FROM agent_work_assignments WHERE task_id=$1 AND project_id=$2 ORDER BY created_at,id FOR SHARE`,
  [input.taskId,input.projectId]);
 if(!assignments.rowCount)throw blocked('Нет поручений с подтверждёнными результатами');
 for(const a of assignments.rows){
  if(a.spec_version!==t.spec_version)throw blocked('Есть поручения от устаревшей версии задачи');
  if(['development','devops'].includes(a.role))
   throw blocked('Требуется полноценная разработка или выкладка: независимую QA/PR проверку нельзя пропустить');
  if(a.status!=='completed'||String(a.result||'').trim().length<20||
     String(a.evidence||'').trim().length<12||String(a.reviewer_note||'').trim().length<12)
   throw blocked('Все поручения должны быть завершены и приняты PM с доказательствами; незавершённые или заблокированные шаги нельзя пропустить');
 }
 if(input.summary.trim().length<20||input.evidence.trim().length<20)
  throw blocked('Для завершения нужны конкретный итог и подтверждённые доказательства');
 const detail=JSON.stringify({kind:input.kind,summary:input.summary.slice(0,1000),
  evidence:input.evidence.slice(0,1200),assignments:assignments.rows.map(x=>x.id)});
 await db.query(`INSERT INTO task_events(id,task_id,actor_id,event,detail)
  VALUES($1,$2,$3,'noncode_completed',$4)`,
  [randomUUID(),input.taskId,input.actorId,detail.slice(0,2300)]);
 // Existing database triggers already transfer technical done to either
 // owner acceptance or owner-approved automatic done. Preserve their semantics.
 const updated=await db.query(`UPDATE tasks SET stage='done',updated_at=now()
  WHERE id=$1 AND project_id=$2 RETURNING id,stage,board_status,acceptance_mode`,
  [input.taskId,input.projectId]);
 await db.query(`INSERT INTO process_events(
  id,project_id,process_id,process_kind,stage,detail,level,task_id)
  VALUES($1,$2,$3,'agent','completed',$4,'info',$5)`,
  [randomUUID(),input.projectId,input.taskId,'ПМ подтвердил результат без изменения кода: '+input.summary.slice(0,850),input.taskId]);
 return {task_id:input.taskId,status:'completed',board_status:updated.rows[0].board_status,
  acceptance_mode:updated.rows[0].acceptance_mode,verified_assignments:assignments.rowCount};
}

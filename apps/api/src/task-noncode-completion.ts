import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;
const blocked=(reason:string)=>Object.assign(new Error(reason),{statusCode:409});

/**
 * The only shortcut through the legacy technical-stage machine is a proven
 * NON-CODE outcome. This is not another scheduler: every deliverable was
 * produced by an existing scoped assignment and accepted via work.review.
 *
 * Code changes and established QA/PR/deployment pipelines stay gated.
 * A simple browser-capture deliverable MAY finish without a separate QA role,
 * but only after a trusted browser bridge stored distinct desktop + mobile
 * screenshots from the same pinned source and the PM accepted the assignment.
 * Called with the existing MCP transactional DB handle.
 */
export async function completeNonCodeTask(db:Db,input:{
 projectId:string;taskId:string;actorId:string;
 kind:'research'|'documentation'|'screenshots';summary:string;evidence:string;
}){
 const t=(await db.query(`SELECT id,type,stage,board_status,acceptance_mode,spec_version,git_branch,pr_url,
  implementation_commit,execution_mode,evidence_source_sha,postponed_at,archived_at
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
  throw blocked('Для изменения кода, PR и уже запущенного browser QA обязателен штатный технический маршрут');

 const legacy=await db.query(`SELECT
  EXISTS(SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND project_id=$2 AND state='active')
  OR EXISTS(SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND project_id=$2)
  OR EXISTS(SELECT 1 FROM ai_test_runs WHERE task_id=$1 AND project_id=$2)
  OR EXISTS(SELECT 1 FROM agent_analysis_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM requirement_review_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','running'))
  AS legacy_work`,[input.taskId,input.projectId]);
 if(legacy.rows[0]?.legacy_work)throw blocked('Существует кодовая разработка, QA или незавершённая проверка: не обходи существующий workflow');
 const artifacts=await db.query(`SELECT a.id,a.assignment_id,a.source_sha,a.sha256,a.origin,
   a.mime,a.viewport,w.role,w.spec_version,w.status
  FROM agent_work_artifacts a
  JOIN agent_work_assignments w ON w.id=a.assignment_id AND w.project_id=a.project_id
  WHERE a.task_id=$1 AND a.project_id=$2
  ORDER BY a.created_at`,[input.taskId,input.projectId]);
 if(input.kind!=='screenshots'&&artifacts.rowCount)
  throw blocked('Снимки экрана нельзя выдавать за документальный или исследовательский результат');
 if(input.kind==='screenshots'){
  if(!artifacts.rowCount||artifacts.rows.length<2)
   throw blocked('Для результата нужны настоящие desktop- и mobile-скриншоты из browser bridge');
  const sha=String(artifacts.rows[0].source_sha).trim().toLowerCase();
  if(!artifacts.rows.every(a=>String(a.source_sha).trim().toLowerCase()===sha &&
    a.origin==='isolated-local-browser'&&a.mime==='image/jpeg'&&a.spec_version===t.spec_version))
   throw blocked('Снимки не подтверждены одной актуальной ревизией браузерного исполнителя');
  if(t.evidence_source_sha&&String(t.evidence_source_sha).toLowerCase()!==sha)
   throw blocked('Скриншоты сделаны не из закреплённой в задаче ревизии исходников');
  if(!artifacts.rows.some(a=>Number(a.viewport?.width)>=900)||
     !artifacts.rows.some(a=>Number(a.viewport?.width)<=600))
   throw blocked('Требуются два реальных изображения: desktop (>=900px) и mobile (<=600px)');
  if(!artifacts.rows.some(a=>a.role==='documentation'&&a.status==='completed'))
   throw blocked('Браузерное поручение должно быть выполнено и принято ПМ; отдельный QA для снимков не нужен');
 }

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
  evidence:input.evidence.slice(0,1200),assignments:assignments.rows.map(x=>x.id),artifacts:artifacts.rows.map(x=>x.id)});
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
  acceptance_mode:updated.rows[0].acceptance_mode,verified_assignments:assignments.rowCount,verified_screenshots:artifacts.rows.map(x=>({id:x.id,sha256:x.sha256,source_sha:String(x.source_sha).trim()}))};
}

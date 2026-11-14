import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;

/**
 * An execution assignment is the boundary between planning and doing.
 *
 * All task-scoped schedulers ultimately insert a durable run or assignment.
 * Promote its card BEFORE that insert (same transaction), independently of
 * the old workflow stage. This also covers PM -> work.delegate and work.plan
 * without inventing an alternative orchestration engine.
 *
 * The trigger never changes tasks.stage, QA/PR gates or a PM goal with no task.
 */
export async function installTaskWorkBoardActivation(db:Db):Promise<void>{
 await db.query(`CREATE OR REPLACE FUNCTION ado_activate_board_before_task_work()
 RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE
  current_task record;
  promoted uuid;
 BEGIN
  IF NEW.task_id IS NULL OR NEW.status NOT IN ('queued','running','submitted','blocked','waiting','processing','dispatching')
   THEN RETURN NEW;
  END IF;
  SELECT stage,board_status,postponed_at,archived_at
   INTO current_task
   FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id FOR UPDATE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Задача отсутствует в проекте'
    USING ERRCODE='23503';
  END IF;
  IF current_task.postponed_at IS NOT NULL OR current_task.archived_at IS NOT NULL
    OR current_task.stage='done' OR current_task.board_status IN ('acceptance','done') THEN
   RAISE EXCEPTION 'Задача отложена или завершена: сначала верни её в работу'
    USING ERRCODE='23514';
  END IF;
  UPDATE tasks
    SET board_status='in_progress',updated_at=now()
    WHERE id=NEW.task_id AND project_id=NEW.project_id
     AND board_status IN ('backlog','todo')
    RETURNING id INTO promoted;
  IF promoted IS NOT NULL THEN
   INSERT INTO task_events(id,task_id,event,detail)
    VALUES(gen_random_uuid(),NEW.task_id,'board_activated_by_work',
     'В работе: поставлено поручение '+TG_TABLE_NAME+'. Подробности в Центре процессов.');
  END IF;
  RETURN NEW;
 END $$`);
 const queues=[
  'agent_work_assignments','agent_analysis_runs','ai_task_runs','ai_test_runs',
  'task_evidence_runs','requirement_review_runs','agent_peer_queue'
 ];
 for(const queue of queues){
  await db.query(`CREATE TRIGGER ado_activate_board_${queue}_insert
   BEFORE INSERT ON ${queue} FOR EACH ROW
   EXECUTE FUNCTION ado_activate_board_before_task_work()`);
  await db.query(`CREATE TRIGGER ado_activate_board_${queue}_status
   BEFORE UPDATE OF status ON ${queue} FOR EACH ROW
   WHEN (NEW.status IS DISTINCT FROM OLD.status)
   EXECUTE FUNCTION ado_activate_board_before_task_work()`);
 }
 // Upgrade historical drift in place. Do not touch deliberately postponed,
 // archived or already accepted cards. Historical QA/PR data stays unchanged.
 await db.query(`UPDATE tasks t SET board_status='in_progress',updated_at=now()
 WHERE t.board_status IN ('backlog','todo') AND t.stage<>'done'
  AND t.postponed_at IS NULL AND t.archived_at IS NULL
  AND (
   EXISTS(SELECT 1 FROM agent_work_assignments a WHERE a.task_id=t.id
    AND a.project_id=t.project_id AND a.status<>'cancelled')
   OR EXISTS(SELECT 1 FROM agent_analysis_runs a WHERE a.task_id=t.id
    AND a.project_id=t.project_id AND a.status<>'cancelled')
   OR EXISTS(SELECT 1 FROM ai_task_runs a WHERE a.task_id=t.id AND a.project_id=t.project_id
    AND a.status<>'cancelled')
   OR EXISTS(SELECT 1 FROM ai_test_runs a WHERE a.task_id=t.id AND a.project_id=t.project_id
    AND a.status<>'cancelled')
   OR EXISTS(SELECT 1 FROM task_evidence_runs a WHERE a.task_id=t.id
    AND a.project_id=t.project_id AND a.status<>'cancelled')
   OR EXISTS(SELECT 1 FROM requirement_review_runs a WHERE a.task_id=t.id
    AND a.project_id=t.project_id AND a.status<>'cancelled')
   OR EXISTS(SELECT 1 FROM agent_peer_queue a WHERE a.task_id=t.id
    AND a.project_id=t.project_id AND a.status<>'completed')
   OR EXISTS(SELECT 1 FROM assistant_messages m WHERE m.task_id=t.id
    AND m.project_id=t.project_id AND m.channel='pm-internal'
    AND m.pm_request_id=t.id AND m.status IN ('queued','processing'))
  )`);
}

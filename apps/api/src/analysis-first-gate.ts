import type {Pool} from 'pg';
import {PENDING_OWNER_QUESTION_SQL} from './task-question-gates.js';

/**
 * Defense-in-depth: a task cannot enter its first development stage while
 * analysis/owner decisions are pending. Enforced for every route, including
 * Temporal, manual actions and agent tools. QA->development rework is allowed.
 */
export async function initAnalysisFirstGate(db:Pick<Pool,'query'>):Promise<void>{
 await db.query(`
 CREATE OR REPLACE FUNCTION ado_analysis_first_guard() RETURNS trigger AS $$
 BEGIN
  IF NEW.type IN ('task','bug','improvement') AND NEW.stage='development'
   AND (TG_OP='INSERT' OR OLD.stage IS DISTINCT FROM NEW.stage) THEN
   IF TG_OP='INSERT' OR OLD.stage IN ('backlog','analysis') THEN
    IF NEW.analysis_state <> 'approved' THEN
     RAISE EXCEPTION 'Аналитик не завершил уточнение требований до разработки' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
     SELECT 1 FROM task_events e WHERE e.task_id=NEW.id AND e.event IN ('analysis_completed','analysis_reused_by_owner')
    ) AND NOT EXISTS (
     SELECT 1 FROM agent_analysis_runs r WHERE r.task_id=NEW.id AND r.status='completed'
    ) THEN
     RAISE EXCEPTION 'Нет подтверждённого завершённого анализа задачи' USING ERRCODE='23514';
    END IF;
   END IF;
   IF COALESCE(jsonb_array_length(NEW.clarification_questions),0)>0
    OR EXISTS (
     SELECT 1 FROM task_agent_notes n
     WHERE n.project_id=NEW.project_id AND n.task_id=NEW.id
      AND ${PENDING_OWNER_QUESTION_SQL}
    ) THEN
    RAISE EXCEPTION 'Нельзя начать разработку: есть неотвеченные вопросы к владельцу' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NEW;
 END;
 $$ LANGUAGE plpgsql;
 -- Legacy planner-ready cards without an analyst outcome must be re-analysed.
 UPDATE tasks t SET analysis_state='new',updated_at=now()
 WHERE t.type IN ('task','bug','improvement') AND t.stage='analysis'
  AND t.analysis_state='ready_for_development'
  AND NOT EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=t.id AND e.event IN ('analysis_completed','analysis_reused_by_owner'))
  AND NOT EXISTS(SELECT 1 FROM agent_analysis_runs a WHERE a.task_id=t.id AND a.status='completed');
 DROP TRIGGER IF EXISTS trg_ado_analysis_first_guard ON tasks;
 CREATE TRIGGER trg_ado_analysis_first_guard
 BEFORE INSERT OR UPDATE OF stage,analysis_state ON tasks
 FOR EACH ROW EXECUTE FUNCTION ado_analysis_first_guard();
 `);
}

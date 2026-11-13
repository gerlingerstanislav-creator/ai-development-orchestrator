import type {Pool} from 'pg';

/**
 * An epic follows its least advanced child. This database invariant covers
 * Temporal, manual transitions, imports and future task APIs automatically.
 */
/** One-time database enforcement; installed by append-only migration v11. */
export async function installEpicStageSync(db:Pick<Pool,'query'>):Promise<void>{
 await db.query(`
 CREATE OR REPLACE FUNCTION ado_sync_epic_stage() RETURNS trigger AS $$
 DECLARE old_parent uuid; new_parent uuid;
 BEGIN
  IF TG_OP = 'INSERT' THEN new_parent := NEW.parent_id;
  ELSIF TG_OP = 'DELETE' THEN old_parent := OLD.parent_id;
  ELSE old_parent := OLD.parent_id; new_parent := NEW.parent_id;
  END IF;
  WITH impacted AS (
   SELECT DISTINCT x.id FROM (VALUES (old_parent),(new_parent)) AS x(id) WHERE x.id IS NOT NULL
  ), slowest AS (
   SELECT c.parent_id,
    (array_agg(c.stage ORDER BY CASE c.stage
     WHEN 'backlog' THEN 0 WHEN 'analysis' THEN 1 WHEN 'development' THEN 2
     WHEN 'testing' THEN 3 WHEN 'merge_queue' THEN 4 WHEN 'deployment' THEN 5
     WHEN 'documentation' THEN 6 WHEN 'done' THEN 7 ELSE 0 END,c.id))[1] AS stage
   FROM tasks c JOIN impacted i ON i.id=c.parent_id
   WHERE c.type <> 'question' GROUP BY c.parent_id
  )
  UPDATE tasks p SET stage=s.stage,updated_at=now()
  FROM slowest s WHERE p.id=s.parent_id AND p.type='epic'
   AND p.stage IS DISTINCT FROM s.stage;
  RETURN NULL;
 END;
 $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS trg_ado_epic_stage_sync ON tasks;
 CREATE TRIGGER trg_ado_epic_stage_sync AFTER INSERT OR UPDATE OF stage,parent_id,type OR DELETE ON tasks
 FOR EACH ROW EXECUTE FUNCTION ado_sync_epic_stage();

 `);
}

/** Idempotent migration of legacy rows, executed only during schema adoption. */
export async function backfillLegacyEpicStages(db:Pick<Pool,'query'>):Promise<void>{
 await db.query(`
 -- Align existing data, including nested epics, with real child progress.
 WITH slowest AS (
  SELECT c.parent_id,
   (array_agg(c.stage ORDER BY CASE c.stage
    WHEN 'backlog' THEN 0 WHEN 'analysis' THEN 1 WHEN 'development' THEN 2
    WHEN 'testing' THEN 3 WHEN 'merge_queue' THEN 4 WHEN 'deployment' THEN 5
    WHEN 'documentation' THEN 6 WHEN 'done' THEN 7 ELSE 0 END,c.id))[1] AS stage
  FROM tasks c WHERE c.parent_id IS NOT NULL AND c.type <> 'question'
  GROUP BY c.parent_id
 )
 UPDATE tasks p SET stage=s.stage,updated_at=now()
 FROM slowest s WHERE p.id=s.parent_id AND p.type='epic'
 AND p.stage IS DISTINCT FROM s.stage;
 `);
}

/** Compatibility helper for isolated old tests, not invoked during API startup. */
export async function initEpicStageSync(db:Pick<Pool,'query'>):Promise<void>{
 await installEpicStageSync(db);
 await backfillLegacyEpicStages(db);
}


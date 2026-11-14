import type {Pool} from 'pg';

/**
 * Product-level task lifecycle is intentionally independent from the
 * implementation stage. Temporal and legacy QA/PR activities continue to own
 * tasks.stage, while Kanban reads tasks.board_status.
 */
export const BOARD_STATES=['backlog','todo','in_progress','acceptance','done'] as const;
export type BoardState=typeof BOARD_STATES[number];
export const ACCEPTANCE_MODES=['undecided','manual','automatic'] as const;
export type AcceptanceMode=typeof ACCEPTANCE_MODES[number];

export function boardStateForStage(stage:string,mode:AcceptanceMode='undecided'):BoardState{
 if(stage==='backlog')return 'backlog';
 if(stage==='done')return mode==='automatic'?'done':'acceptance';
 return 'in_progress';
}
export function canPlanBoardMove(stage:string,current:BoardState,target:BoardState):boolean{
 if(target===current)return true;
 if(!['backlog','todo','in_progress'].includes(target))return false;
 // This is planning, not permission to skip code/QA/PR gates. Execution
 // states can only be changed by their existing workflow commands.
 return stage==='backlog'&&['backlog','todo','in_progress'].includes(current);
}

export async function installUniversalTaskBoardSchema(db:Pick<Pool,'query'>):Promise<void>{
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_status text NOT NULL DEFAULT 'backlog'`);
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acceptance_mode text NOT NULL DEFAULT 'undecided'`);
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS accepted_at timestamptz`);
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES users(id) ON DELETE SET NULL`);
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acceptance_feedback text`);
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS postponed_at timestamptz`);
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS postponed_until date`);
 await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
 await db.query(`ALTER TABLE tasks ADD CONSTRAINT tasks_board_status_check
  CHECK(board_status IN ('backlog','todo','in_progress','acceptance','done'))`);
 await db.query(`ALTER TABLE tasks ADD CONSTRAINT tasks_acceptance_mode_check
  CHECK(acceptance_mode IN ('undecided','manual','automatic'))`);
 // This is an additive migration: legacy done tasks must not suddenly demand
 // another human sign-off. They keep their existing outcome and history.
 await db.query(`UPDATE tasks SET board_status=CASE
   WHEN stage='done' THEN 'done'
   WHEN stage='backlog' THEN 'backlog'
   ELSE 'in_progress' END`);
 await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_project_board
  ON tasks(project_id,board_status,postponed_at,archived_at)`);
 await db.query(`CREATE OR REPLACE FUNCTION ado_sync_task_board_status()
 RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
   IF NEW.stage='done' THEN
    IF NEW.acceptance_mode='automatic' THEN
     NEW.board_status:='done';
     NEW.accepted_at:=now();
    ELSE
     NEW.board_status:='acceptance';
     NEW.accepted_at:=NULL;
     NEW.accepted_by:=NULL;
    END IF;
   ELSIF NEW.stage='backlog' THEN
    NEW.board_status:='backlog';
   ELSE
    NEW.board_status:='in_progress';
   END IF;
   NEW.postponed_at:=NULL;
   NEW.postponed_until:=NULL;
   NEW.archived_at:=NULL;
  END IF;
  RETURN NEW;
 END $$`);
 await db.query(`CREATE TRIGGER ado_task_stage_board_sync
  BEFORE UPDATE OF stage ON tasks FOR EACH ROW
  EXECUTE FUNCTION ado_sync_task_board_status()`);
}

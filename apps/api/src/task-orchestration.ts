import type {Pool} from 'pg';

/**
 * Durable per-task ownership for the whole AI development -> review -> QA cycle.
 * A pending test-design phase is still an active orchestration: a second manual
 * QA workflow must not be allowed to begin just because ai_test_runs is empty.
 */
export async function initTaskOrchestrationSchema(pool:Pool){
 await pool.query("CREATE TABLE IF NOT EXISTS task_orchestration_owners (task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,owner_id uuid NOT NULL,workflow_id text NOT NULL,kind text NOT NULL,state text NOT NULL DEFAULT 'active',started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz)");
 await pool.query("CREATE INDEX IF NOT EXISTS idx_task_orchestration_owner_project ON task_orchestration_owners(project_id,state)");
}
export async function acquireTaskOrchestration(pool:Pick<Pool,'query'>,projectId:string,taskId:string,ownerId:string,workflowId:string,kind:'development'|'testing'):Promise<boolean>{
 const result=await pool.query(
  "INSERT INTO task_orchestration_owners(task_id,project_id,owner_id,workflow_id,kind,state) VALUES($1,$2,$3,$4,$5,'active') ON CONFLICT(task_id) DO UPDATE SET project_id=EXCLUDED.project_id,owner_id=EXCLUDED.owner_id,workflow_id=EXCLUDED.workflow_id,kind=EXCLUDED.kind,state='active',started_at=now(),finished_at=NULL WHERE task_orchestration_owners.state='finished' RETURNING owner_id",
  [taskId,projectId,ownerId,workflowId,kind]);
 return result.rowCount===1&&result.rows[0].owner_id===ownerId;
}
export async function releaseTaskOrchestration(pool:Pool,projectId:string,taskId:string,ownerId:string):Promise<void>{
 await pool.query("UPDATE task_orchestration_owners SET state='finished',finished_at=now() WHERE project_id=$1 AND task_id=$2 AND owner_id=$3 AND state='active'",
  [projectId,taskId,ownerId]);
}

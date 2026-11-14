import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {RecoveredTaskPr} from '../application/existing-task-pr-recovery.js';

/** Commit recovered run, task, and audit evidence in a single transaction.
 * Concurrent cancellation or missing task must not yield a false success.
 */
export async function saveRecoveredTaskPr(db:Pick<Pool,'connect'>,pr:RecoveredTaskPr):Promise<void>{
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const saved=await client.query(
   "UPDATE ai_task_runs SET pr_url=$2,branch=$3,status='completed',"+
   " message='PR восстановлен из готовых изменений без повторного запуска Codex',completed_at=now()"+
   " WHERE id=$1 AND project_id=$4 AND status IN ('queued','running') RETURNING id",
   [pr.runId,pr.url,pr.branch,pr.projectId]);
  if(!saved.rowCount)throw Error('Запуск разработки изменился до сохранения восстановленного PR');
  const task=await client.query(
   "UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,"+
   " pr_number=$4,pr_base_branch=$5,updated_at=now()"+
   " WHERE id=$1 AND project_id=$6 RETURNING id",
   [pr.taskId,pr.branch,pr.url,pr.number,pr.baseBranch,pr.projectId]);
  if(!task.rowCount)throw Error('Задача не найдена при сохранении восстановленного PR');
  await client.query(
   "INSERT INTO task_events(id,task_id,actor_id,event,detail)"+
   " VALUES($1,$2,$3,'pr_created',$4)",
   [randomUUID(),pr.taskId,pr.actorId,'PR восстановлен из готовых изменений: '+pr.url]);
  await client.query('COMMIT');
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{client.release();}
}

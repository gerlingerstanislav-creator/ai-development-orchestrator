import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;
export type MergeResult={taskId:string;status:'merged'|'skipped'|'failed';reason?:string};
type MergeTask={id:string;depends_on_task_id:string|null};
type BatchStatus='queued'|'running'|'completed'|'partial'|'failed';

/** Pure DDL for append-only PostgreSQL schema migration v4. */
export async function installMergeBatchSchema(db:Db){
 await db.query(`
  ALTER TABLE merge_process_runs ADD COLUMN IF NOT EXISTS task_ids uuid[];
  CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_process_active ON merge_process_runs(project_id)
   WHERE status IN ('queued','running');
 `);
}

/** Runtime policy for pre-versioned batches, never applied as a migration. */
export async function recoverInterruptedLegacyMergeBatches(db:Db){
 await db.query(`UPDATE merge_process_runs
  SET status='failed',message='Старый запуск прерван. Запустите слияние повторно для оставшихся PR.',finished_at=now()
  WHERE status='running' AND task_ids IS NULL`);
}

export function orderMergeTasks(tasks:MergeTask[]){
 const byId=new Map(tasks.map(task=>[task.id,task.depends_on_task_id]));
 const depth=(taskId:string,seen=new Set<string>()):number=>{
  if(seen.has(taskId))return 0;
  seen.add(taskId);
  const parent=byId.get(taskId);
  return parent?1+depth(parent,seen):0;
 };
 return [...tasks].sort((a,b)=>depth(a.id)-depth(b.id)).map(task=>task.id);
}

export async function readMergeBatch(db:Db,projectId:string,batchId:string){
 return (await db.query(`SELECT id,project_id AS "projectId",status,message,current_task AS "currentTask",
  results,created_at AS "createdAt",finished_at AS "finishedAt" FROM merge_process_runs WHERE id=$1 AND project_id=$2`,
  [batchId,projectId])).rows[0];
}

export async function createMergeBatch(pool:Pool,projectId:string,actorId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
  const active=(await db.query("SELECT id FROM merge_process_runs WHERE project_id=$1 AND status IN ('queued','running')",[projectId])).rows[0];
  if(active){
   const batch=await readMergeBatch(db,projectId,active.id);
   await db.query('COMMIT');return batch;
  }
  const candidates=await db.query<MergeTask>("SELECT id,depends_on_task_id FROM tasks WHERE project_id=$1 AND stage='merge_queue' ORDER BY created_at,id LIMIT 30",[projectId]);
  const tasks=orderMergeTasks(candidates.rows);
  const id=randomUUID();
  await db.query(`INSERT INTO merge_process_runs(id,project_id,actor_id,status,message,task_ids,finished_at)
   VALUES($1,$2,$3,$4,$5,$6,CASE WHEN cardinality($6::uuid[])=0 THEN now() END)`,
   [id,projectId,actorId,tasks.length?'queued':'completed',tasks.length?'Ожидает запуска Temporal':'Нет PR в очереди слияния',tasks]);
  const batch=await readMergeBatch(db,projectId,id);
  await db.query('COMMIT');return batch;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}

export async function recoverMergeBatches(db:Db,start:(batchId:string)=>Promise<void>){
 const pending=await db.query("SELECT id FROM merge_process_runs WHERE status='queued' ORDER BY created_at,id LIMIT 15");
 const deliveries=await Promise.allSettled(pending.rows.map(async ({id})=>{
  try{await start(id);}
  catch(error){
   if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name))throw error;
  }
  await db.query("UPDATE merge_process_runs SET status='running',message='Начато последовательное слияние' WHERE id=$1 AND status='queued'",[id]);
 }));
 const failure=deliveries.find(result=>result.status==='rejected');
 if(failure?.status==='rejected')throw failure.reason;
}

export async function loadMergeBatch(db:Db,batchId:string){
 return (await db.query("SELECT project_id,actor_id,task_ids,results FROM merge_process_runs WHERE id=$1 AND status IN ('queued','running')",[batchId])).rows[0] as
  {project_id:string;actor_id:string;task_ids:string[];results:MergeResult[]}|undefined;
}

export async function setMergeProgress(db:Db,batchId:string,taskId:string,message:string){
 await db.query("UPDATE merge_process_runs SET status='running',current_task=$2,message=$3 WHERE id=$1 AND status IN ('queued','running')",
  [batchId,taskId,message]);
}

export async function saveMergeResult(db:Db,batchId:string,result:MergeResult){
 await db.query(`WITH saved AS (
  UPDATE merge_process_runs SET results=results||$2::jsonb
  WHERE id=$1 AND status IN ('queued','running') AND NOT results @> $3::jsonb RETURNING project_id
 ) INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level)
  SELECT $4,project_id,$1,'merge',$5,$6,$7 FROM saved`,
  [batchId,JSON.stringify([result]),JSON.stringify([{taskId:result.taskId}]),randomUUID(),result.status,
   result.reason?.slice(0,1200)||'PR успешно слит',result.status==='merged'?'info':result.status==='failed'?'error':'warning']);
}

export async function finishMergeBatch(db:Db,batchId:string,error?:string){
 const batch=await loadMergeBatch(db,batchId);
 if(!batch)return;
 const merged=batch.results.filter(result=>result.status==='merged').length;
 const status:BatchStatus=merged===batch.task_ids.length?'completed':merged>0?'partial':'failed';
 const message=error?('Ошибка очереди: '+error).slice(0,1000):
  'Слито PR: '+merged+' из '+batch.task_ids.length+(status==='completed'?'':'. Остальные требуют внимания.');
 await db.query("UPDATE merge_process_runs SET status=$2,message=$3,finished_at=now(),current_task=NULL WHERE id=$1 AND status IN ('queued','running')",
  [batchId,status,message]);
}

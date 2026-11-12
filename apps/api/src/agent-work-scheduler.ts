import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Client as TemporalClient} from '@temporalio/client';
import {acquireTaskOrchestration} from './task-orchestration.js';
import {resolveRoleAiSettings} from './project-team.js';

type Db=Pick<Pool,'query'>;
type LaunchScope={iterationId:string;revision:number;taskIds?:string[]}|{taskId:string;approveAnalysis:boolean};

export async function initAgentWorkQueue(db:Db){
 await db.query(`CREATE TABLE IF NOT EXISTS iteration_execution_queue (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  iteration_id uuid REFERENCES project_iterations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued',
  run_id uuid,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,task_id)
 );
 ALTER TABLE iteration_execution_queue ALTER COLUMN iteration_id DROP NOT NULL;
 ALTER TABLE iteration_execution_queue ADD COLUMN IF NOT EXISTS approved_revision int;
 ALTER TABLE iteration_execution_queue ADD COLUMN IF NOT EXISTS spec_version int;
 ALTER TABLE iteration_execution_queue ADD COLUMN IF NOT EXISTS automatic boolean NOT NULL DEFAULT false;
 ALTER TABLE iteration_execution_queue DROP CONSTRAINT IF EXISTS iteration_execution_queue_status_check;
 ALTER TABLE iteration_execution_queue ADD CONSTRAINT iteration_execution_queue_status_check
  CHECK(status IN ('queued','dispatching','dispatched','cancelled','stale'));
 UPDATE iteration_execution_queue SET status='stale',detail='У запуска нет сохранённой ревизии. Подтвердите запуск повторно.',updated_at=now()
  WHERE status='queued' AND NOT automatic AND iteration_id IS NOT NULL AND approved_revision IS NULL;
 CREATE INDEX IF NOT EXISTS idx_iteration_execution_queue_pending ON iteration_execution_queue(status,created_at);`);
}

/** The caller holds a transaction, including for tool calls made by the PM. */
export async function enqueueDevelopment(db:Db,projectId:string,actorId:string,scope:LaunchScope){
 let iterationId='iterationId' in scope?scope.iterationId:null;
 let revision='revision' in scope?scope.revision:null;
 const ids='taskId' in scope?[scope.taskId]:scope.taskIds??null;
 const reject=(message:string,statusCode=409)=>Object.assign(Error(message),{statusCode});
 if('taskId' in scope){
  const task=(await db.query('SELECT iteration_id FROM tasks WHERE project_id=$1 AND id=$2',[projectId,scope.taskId])).rows[0];
  if(!task)throw reject('Задача не найдена',404);
  iterationId=task.iteration_id;
  if(iterationId)revision=(await db.query('SELECT revision FROM project_iterations WHERE id=$1 AND project_id=$2',[iterationId,projectId])).rows[0]?.revision??null;
 }
 if(iterationId){
  const i=await db.query('SELECT id FROM project_iterations WHERE id=$1 AND project_id=$2 AND revision=$3 AND approved_revision=$3 FOR SHARE',
   [iterationId,projectId,revision]);
  if(!i.rowCount)throw reject('Итерация не согласована или её редакция изменилась');
 }
 const tasks=await db.query(`SELECT id,stage,analysis_state,spec_version FROM tasks
  WHERE project_id=$1 AND iteration_id IS NOT DISTINCT FROM $2::uuid
   AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])) AND type NOT IN ('epic','question')
   AND ($2::uuid IS NULL OR stage<>'done')
  ORDER BY id FOR UPDATE`,[projectId,iterationId,ids]);
 if(ids&&tasks.rows.length!==new Set(ids).size)throw reject('Выбранная задача недоступна для запуска');
 if('taskId' in scope){
  const task=tasks.rows[0];
  const analysis=scope.approveAnalysis&&task.stage==='analysis'&&task.analysis_state==='ready_for_development';
  if(!analysis&&!(task.stage==='development'&&task.analysis_state==='approved'))
   throw reject('Задача не готова к запуску разработки из текущего этапа');
 }
 const results=[];
 for(const task of tasks.rows){
  const prior=(await db.query(`SELECT q.*,r.status AS run_status,EXISTS(SELECT 1 FROM task_orchestration_owners o
    WHERE o.task_id=q.task_id AND o.owner_id=q.run_id AND o.state='active') AS active_owner
   FROM iteration_execution_queue q
   LEFT JOIN ai_task_runs r ON r.id=q.run_id WHERE q.project_id=$1 AND q.task_id=$2 FOR UPDATE OF q`,[projectId,task.id])).rows[0];
  const sameScope=prior&&prior.iteration_id===iterationId&&prior.approved_revision===revision&&prior.spec_version===task.spec_version;
  const active=prior&&(prior.status==='dispatching'||prior.active_owner||['queued','running'].includes(prior.run_status));
  const sameRequest=sameScope&&(prior.status==='queued'||(prior.status==='dispatched'&&!('taskId' in scope)));
  if(active||sameRequest){
   results.push({id:task.id,run_id:prior.run_id,status:prior.status,created_at:prior.created_at});
   continue;
  }
  const runId=randomUUID();
  const row=(await db.query(`INSERT INTO iteration_execution_queue
   (project_id,iteration_id,task_id,requested_by,approved_revision,spec_version,run_id)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,task_id) DO UPDATE
   SET iteration_id=EXCLUDED.iteration_id,requested_by=EXCLUDED.requested_by,approved_revision=EXCLUDED.approved_revision,
    spec_version=EXCLUDED.spec_version,run_id=EXCLUDED.run_id,automatic=false,status='queued',detail='',created_at=now(),updated_at=now()
   RETURNING created_at`,[projectId,iterationId,task.id,actorId,revision,task.spec_version,runId])).rows[0];
  results.push({id:task.id,run_id:runId,status:'queued',created_at:row.created_at});
 }
 const resultById=new Map(results.map(task=>[task.id,task]));
 return {queued:results.filter(task=>task.status==='queued').length,iteration_id:iterationId,
  tasks:ids?[...new Set(ids)].map(id=>resultById.get(id)!):results};
}

const queueState=`SELECT q.*,t.title,t.display_number,t.priority,t.depends_on_task_id,t.stage,t.created_at AS task_created_at,
 CASE
  WHEN NOT q.automatic AND (t.iteration_id IS DISTINCT FROM q.iteration_id OR (q.iteration_id IS NOT NULL AND
   (q.approved_revision IS NULL OR i.revision IS DISTINCT FROM q.approved_revision OR i.approved_revision IS DISTINCT FROM q.approved_revision)))
   THEN 'iteration_changed'
  WHEN NOT q.automatic AND t.spec_version IS DISTINCT FROM q.spec_version THEN 'spec_changed'
  WHEN t.stage IN ('testing','merge_queue','deployment','documentation','done') THEN 'advanced'
  WHEN NOT COALESCE(settings.enabled,false) THEN 'ai_disabled'
  WHEN NOT EXISTS(SELECT 1 FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id
   WHERE g.project_id=q.project_id AND c.provider='github_token') THEN 'github'
  WHEN t.type IN ('epic','question') OR t.stage NOT IN ('analysis','development') THEN 'stage'
  WHEN COALESCE(jsonb_array_length(t.clarification_questions),0)>0 OR EXISTS(
   SELECT 1 FROM task_agent_notes n WHERE n.task_id=t.id AND n.project_id=t.project_id AND n.kind='question'
    AND n.status IN ('open','processing')) THEN 'questions'
  -- Pre-development is gated only by this task's completed analysis and
  -- unanswered owner questions. Documentation drift is advisory, not a blocker.
  WHEN (t.stage='analysis' AND t.analysis_state<>'ready_for_development')
   OR (t.stage='development' AND t.analysis_state<>'approved') THEN 'stage'
  WHEN t.depends_on_task_id IS NOT NULL AND NOT COALESCE(
   dep.stage IN ('deployment','documentation','done') OR
    (dep.stage='merge_queue' AND NULLIF(dep.git_branch,'') IS NOT NULL AND NULLIF(dep.pr_url,'') IS NOT NULL),false)
   THEN 'dependency'
  WHEN EXISTS(SELECT 1 FROM task_orchestration_owners o WHERE o.task_id=t.id AND o.state='active')
   OR EXISTS(SELECT 1 FROM ai_task_runs r WHERE r.task_id=t.id AND r.status IN ('queued','running')) THEN 'active'
  WHEN (SELECT count(*) FROM ai_task_runs r WHERE r.project_id=q.project_id AND r.status IN ('queued','running'))+
   (SELECT count(*) FROM agent_peer_queue p WHERE p.project_id=q.project_id AND p.role='development' AND p.status='running')
    >= COALESCE(capacity.capacity,1) THEN 'capacity'
 END AS reason,
 CASE WHEN dep.stage='merge_queue' THEN dep.git_branch END AS base_branch,
 settings.model,settings.reasoning,settings.enabled
 FROM iteration_execution_queue q
 JOIN tasks t ON t.id=q.task_id AND t.project_id=q.project_id
 LEFT JOIN project_iterations i ON i.id=q.iteration_id AND i.project_id=q.project_id
 LEFT JOIN project_ai_settings settings ON settings.project_id=q.project_id
 LEFT JOIN project_role_capacity capacity ON capacity.project_id=q.project_id AND capacity.role='development'
 LEFT JOIN tasks dep ON dep.id=t.depends_on_task_id AND dep.project_id=q.project_id`;

const reasonText:Record<string,string>={
 iteration_changed:'План изменился. Подтвердите запуск для актуальной ревизии.',
 spec_changed:'Версия ТЗ изменилась. Подтвердите запуск повторно.',
 ai_disabled:'AI отключён в настройках проекта.',
 github:'Ожидается подключение репозитория GitHub.',
 stage:'Задача ещё не готова к разработке.',
 questions:'Ожидаются ответы на вопросы по задаче.',
 spec_review:'Ожидается сверка или согласование актуальной версии ТЗ.',
 dependency:'Ожидается готовый PR или слияние задачи-основания.',
 active:'Для задачи уже выполняется рабочий цикл.',
 capacity:'Ожидается свободный слот разработчика.'
};

/** Carry an explicit launch through analysis of the same task and approved iteration revision. */
export async function carryDevelopmentAuthorizationAfterAnalysis(db:Db,input:{projectId:string;taskId:string;iterationId:string|null;previousVersion:number;version:number}){
 const result=await db.query(`UPDATE iteration_execution_queue q SET spec_version=$4,updated_at=now()
  FROM project_iterations i WHERE q.project_id=$1 AND q.task_id=$2 AND q.status='queued'
   AND q.spec_version=$3 AND q.iteration_id=$5 AND i.id=q.iteration_id
   AND i.project_id=q.project_id AND i.revision=q.approved_revision AND i.approved_revision=q.approved_revision`,
 [input.projectId,input.taskId,input.previousVersion,input.version,input.iterationId]);
 return !!result.rowCount;
}

export async function readDevelopmentQueue(db:Db,projectId:string){
 const rows=await db.query(`SELECT * FROM (${queueState} WHERE q.project_id=$1
  AND q.status IN ('queued','dispatching','cancelled','stale')) work
  ORDER BY (status NOT IN ('queued','dispatching')),(reason IS NOT NULL),priority,task_created_at,task_id LIMIT 120`,[projectId]);
 return rows.rows.map(row=>({...row,detail:row.status==='queued'
  ?reasonText[row.reason]||'Готово к запуску, ожидается диспетчер.'
  :row.detail||'Ожидается подтверждение запуска от Temporal.'}));
}

async function dispatch(db:Db,temporal:()=>Promise<TemporalClient>,run:{run_id:string;project_id:string;task_id:string}){
 try{
  const client=await temporal();
  await client.workflow.start('developmentTestingCycle',{
   taskQueue:'agent-pipeline',workflowId:'task-cycle-'+run.run_id,workflowIdReusePolicy:'REJECT_DUPLICATE',
   args:[{projectId:run.project_id,taskId:run.task_id,runId:run.run_id,maxFixes:3}]
  });
 }catch(error){
  if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name)){
   await db.query("UPDATE iteration_execution_queue SET detail='Temporal временно недоступен. Запуск будет повторён.',updated_at=now() WHERE run_id=$1 AND status='dispatching'",[run.run_id]);
   throw error;
  }
 }
 await db.query("UPDATE iteration_execution_queue SET status='dispatched',detail='Передано Temporal',updated_at=now() WHERE run_id=$1 AND status='dispatching'",[run.run_id]);
}

export async function reconcileAgentWorkQueue(pool:Pool,temporal:()=>Promise<TemporalClient>){
 const db=await pool.connect();
 let acquired=false;
 try{
  acquired=(await db.query("SELECT pg_try_advisory_lock(hashtext('ado-iteration-development-queue')) AS locked")).rows[0].locked===true;
  if(!acquired)return;
  const pending=(await db.query(`SELECT q.project_id,q.task_id,q.run_id,r.status AS run_status
   FROM iteration_execution_queue q LEFT JOIN ai_task_runs r ON r.id=q.run_id
   WHERE q.status='dispatching' ORDER BY q.updated_at LIMIT 1`)).rows[0];
  if(pending){
   if(['queued','running'].includes(pending.run_status))await dispatch(db,temporal,pending);
   else await db.query("UPDATE iteration_execution_queue SET status='dispatched',detail='Попытка завершена',updated_at=now() WHERE run_id=$1 AND status='dispatching'",[pending.run_id]);
   return;
  }

  await db.query(`WITH terminal AS (SELECT project_id,task_id,run_id,reason FROM (${queueState} WHERE q.status='queued') work
   WHERE reason IN ('iteration_changed','spec_changed','advanced'))
   UPDATE iteration_execution_queue q SET status=CASE WHEN terminal.reason='advanced' THEN 'dispatched' ELSE 'stale' END,
    detail=CASE terminal.reason WHEN 'iteration_changed' THEN $1 WHEN 'spec_changed' THEN $2 ELSE 'Задача уже на следующем этапе' END,
    updated_at=now() FROM terminal WHERE q.project_id=terminal.project_id AND q.task_id=terminal.task_id
    AND q.run_id IS NOT DISTINCT FROM terminal.run_id AND q.status='queued'`,
   [reasonText.iteration_changed,reasonText.spec_changed]);

  await db.query(`INSERT INTO iteration_execution_queue
   (project_id,iteration_id,task_id,requested_by,spec_version,run_id,automatic)
   SELECT t.project_id,t.iteration_id,t.id,p.owner_id,t.spec_version,gen_random_uuid(),true
   FROM tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
   WHERE t.type IN ('task','bug','improvement') AND t.stage='development' AND t.analysis_state='approved'
    -- Never restart finished work without a real rework reason. For returns
    -- from QA or PM, test_feedback is the explicit outstanding delta.
    AND (NULLIF(t.test_feedback,'') IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ai_task_runs r WHERE r.task_id=t.id))
    AND NOT EXISTS(SELECT 1 FROM task_orchestration_owners o WHERE o.task_id=t.id AND o.state='active')
    AND NOT EXISTS(SELECT 1 FROM ai_task_runs r WHERE r.task_id=t.id AND r.status IN ('queued','running'))
    AND NOT EXISTS(SELECT 1 FROM iteration_execution_queue q WHERE q.project_id=t.project_id AND q.task_id=t.id AND q.status IN ('queued','dispatching'))
   ORDER BY t.priority,t.created_at LIMIT 25
   ON CONFLICT(project_id,task_id) DO UPDATE SET iteration_id=EXCLUDED.iteration_id,requested_by=EXCLUDED.requested_by,
    spec_version=EXCLUDED.spec_version,run_id=EXCLUDED.run_id,automatic=true,status='queued',detail='',updated_at=now()
   WHERE iteration_execution_queue.status IN ('stale','dispatched')`);

  // Blocked tasks never consume candidate slots, even if many have higher priority.
  const candidate=(await db.query(`SELECT * FROM (${queueState} WHERE q.status='queued') work WHERE reason IS NULL
   ORDER BY priority,task_created_at,task_id LIMIT 1`)).rows[0];
  if(!candidate)return;
  await db.query('BEGIN');
  try{
   if(candidate.iteration_id)await db.query('SELECT id FROM project_iterations WHERE id=$1 AND project_id=$2 FOR SHARE',[candidate.iteration_id,candidate.project_id]);
   await db.query('SELECT id FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[candidate.task_id,candidate.project_id]);
   await db.query('SELECT dep.id FROM tasks t JOIN tasks dep ON dep.id=t.depends_on_task_id AND dep.project_id=t.project_id WHERE t.id=$1 AND t.project_id=$2 FOR SHARE OF dep',[candidate.task_id,candidate.project_id]);
   const locked=(await db.query(`SELECT * FROM (${queueState} WHERE q.project_id=$1 AND q.task_id=$2 AND q.run_id=$3
    AND q.status='queued' FOR UPDATE OF q) work WHERE reason IS NULL`,[candidate.project_id,candidate.task_id,candidate.run_id])).rows[0];
   if(!locked||!await acquireTaskOrchestration(db,locked.project_id,locked.task_id,locked.run_id,'task-cycle-'+locked.run_id,'development')){
    await db.query('ROLLBACK');return;
   }
   if(locked.stage==='analysis'){
    await db.query("UPDATE tasks SET stage='development',analysis_state='approved',updated_at=now() WHERE id=$1",[locked.task_id]);
    await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'stage_changed','Анализ → Разработка: согласованный запуск')",
     [randomUUID(),locked.task_id,locked.requested_by]);
   }
   if(locked.depends_on_task_id)
    await db.query('UPDATE tasks SET pr_base_branch=$2 WHERE id=$1',[locked.task_id,locked.base_branch]);
   const ai=await resolveRoleAiSettings(db,locked.project_id,'development',locked);
   await db.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status,cycle_id,cycle_attempt) VALUES($1,$2,$3,$4,$5,'queued',$1,0)",
    [locked.run_id,locked.project_id,locked.task_id,locked.requested_by,ai.model]);
   await db.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'development','queued','Диспетчер передал готовую задачу разработчику')",
    [randomUUID(),locked.project_id,locked.run_id]);
   await db.query("UPDATE iteration_execution_queue SET status='dispatching',detail='',updated_at=now() WHERE run_id=$1",[locked.run_id]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  await dispatch(db,temporal,candidate);
 }finally{
  if(acquired)await db.query("SELECT pg_advisory_unlock(hashtext('ado-iteration-development-queue'))").catch(()=>{});
  db.release();
 }
}

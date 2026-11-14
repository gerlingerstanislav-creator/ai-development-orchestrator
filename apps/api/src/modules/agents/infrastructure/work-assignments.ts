import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Client as TemporalClient} from '@temporalio/client';
import {roleCapacity} from '../../../project-team.js';
import {orderWorkPlan,type WorkPlanStep} from '../domain/work-plan.js';
import {normalizeTaskToolGrants,restrictChildToolGrants} from '../domain/tool-capabilities.js';

type Db=Pick<Pool,'query'>;
export const workRoles=['analysis','development','testing','documentation','devops','architect'] as const;
export type WorkRole=typeof workRoles[number];
const fail=(message:string,statusCode=409)=>Object.assign(Error(message),{statusCode});

export async function installWorkAssignmentsSchema(db:Db){
 await db.query(`CREATE TABLE IF NOT EXISTS agent_work_assignments(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES agent_work_assignments(id) ON DELETE SET NULL,
  source_role text NOT NULL,
  role text NOT NULL CHECK(role IN ('analysis','development','testing','documentation','devops','architect')),
  objective text NOT NULL,
  acceptance text NOT NULL,
  spec_version integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','submitted','completed','blocked','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  dispatched_at timestamptz,
  result text NOT NULL DEFAULT '',
  evidence text NOT NULL DEFAULT '',
  reviewer_note text NOT NULL DEFAULT '',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_agent_work_pending ON agent_work_assignments(status,next_attempt_at);
 CREATE INDEX IF NOT EXISTS idx_agent_work_task ON agent_work_assignments(project_id,task_id,created_at DESC);`);
}


/** v14: immutable per-plan dependency edges, enforced to the same task by composite foreign keys. */
export async function installWorkPlanSchema(db:Db){
 await db.query(`ALTER TABLE agent_work_assignments ADD COLUMN IF NOT EXISTS plan_id uuid;
 ALTER TABLE agent_work_assignments ADD COLUMN IF NOT EXISTS plan_key text;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_identity
  ON agent_work_assignments(project_id,task_id,id);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_plan_key
  ON agent_work_assignments(plan_id,plan_key) WHERE plan_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS agent_work_plan_dependencies (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  requires_id uuid NOT NULL,
  PRIMARY KEY(assignment_id,requires_id),
  CONSTRAINT work_plan_not_self CHECK (assignment_id<>requires_id),
  CONSTRAINT work_plan_assignment_scope FOREIGN KEY(project_id,task_id,assignment_id)
    REFERENCES agent_work_assignments(project_id,task_id,id) ON DELETE CASCADE,
  CONSTRAINT work_plan_prerequisite_scope FOREIGN KEY(project_id,task_id,requires_id)
    REFERENCES agent_work_assignments(project_id,task_id,id) ON DELETE CASCADE
 );
 CREATE INDEX IF NOT EXISTS idx_agent_work_dependency_predecessor
  ON agent_work_plan_dependencies(requires_id);`);
}

/** v15: capability grants never outlive the assignment's task and version. */
export async function installTaskCapabilityGrants(db:Db){
 await db.query("ALTER TABLE agent_work_assignments ADD COLUMN IF NOT EXISTS granted_tools text[] NOT NULL DEFAULT ARRAY[]::text[]");
}

/** Planning is one transaction: either all steps and edges exist, or none. */
export async function planWork(db:Db,input:{
 projectId:string;taskId:string;sourceRole:string;steps:readonly WorkPlanStep[]
}){
 const steps=orderWorkPlan(input.steps);
 for(const step of steps)if(!(workRoles as readonly string[]).includes(step.role))
  throw fail('Неизвестная роль в плане: '+step.role,400);
 const task=(await db.query(
  'SELECT id,stage,spec_version FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE',
  [input.projectId,input.taskId])).rows[0];
 if(!task)throw fail('Задача не найдена',404);
 if(task.stage==='done')throw fail('Готовую задачу нельзя повторно планировать без нового задания');
 const usage=(await db.query(
  "SELECT count(*)::int AS n FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running','submitted','blocked')",
  [input.projectId,input.taskId])).rows[0];
 if(Number(usage?.n||0)+steps.length>12)throw fail('Превышен лимит незавершённых поручений в задаче');
 const planId=randomUUID();
 const ids=new Map(steps.map(step=>[step.key,randomUUID()]));
 const assignments:{id:string;key:string;role:string;depends_on:string[]}[]=[];
 for(const step of steps){
  const id=ids.get(step.key)!;
  const grants=normalizeTaskToolGrants(step.tools);
  const row={id,project_id:input.projectId,task_id:input.taskId};
  await db.query(`INSERT INTO agent_work_assignments
   (id,project_id,task_id,plan_id,plan_key,source_role,role,objective,acceptance,spec_version,granted_tools)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
   [id,input.projectId,input.taskId,planId,step.key,input.sourceRole,
    step.role,step.objective,step.acceptance,task.spec_version,grants]);
  for(const need of step.needs)await db.query(`INSERT INTO agent_work_plan_dependencies
   (project_id,task_id,assignment_id,requires_id) VALUES($1,$2,$3,$4)`,
   [input.projectId,input.taskId,id,ids.get(need)!]);
  assignments.push({id,key:step.key,role:step.role,depends_on:step.needs.map(need=>ids.get(need)!)});
  await event(db,row,'queued',input.sourceRole+' → '+step.role+': '+step.objective+
   (step.needs.length?' · после '+step.needs.join(', '):''));
 }
 return {plan_id:planId,task_id:input.taskId,status:'queued',assignments};
}

async function event(db:Db,row:{id:string;project_id:string;task_id:string},state:string,detail:string){
 await db.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level,task_id) VALUES($1,$2,$3,'agent',$4,$5,$6,$7)",
 [randomUUID(),row.project_id,row.id,state,detail.slice(0,1500),state==='blocked'||state==='failed'?'warning':'info',row.task_id]);
 await db.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'agent_assignment',$3)",
 [randomUUID(),row.task_id,state+': '+detail.slice(0,1400)]);
}

export async function delegateWork(db:Db,input:{
 projectId:string;taskId:string;sourceRole:string;role:string;objective:string;acceptance:string;parentId?:string|null;tools?:readonly string[]
}){
 if(!(workRoles as readonly string[]).includes(input.role))throw fail('Неизвестная роль',400);
 const grants=normalizeTaskToolGrants(input.tools);
 const task=(await db.query('SELECT id,stage,spec_version FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.taskId])).rows[0];
 if(!task)throw fail('Задача не найдена',404);
 if(task.stage==='done')throw fail('Задача уже завершена');
 let parentId:string|null=null;
 if(input.parentId){
  const parent=(await db.query("SELECT id,role,parent_id,granted_tools FROM agent_work_assignments WHERE id=$1 AND project_id=$2 AND task_id=$3 AND status='running'",
   [input.parentId,input.projectId,input.taskId])).rows[0];
  if(!parent||parent.role!==input.sourceRole)throw fail('Делегирование возможно только из своего активного поручения',403);
  if(parent.parent_id){
   const grand=(await db.query('SELECT parent_id FROM agent_work_assignments WHERE id=$1',[parent.parent_id])).rows[0];
   if(grand?.parent_id)throw fail('Превышена глубина делегирования');
  }
  if(input.sourceRole===input.role)throw fail('Нельзя делегировать самому себе');
  restrictChildToolGrants(grants,parent.granted_tools||[]);
  parentId=parent.id;
 }
 if(input.sourceRole!=='manager'&&!['analyst','business_analyst'].includes(input.sourceRole)&&!parentId&&grants.length)
  throw fail('Нельзя выдавать дополнительные права без активного поручения с такими правами',403);
 const count=(await db.query("SELECT count(*)::int AS n FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running','submitted','blocked')",
 [input.projectId,input.taskId])).rows[0];
 if(Number(count.n)>=12)throw fail('Слишком много незавершённых поручений');
 const existing=(await db.query("SELECT id,status,granted_tools FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND role=$3 AND objective=$4 AND spec_version=$5 AND status IN ('queued','running','submitted','completed','blocked') ORDER BY created_at DESC LIMIT 1",
 [input.projectId,input.taskId,input.role,input.objective,task.spec_version])).rows[0];
 if(existing){
  if(JSON.stringify([...new Set(existing.granted_tools||[])].sort())!==JSON.stringify(grants))
   throw fail('Поручение с этой целью уже есть, но набор прав отличается. Пересмотри существующее поручение.');
  return {id:existing.id,status:existing.status,duplicate:true};
 }
 const row={id:randomUUID(),project_id:input.projectId,task_id:input.taskId};
 await db.query("INSERT INTO agent_work_assignments(id,project_id,task_id,parent_id,source_role,role,objective,acceptance,spec_version,granted_tools) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
 [row.id,row.project_id,row.task_id,parentId,input.sourceRole,input.role,input.objective,input.acceptance,task.spec_version,grants]);
 await event(db,row,'queued',input.sourceRole+' → '+input.role+': '+input.objective);
 return {id:row.id,status:'queued',role:input.role,task_id:row.task_id};
}

export async function listWork(db:Db,projectId:string,taskId:string){
 const task=await db.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]);
 if(!task.rowCount)throw fail('Задача не найдена',404);
 const r=await db.query(`SELECT a.id,a.plan_id,a.plan_key,a.parent_id,a.source_role,a.role,a.objective,a.acceptance,
  a.status,a.spec_version,a.granted_tools,a.attempts,a.result,a.evidence,a.reviewer_note,a.created_at,a.updated_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',dependency.id,'key',dependency.plan_key,
    'status',dependency.status) ORDER BY dependency.created_at,dependency.id)
   FROM agent_work_plan_dependencies link
   JOIN agent_work_assignments dependency ON dependency.id=link.requires_id
   WHERE link.assignment_id=a.id),'[]'::jsonb) AS prerequisites
 FROM agent_work_assignments a WHERE a.project_id=$1 AND a.task_id=$2
 ORDER BY a.created_at,a.id LIMIT 100`,[projectId,taskId]);
 return {assignments:r.rows};
}

/** Tool self-report is SUBMITTED, never an automatic task completion. */
export async function reportWork(db:Db,input:{
 projectId:string;taskId:string;assignmentId:string;role:string;status:'submitted'|'blocked';result:string;evidence:string
}){
 const r=await db.query(`UPDATE agent_work_assignments a SET status=$5,result=$6,evidence=$7,updated_at=now()
 FROM tasks t WHERE a.id=$1 AND a.project_id=$2 AND a.task_id=$3 AND a.role=$4
 AND a.status='running' AND t.id=a.task_id AND t.project_id=a.project_id
 AND t.spec_version=a.spec_version AND t.stage<>'done' RETURNING a.id,a.project_id,a.task_id`,
 [input.assignmentId,input.projectId,input.taskId,input.role,input.status,input.result.slice(0,3000),input.evidence.slice(0,3000)]);
 if(!r.rowCount)throw fail('Поручение не активно, не ваше или версия задачи изменилась');
 await event(db,r.rows[0],input.status,input.role+': '+input.result);
 return {id:input.assignmentId,status:input.status,requires_review:input.status==='submitted'};
}

export async function reviewWork(db:Db,input:{
 projectId:string;assignmentId:string;action:'accept'|'retry'|'cancel';reason:string
}){
 const r=await db.query(`SELECT a.*,t.spec_version AS actual_version
 FROM agent_work_assignments a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
 WHERE a.project_id=$1 AND a.id=$2 FOR UPDATE OF a`,[input.projectId,input.assignmentId]);
 if(!r.rowCount)throw fail('Поручение не найдено',404);
 const row=r.rows[0];
 let target:string;
 if(input.action==='accept'){
  if(row.status!=='submitted'||!row.evidence.trim()||row.spec_version!==row.actual_version)
   throw fail('Нельзя принять непроверенное или устаревшее поручение');
  // A parent cannot be accepted while a delegated specialist still owns work.
  // Check the whole descendant tree, not only immediate children.
  const pending=await db.query(`WITH RECURSIVE descendants AS (
   SELECT id,status FROM agent_work_assignments
    WHERE parent_id=$1 AND project_id=$2 AND task_id=$3
   UNION ALL
   SELECT child.id,child.status FROM agent_work_assignments child
    JOIN descendants parent ON child.parent_id=parent.id
    WHERE child.project_id=$2 AND child.task_id=$3
  ) SELECT 1 FROM descendants WHERE status NOT IN ('completed','cancelled') LIMIT 1`,
   [row.id,input.projectId,row.task_id]);
  if(pending.rowCount)throw fail('Нельзя принять поручение, пока делегированная работа не завершена');
  target='completed';
 }else if(input.action==='retry'){
  if(!['blocked','failed','submitted'].includes(row.status)||row.attempts>=4)throw fail('Повтор пока невозможен');
  target='queued';
 }else{
  if(!['queued','blocked','failed','submitted'].includes(row.status))throw fail('Активную работу нельзя отменить без остановки исполнителя');
  target='cancelled';
 }
 await db.query("UPDATE agent_work_assignments SET status=$3,reviewer_note=$4,next_attempt_at=now(),dispatched_at=CASE WHEN $3='queued' THEN NULL ELSE dispatched_at END,updated_at=now() WHERE project_id=$1 AND id=$2",
 [input.projectId,input.assignmentId,target,input.reason.slice(0,1500)]);
 await event(db,row,target,'ПМ: '+input.reason);
 return {id:row.id,status:target,task_id:row.task_id};
}

export async function finalizeWorkAttempt(db:Db,id:string,reason:string){
 const r=await db.query("UPDATE agent_work_assignments SET status='blocked',result=$2,updated_at=now() WHERE id=$1 AND status='running' RETURNING id,project_id,task_id",
 [id,reason.slice(0,2600)]);
 if(r.rowCount)await event(db,r.rows[0],'blocked',reason);
 return {status:r.rowCount?'blocked':'unchanged'};
}

export async function reconcileAgentWorkAssignments(pool:Pool,temporal:()=>Promise<TemporalClient>){
 const db=await pool.connect();
 let locked=false;
 try{
  locked=(await db.query("SELECT pg_try_advisory_lock(hashtext('ado-agent-work-assignments')) AS ok")).rows[0]?.ok===true;
  if(!locked)return;
  await db.query(`UPDATE agent_work_assignments a SET status='blocked',result='ТЗ изменилось; нужно пересмотреть поручение',updated_at=now()
   FROM tasks t WHERE t.id=a.task_id AND t.project_id=a.project_id AND a.status IN ('queued','submitted')
   AND (a.spec_version<>t.spec_version OR t.stage='done')`);
  const r=await db.query(`SELECT a.id,a.project_id,a.task_id,a.role,a.status,a.attempts FROM agent_work_assignments a
   JOIN projects p ON p.id=a.project_id JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
   WHERE (a.status='queued' OR (a.status='running' AND a.dispatched_at IS NULL)) AND a.next_attempt_at<=now() AND p.agents_running=true AND p.deleted_at IS NULL
   AND t.stage<>'done' AND a.spec_version=t.spec_version
   AND NOT EXISTS(
    SELECT 1 FROM agent_work_plan_dependencies deps
    JOIN agent_work_assignments prereq ON prereq.id=deps.requires_id
    WHERE deps.assignment_id=a.id AND prereq.status<>'completed'
   ) ORDER BY a.created_at LIMIT 40`);
  for(const job of r.rows){
   const cap=await roleCapacity(pool,job.project_id,job.role);
   const used=await db.query(`SELECT
    (SELECT count(*)::int FROM agent_work_assignments WHERE project_id=$1 AND role=$2 AND status='running') AS assignments,
    (SELECT count(*)::int FROM agent_peer_queue WHERE project_id=$1 AND role=$2 AND status='running') AS consultations`,
    [job.project_id,job.role]);
   if(job.status==='queued'&&Number(used.rows[0].assignments)+Number(used.rows[0].consultations)>=cap)continue;
   const claimed=job.status==='queued'
    ?await db.query("UPDATE agent_work_assignments SET status='running',attempts=attempts+1,dispatched_at=NULL,updated_at=now() WHERE id=$1 AND status='queued' RETURNING attempts",[job.id])
    :{rowCount:1,rows:[{attempts:job.attempts}]};
   if(!claimed.rowCount)continue;
   const attempt=Number(claimed.rows[0].attempts);
   try{
    try{
     await (await temporal()).workflow.start('executeDelegatedWork',{
      taskQueue:'agent-pipeline',workflowId:'agent-work-'+job.id+'-'+attempt,
      workflowIdReusePolicy:'REJECT_DUPLICATE',args:[job.id]
     });
    }catch(error){
     if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name))throw error;
    }
    await db.query("UPDATE agent_work_assignments SET dispatched_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND attempts=$2",[job.id,attempt]);
   }catch(error){
    // Preserve this attempt number on uncertain starts. Recovery retries exactly
    // the same Temporal workflow ID instead of opening a duplicate execution.
    await db.query("UPDATE agent_work_assignments SET result=$2,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=$1 AND status='running' AND attempts=$3",
     [job.id,'Temporal запуск не подтверждён: '+String(error).slice(0,400),attempt]);
   }
  }
 }finally{
  if(locked)await db.query("SELECT pg_advisory_unlock(hashtext('ado-agent-work-assignments'))").catch(()=>{});
  db.release();
 }
}

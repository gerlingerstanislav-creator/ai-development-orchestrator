import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Client as TemporalClient} from '@temporalio/client';
import {roleCapacity} from '../../../project-team.js';

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

async function event(db:Db,row:{id:string;project_id:string;task_id:string},state:string,detail:string){
 await db.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level,task_id) VALUES($1,$2,$3,'agent',$4,$5,$6,$7)",
 [randomUUID(),row.project_id,row.id,state,detail.slice(0,1500),state==='blocked'||state==='failed'?'warning':'info',row.task_id]);
 await db.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'agent_assignment',$3)",
 [randomUUID(),row.task_id,state+': '+detail.slice(0,1400)]);
}

export async function delegateWork(db:Db,input:{
 projectId:string;taskId:string;sourceRole:string;role:string;objective:string;acceptance:string;parentId?:string|null
}){
 if(!(workRoles as readonly string[]).includes(input.role))throw fail('Неизвестная роль',400);
 const task=(await db.query('SELECT id,stage,spec_version FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.taskId])).rows[0];
 if(!task)throw fail('Задача не найдена',404);
 if(task.stage==='done')throw fail('Задача уже завершена');
 let parentId:string|null=null;
 if(input.parentId){
  const parent=(await db.query("SELECT id,role,parent_id FROM agent_work_assignments WHERE id=$1 AND project_id=$2 AND task_id=$3 AND status='running'",
   [input.parentId,input.projectId,input.taskId])).rows[0];
  if(!parent||parent.role!==input.sourceRole)throw fail('Делегирование возможно только из своего активного поручения',403);
  if(parent.parent_id){
   const grand=(await db.query('SELECT parent_id FROM agent_work_assignments WHERE id=$1',[parent.parent_id])).rows[0];
   if(grand?.parent_id)throw fail('Превышена глубина делегирования');
  }
  if(input.sourceRole===input.role)throw fail('Нельзя делегировать самому себе');
  parentId=parent.id;
 }
 const count=(await db.query("SELECT count(*)::int AS n FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running','submitted','blocked')",
 [input.projectId,input.taskId])).rows[0];
 if(Number(count.n)>=12)throw fail('Слишком много незавершённых поручений');
 const existing=(await db.query("SELECT id,status FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND role=$3 AND objective=$4 AND spec_version=$5 AND status IN ('queued','running','submitted','completed','blocked') ORDER BY created_at DESC LIMIT 1",
 [input.projectId,input.taskId,input.role,input.objective,task.spec_version])).rows[0];
 if(existing)return {id:existing.id,status:existing.status,duplicate:true};
 const row={id:randomUUID(),project_id:input.projectId,task_id:input.taskId};
 await db.query("INSERT INTO agent_work_assignments(id,project_id,task_id,parent_id,source_role,role,objective,acceptance,spec_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
 [row.id,row.project_id,row.task_id,parentId,input.sourceRole,input.role,input.objective,input.acceptance,task.spec_version]);
 await event(db,row,'queued',input.sourceRole+' → '+input.role+': '+input.objective);
 return {id:row.id,status:'queued',role:input.role,task_id:row.task_id};
}

export async function listWork(db:Db,projectId:string,taskId:string){
 const task=await db.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]);
 if(!task.rowCount)throw fail('Задача не найдена',404);
 const r=await db.query("SELECT id,parent_id,source_role,role,objective,acceptance,status,spec_version,attempts,result,evidence,reviewer_note,created_at,updated_at FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 ORDER BY created_at,id LIMIT 100",[projectId,taskId]);
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
  target='completed';
 }else if(input.action==='retry'){
  if(!['blocked','failed','submitted'].includes(row.status)||row.attempts>=4)throw fail('Повтор пока невозможен');
  target='queued';
 }else{
  if(!['queued','blocked','failed','submitted'].includes(row.status))throw fail('Активную работу нельзя отменить без остановки исполнителя');
  target='cancelled';
 }
 await db.query("UPDATE agent_work_assignments SET status=$3,reviewer_note=$4,next_attempt_at=now(),updated_at=now() WHERE project_id=$1 AND id=$2",
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
  const r=await db.query(`SELECT a.id,a.project_id,a.task_id,a.role FROM agent_work_assignments a
   JOIN projects p ON p.id=a.project_id JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
   WHERE a.status='queued' AND a.next_attempt_at<=now() AND p.agents_running=true AND p.deleted_at IS NULL
   AND t.stage<>'done' AND a.spec_version=t.spec_version ORDER BY a.created_at LIMIT 40`);
  for(const job of r.rows){
   const cap=await roleCapacity(pool,job.project_id,job.role);
   const used=await db.query(`SELECT
    (SELECT count(*)::int FROM agent_work_assignments WHERE project_id=$1 AND role=$2 AND status='running') AS assignments,
    (SELECT count(*)::int FROM agent_peer_queue WHERE project_id=$1 AND role=$2 AND status='running') AS consultations`,
    [job.project_id,job.role]);
   if(Number(used.rows[0].assignments)+Number(used.rows[0].consultations)>=cap)continue;
   const claimed=await db.query("UPDATE agent_work_assignments SET status='running',attempts=attempts+1,updated_at=now() WHERE id=$1 AND status='queued' RETURNING attempts",[job.id]);
   if(!claimed.rowCount)continue;
   try{
    await (await temporal()).workflow.start('executeDelegatedWork',{
     taskQueue:'agent-pipeline',workflowId:'agent-work-'+job.id+'-'+claimed.rows[0].attempts,
     workflowIdReusePolicy:'REJECT_DUPLICATE',args:[job.id]
    });
   }catch(error){
    await db.query("UPDATE agent_work_assignments SET status='queued',result=$2,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=$1 AND status='running'",
    [job.id,'Temporal временно недоступен: '+String(error).slice(0,400)]);
   }
  }
 }finally{
  if(locked)await db.query("SELECT pg_advisory_unlock(hashtext('ado-agent-work-assignments'))").catch(()=>{});
  db.release();
 }
}

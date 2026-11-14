import {randomUUID} from 'node:crypto';
import {readPmTaskGoal} from '../../../pm-task-goal.js';

type Db={query:(sql:string,values?:any[])=>Promise<{rows:any[];rowCount:number|null}>};
type LinkKind='task'|'assignment'|'document';
type GoalLink={id:string;kind:LinkKind;reference_id:string};
const reject=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});

/** Goals belong to the PM conversation, not to a Kanban stage or an agent.
 * Links refer to existing verified project resources, never arbitrary URLs
 * or user-provided completion claims.
 */
export async function installPmGoalSchema(db:Db){
 await db.query(`CREATE TABLE IF NOT EXISTS project_pm_goals(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  order_id uuid REFERENCES project_pm_orders(id) ON DELETE SET NULL,
  objective text NOT NULL CHECK(length(objective) BETWEEN 12 AND 4000),
  criteria jsonb NOT NULL CHECK(jsonb_typeof(criteria)='array'),
  status text NOT NULL DEFAULT 'working'
   CHECK(status IN ('working','waiting_agents','waiting_user','needs_action','completed')),
  completion_evidence text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,source_message_id)
 );
 CREATE INDEX IF NOT EXISTS idx_pm_goals_project ON project_pm_goals(project_id,status,updated_at DESC);
 CREATE TABLE IF NOT EXISTS project_pm_goal_links(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES project_pm_goals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('task','assignment','document')),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(goal_id,kind,reference_id)
 );
 CREATE INDEX IF NOT EXISTS idx_pm_goal_links_goal ON project_pm_goal_links(goal_id,created_at);
 CREATE TABLE IF NOT EXISTS project_pm_goal_events(
  id uuid PRIMARY KEY,
  goal_id uuid NOT NULL REFERENCES project_pm_goals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('opened','linked','status','completed')),
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
 );`);
}

/** v18: keep a structured proposed workaround / platform improvement
 * with the original long-lived Goal. Historical events remain append-only.
 */
export async function installPmCapabilityProposalSchema(db:Db){
 await db.query("ALTER TABLE project_pm_goals ADD COLUMN IF NOT EXISTS capability_proposal jsonb");
}
export type PmCapabilityOption={
 kind:'workaround'|'platform_improvement';
 description:string;
 tradeoff:string;
 needs_approval:boolean;
};
export async function proposePmCapabilityOptions(db:Db,input:{
 projectId:string;goalId:string;limitation:string;observations:string[];
 options:PmCapabilityOption[];recommendedIndex:number;
}){
 if(input.recommendedIndex<0||input.recommendedIndex>=input.options.length)
  throw reject('Рекомендованный вариант не входит в список',400);
 const proposal={
  limitation:input.limitation,observations:input.observations,options:input.options,
  recommended_index:input.recommendedIndex,proposed_at:new Date().toISOString()
 };
 const result=await db.query(`UPDATE project_pm_goals
  SET status='needs_action',capability_proposal=$3::jsonb,updated_at=now()
  WHERE project_id=$1 AND id=$2 AND status<>'completed'
  RETURNING id,status,order_id,capability_proposal`,
  [input.projectId,input.goalId,JSON.stringify(proposal)]);
 if(!result.rowCount)throw reject('Цель не найдена или уже завершена',404);
 const preferred=input.options[input.recommendedIndex];
 await db.query(`INSERT INTO project_pm_goal_events(id,goal_id,kind,detail)
  VALUES($1,$2,'status',$3)`,[randomUUID(),input.goalId,
  ('Ограничение возможностей: '+input.limitation+'; предложено: '+preferred.description).slice(0,1500)]);
 return {goal_id:input.goalId,status:'needs_action',capability_proposal:proposal,
  requires_owner_decision:true};
}

export async function openPmGoal(db:Db,input:{
 projectId:string;sourceMessageId:string;actorId:string;objective:string;criteria:string[];
}){
 const source=await db.query(`SELECT 1 FROM assistant_messages WHERE id=$1 AND project_id=$2
  AND actor_id=$3 AND role='user' AND channel='project' AND status='processing'`,
  [input.sourceMessageId,input.projectId,input.actorId]);
 if(!source.rowCount)throw reject('Цель можно принять только из текущего сообщения владельца',403);
 const id=randomUUID();
 const result=await db.query(`INSERT INTO project_pm_goals
  (id,project_id,source_message_id,order_id,objective,criteria)
  VALUES($1,$2,$3,(SELECT pm_order_id FROM assistant_messages WHERE id=$3),$4,$5::jsonb)
  ON CONFLICT(project_id,source_message_id) DO NOTHING RETURNING id`,
  [id,input.projectId,input.sourceMessageId,input.objective,JSON.stringify(input.criteria)]);
 if(result.rowCount)await db.query(
  "INSERT INTO project_pm_goal_events(id,goal_id,kind,detail) VALUES($1,$2,'opened',$3)",
  [randomUUID(),id,'Цель принята из сообщения '+input.sourceMessageId]);
 const goal=await db.query(`SELECT id,objective,criteria,status,order_id,source_message_id
  FROM project_pm_goals WHERE project_id=$1 AND source_message_id=$2`,
  [input.projectId,input.sourceMessageId]);
 return {...goal.rows[0],created:!!result.rowCount};
}

async function checkReference(db:Db,projectId:string,kind:LinkKind,referenceId:string,lock=false){
 const locking=lock?' FOR SHARE':'';
 const sql=kind==='task'
  ?`SELECT t.id,t.title,t.stage,t.type FROM tasks t WHERE t.project_id=$1 AND t.id=$2${locking}`
  :kind==='assignment'
  ?`SELECT a.id,a.status,a.evidence,a.result,a.spec_version,t.spec_version AS current_version
    FROM agent_work_assignments a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
    WHERE a.project_id=$1 AND a.id=$2${lock?' FOR SHARE OF a,t':''}`
  :`SELECT id,title,body FROM documents WHERE project_id=$1 AND id=$2${locking}`;
 const result=await db.query(sql,[projectId,referenceId]);
 const row=result.rows[0];
 if(!row)return {verified:false,state:'missing',reason:'Связанный объект недоступен в этом проекте'};
 if(kind==='task')return {
  verified:row.stage==='done',state:row.stage,
  reason:row.stage==='done'?'Задача подтверждена в done':'Задача ещё не завершена',
  title:row.title
 };
 if(kind==='assignment'){
  const verified=row.status==='completed'&&row.spec_version===row.current_version&&
   typeof row.evidence==='string'&&row.evidence.trim().length>=12;
  return {verified,state:row.status,
   reason:verified?'Результат принят ПМ с доказательствами':'Поручение не принято или его ТЗ устарело'};
 }
 const verified=String(row.body||'').trim().length>=20;
 return {verified,state:verified?'available':'empty',
  reason:verified?'Документ существует и содержит данные; содержимое всё ещё требует оценки':'Документ пуст или отсутствует',
  title:row.title};
}

export async function linkPmGoal(db:Db,input:{
 projectId:string;goalId:string;kind:LinkKind;referenceId:string
}){
 const goal=await db.query(`SELECT id,status FROM project_pm_goals WHERE id=$1 AND project_id=$2 FOR UPDATE`,
  [input.goalId,input.projectId]);
 if(!goal.rowCount)throw reject('Цель не найдена',404);
 if(goal.rows[0].status==='completed')throw reject('Нельзя менять завершённую цель');
 const state=await checkReference(db,input.projectId,input.kind,input.referenceId);
 if(state.state==='missing')throw reject('Объект другой задачи или проекта недоступен',404);
 const id=randomUUID();
 const inserted=await db.query(`INSERT INTO project_pm_goal_links(id,project_id,goal_id,kind,reference_id)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(goal_id,kind,reference_id) DO NOTHING RETURNING id`,
  [id,input.projectId,input.goalId,input.kind,input.referenceId]);
 if(inserted.rowCount)await db.query(
  "INSERT INTO project_pm_goal_events(id,goal_id,kind,detail) VALUES($1,$2,'linked',$3)",
  [randomUUID(),input.goalId,input.kind+':'+input.referenceId]);
 const watch=input.kind==='assignment'&&['queued','running'].includes(state.state)
  ?{kind:'delegated_work' as const,process_id:input.referenceId}
  :input.kind==='task'&&state.state!=='done'&&
    (await readPmTaskGoal(db,input.projectId,input.referenceId)).status==='running'
  ?{kind:'task_goal' as const,process_id:randomUUID(),task_id:input.referenceId}
  :null;
 return {goal_id:input.goalId,linked:!!inserted.rowCount,kind:input.kind,
  reference_id:input.referenceId,verification:state,watch};
}

export async function assessPmGoal(db:Db,projectId:string,goalId:string,lock=false){
 const row=await db.query(`SELECT id,objective,criteria,status,order_id,source_message_id,completion_evidence,capability_proposal
  FROM project_pm_goals WHERE id=$1 AND project_id=$2${lock?' FOR UPDATE':''}`,[goalId,projectId]);
 if(!row.rowCount)throw reject('Цель не найдена',404);
 const links=await db.query(`SELECT id,kind,reference_id FROM project_pm_goal_links
  WHERE goal_id=$1 AND project_id=$2 ORDER BY created_at,id`,[goalId,projectId]);
 const checks=[];
 for(const link of links.rows as GoalLink[]){
  const inspection=await checkReference(db,projectId,link.kind,link.reference_id,lock);
  checks.push({...link,...inspection});
 }
 return {goal:row.rows[0],links:checks,
  verification:{verified:checks.length>0&&checks.every(v=>v.verified),
   missing:checks.filter(v=>!v.verified).map(v=>({kind:v.kind,reference_id:v.reference_id,reason:v.reason})),
   note:'Проверяются существование и машинно подтверждённые состояния. Качество критериев остаётся предметом проверки ПМ.'}};
}

export async function listPmGoals(db:Db,projectId:string){
 const goals=await db.query(`SELECT g.id,g.objective,g.criteria,g.status,g.order_id,g.source_message_id,
  (g.capability_proposal IS NOT NULL) AS has_capability_proposal,
  g.updated_at,(SELECT count(*)::int FROM project_pm_goal_links l WHERE l.goal_id=g.id) AS linked_results
  FROM project_pm_goals g WHERE g.project_id=$1
  ORDER BY (g.status='completed') ASC,g.updated_at DESC LIMIT 50`,[projectId]);
 return {goals:goals.rows};
}

export async function updatePmGoalStatus(db:Db,input:{
 projectId:string;goalId:string;status:'working'|'waiting_user'|'needs_action';reason:string
}){
 const goal=await db.query(`UPDATE project_pm_goals SET status=$3,
   capability_proposal=CASE WHEN $3='working' THEN NULL ELSE capability_proposal END,
   updated_at=now()
  WHERE project_id=$1 AND id=$2 AND status<>'completed' RETURNING id,status,order_id`,
  [input.projectId,input.goalId,input.status]);
 if(!goal.rowCount)throw reject('Цель не найдена или уже завершена');
 await db.query("INSERT INTO project_pm_goal_events(id,goal_id,kind,detail) VALUES($1,$2,'status',$3)",
  [randomUUID(),input.goalId,input.reason.slice(0,1500)]);
 return goal.rows[0];
}

export async function completePmGoal(db:Db,input:{
 projectId:string;goalId:string;evidence:string
}){
 const assessment=await assessPmGoal(db,input.projectId,input.goalId,true);
 if(assessment.goal.status==='completed')return {status:'completed',already_completed:true};
 if(!assessment.verification.verified)
  throw reject('Нельзя завершить цель без подтверждённых связанных результатов: '+
   assessment.verification.missing.map(v=>v.kind+': '+v.reason).join('; ').slice(0,700));
 const finished=await db.query(`UPDATE project_pm_goals SET status='completed',capability_proposal=NULL,completion_evidence=$3,updated_at=now()
  WHERE project_id=$1 AND id=$2 AND status<>'completed' RETURNING id,status,order_id`,
  [input.projectId,input.goalId,input.evidence]);
 if(!finished.rowCount)throw reject('Цель параллельно изменилась');
 await db.query("INSERT INTO project_pm_goal_events(id,goal_id,kind,detail) VALUES($1,$2,'completed',$3)",
  [randomUUID(),input.goalId,input.evidence.slice(0,1500)]);
 return {...finished.rows[0],verified_results:assessment.links.length};
}

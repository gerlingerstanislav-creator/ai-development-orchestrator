import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {planWork} from '../../agents/infrastructure/work-assignments.js';
import type {WorkPlanStep} from '../../agents/domain/work-plan.js';

type Db=Pick<Pool,'query'>;
const denied=(message:string,statusCode=409)=>Object.assign(Error(message),{statusCode});

/** Goal ownership, task assignment planning and evidence links use the SAME
 * PostgreSQL transaction supplied by the existing MCP router. No partial
 * "I delegated it" state can survive a failed dependency graph.
 */
export async function planPmGoalWork(db:Db,input:{
 projectId:string;goalId:string;taskId?:string;steps:readonly WorkPlanStep[];
}){
 const goal=await db.query(`SELECT g.id,g.status,g.order_id
  FROM project_pm_goals g WHERE g.project_id=$1 AND g.id=$2 FOR UPDATE`,
  [input.projectId,input.goalId]);
 if(!goal.rowCount)throw denied('Цель не найдена в проекте',404);
 if(goal.rows[0].status==='completed')throw denied('Завершённую цель нельзя перепланировать');
 const plan=await planWork(db,{
  projectId:input.projectId,taskId:input.taskId,goalId:input.taskId?undefined:input.goalId,sourceRole:'manager',steps:input.steps
 });
 // Every deliverable is linked before the transaction commits. The goal
 // cannot be marked complete until each assignment has been reviewed.
 let newLinks=0;
 for(const item of plan.assignments){
  const inserted=await db.query(`INSERT INTO project_pm_goal_links(id,project_id,goal_id,kind,reference_id)
   VALUES($1,$2,$3,'assignment',$4)
   ON CONFLICT(goal_id,kind,reference_id) DO NOTHING RETURNING id`,
   [randomUUID(),input.projectId,input.goalId,item.id]);
  if(inserted.rowCount)newLinks++;
 }
 // A replay of an already linked plan is a read, not fresh delegated work:
 // preserve waiting_user/needs_action and avoid another linked event.
 if(newLinks){
  await db.query(`INSERT INTO project_pm_goal_events(id,goal_id,kind,detail)
   VALUES($1,$2,'linked',$3)`,[randomUUID(),input.goalId,
   'План '+plan.plan_id+' связан с целью: '+plan.assignments.length+' поручений']);
  await db.query(`UPDATE project_pm_goals SET status='waiting_agents',capability_proposal=NULL,
   updated_at=now() WHERE id=$1 AND project_id=$2 AND status<>'completed'`,
   [input.goalId,input.projectId]);
 }
 return {...plan,goal_id:input.goalId,goal_status:newLinks?'waiting_agents':goal.rows[0].status,
  linked_results:plan.assignments.length,new_links:newLinks};
}

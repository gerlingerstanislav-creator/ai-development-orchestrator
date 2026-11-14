import type {Pool} from 'pg';
import {z} from 'zod';
import type {AgentSession} from '../../../agent-tools.js';
import {openPmGoal,linkPmGoal,assessPmGoal,listPmGoals,updatePmGoalStatus,completePmGoal} from './pm-goals.js';

const uuid=z.string().uuid();
const denied=(message:string,statusCode=403)=>Object.assign(new Error(message),{statusCode});
const names=new Set(['goals.open','goals.list','goals.read','goals.link','goals.update','goals.complete']);
export function isPmGoalTool(name:string){return names.has(name);}
export async function executePmGoalTool(db:Pick<Pool,'query'>,session:AgentSession,
 name:string,args:Record<string,unknown>){
 if(session.role!=='manager')throw denied('Цели доступны только ПМ текущего проекта');
 if(session.read_only&&!['goals.list','goals.read'].includes(name))throw denied('Читающая сессия не может изменять цели');
 const projectId=session.project_id;
 switch(name){
 case 'goals.open':{
  if(!session.process_id)throw denied('Нельзя принять цель без сообщения пользователя');
  const data=z.object({objective:z.string().trim().min(12).max(4000),
   criteria:z.array(z.string().trim().min(12).max(800)).min(1).max(8)}).strict().parse(args);
  return openPmGoal(db,{...data,projectId,sourceMessageId:session.process_id,
   actorId:session.actor_id});
 }
 case 'goals.list':{
  z.object({}).strict().parse(args);
  return listPmGoals(db,projectId);
 }
 case 'goals.read':{
  const data=z.object({goal_id:uuid}).strict().parse(args);
  return assessPmGoal(db,projectId,data.goal_id);
 }
 case 'goals.link':{
  const data=z.object({goal_id:uuid,kind:z.enum(['task','assignment','document']),
   reference_id:uuid}).strict().parse(args);
  return linkPmGoal(db,{projectId,goalId:data.goal_id,kind:data.kind,referenceId:data.reference_id});
 }
 case 'goals.update':{
  const data=z.object({goal_id:uuid,status:z.enum(['working','waiting_user','needs_action']),
   reason:z.string().trim().min(12).max(1500)}).strict().parse(args);
  return updatePmGoalStatus(db,{projectId,goalId:data.goal_id,status:data.status,reason:data.reason});
 }
 case 'goals.complete':{
  const data=z.object({goal_id:uuid,evidence:z.string().trim().min(20).max(3000)}).strict().parse(args);
  return completePmGoal(db,{projectId,goalId:data.goal_id,evidence:data.evidence});
 }
 default:throw denied('Неизвестный инструмент целей',404);
 }
}

import type {Pool} from 'pg';
import {z} from 'zod';
import type {AgentSession} from '../../../agent-tools.js';
import {openPmGoal,linkPmGoal,assessPmGoal,listPmGoals,updatePmGoalStatus,completePmGoal,proposePmCapabilityOptions} from './pm-goals.js';
import {planPmGoalWork} from './pm-goal-plan.js';
import {workRoles} from '../../agents/infrastructure/work-assignments.js';

const uuid=z.string().uuid();
const denied=(message:string,statusCode=403)=>Object.assign(new Error(message),{statusCode});
const names=new Set(['goals.open','goals.list','goals.read','goals.link','goals.plan','goals.propose_alternatives','goals.update','goals.complete']);
export function isPmGoalTool(name:string){return names.has(name);}
export async function executePmGoalTool(db:Pick<Pool,'query'>,session:AgentSession,
 name:string,args:Record<string,unknown>){
 if(session.role!=='manager'&&!['goals.list','goals.read'].includes(name))
  throw denied('Изменять цель может только ПМ текущего проекта');
 if(session.read_only&&!['goals.list','goals.read'].includes(name))throw denied('Читающая сессия не может изменять цели');
 const projectId=session.project_id;
 switch(name){
 case 'goals.open':{
  if(!session.process_id)throw denied('Нельзя принять цель без сообщения пользователя');
  const data=z.object({objective:z.string().trim().min(12).max(4000),
   criteria:z.array(z.string().trim().min(12).max(800)).min(1).max(8)}).strict().parse(args);
  const goal=await openPmGoal(db,{...data,projectId,sourceMessageId:session.process_id,
   actorId:session.actor_id});
  return {...goal,watch:{kind:'goal',process_id:goal.id,goal_id:goal.id}};

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
 case 'goals.plan':{
  const data=z.object({
   goal_id:uuid,task_id:uuid,
   steps:z.array(z.object({
    key:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    role:z.enum(workRoles),
    objective:z.string().trim().min(12).max(2000),
    acceptance:z.string().trim().min(12).max(2000),
    needs:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)).max(8).default([]),
    tools:z.array(z.string()).max(12).default([])
   }).strict()).min(1).max(12)
  }).strict().parse(args);
  return planPmGoalWork(db,{projectId,goalId:data.goal_id,taskId:data.task_id,steps:data.steps});
 }
 case 'goals.propose_alternatives':{
  const data=z.object({
   goal_id:uuid,
   limitation:z.string().trim().min(20).max(1200),
   observations:z.array(z.string().trim().min(8).max(400)).max(5).default([]),
   options:z.array(z.object({
    kind:z.enum(['workaround','platform_improvement']),
    description:z.string().trim().min(20).max(800),
    tradeoff:z.string().trim().min(12).max(500),
    needs_approval:z.boolean()
   }).strict()).min(1).max(3),
   recommended_index:z.number().int().min(0).max(2),
   idempotency_key:z.string().min(8).max(120).optional()
  }).strict().parse(args);
  return proposePmCapabilityOptions(db,{
   projectId,goalId:data.goal_id,limitation:data.limitation,
   observations:data.observations,options:data.options,recommendedIndex:data.recommended_index
  });
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

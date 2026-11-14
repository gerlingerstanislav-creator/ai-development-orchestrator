import type {Pool} from 'pg';
import {z} from 'zod';
import type {AgentSession} from '../../../agent-tools.js';
import {delegateWork,listWork,planWork,reportWork,reviewWork,grantWorkTools,workRoles} from './work-assignments.js';
import {listWorkArtifacts} from './work-artifacts.js';

const uuid=z.string().uuid();
const rejected=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const WORK_TOOL_NAMES=[
 'work.artifacts','work.list','work.plan','work.delegate',
 'work.report','work.review','work.grant'
] as const;
const workTools=new Set<string>(WORK_TOOL_NAMES);
export function isAgentWorkTool(name:string){return workTools.has(name);}

/** Project- and assignment-scoped work tool dispatch.
 * The original MCP session authorization, idempotency, and transaction remain
 * in agent-tool-routes; this service receives the SAME transaction handle.
 */
export async function executeAgentWorkTool(
 pool:Pick<Pool,'query'>,session:AgentSession,name:string,params:Record<string,unknown>
):Promise<unknown>{
 const projectId=session.project_id;
 switch(name){
 case 'work.artifacts':{
  const {task_id}=z.object({task_id:uuid}).parse(params);
  if(session.task_id&&session.task_id!==task_id)throw rejected('Нельзя читать чужие артефакты',403);
  if(!(await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[task_id,projectId])).rowCount)
   throw rejected('Задача не найдена',404);
  return listWorkArtifacts(pool,projectId,task_id);
 }
 case 'work.list':{
  const {task_id}=z.object({task_id:uuid}).parse(params);
  if(session.task_id&&session.task_id!==task_id)throw rejected('Нельзя читать поручения другой задачи',403);
  return listWork(pool,projectId,task_id);
 }
 case 'work.plan':{
  if(!['manager','analyst','business_analyst'].includes(session.role))
   throw rejected('Составление плана принадлежит ПМ или аналитику',403);
  const data=z.object({
   task_id:uuid,
   steps:z.array(z.object({
    key:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    role:z.enum(workRoles),
    objective:z.string().trim().min(12).max(2000),
    acceptance:z.string().trim().min(12).max(2000),
    needs:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)).max(8).default([]),
    tools:z.array(z.string()).max(12).default([])
   }).strict()).min(1).max(12)
  }).parse(params);
  if(session.task_id&&session.task_id!==data.task_id)throw rejected('Нельзя планировать чужую задачу',403);
  return planWork(pool,{projectId,taskId:data.task_id,sourceRole:session.role,steps:data.steps});
 }
 case 'work.delegate':{
  const {task_id,role,objective,acceptance,tools}=z.object({
   task_id:uuid,role:z.enum(workRoles),objective:z.string().trim().min(12).max(2000),
   acceptance:z.string().trim().min(12).max(2000),tools:z.array(z.string()).max(12).default([])
  }).parse(params);
  if(session.role!=='manager'&&session.task_id!==task_id)throw rejected('Нельзя делегировать работу для чужой задачи',403);
  if(session.role!=='manager'&&!session.process_id)throw rejected('Нет активного процесса',403);
  let parentId:string|null=null;
  if(session.role!=='manager'){
   const active=await pool.query(`SELECT id FROM agent_work_assignments
    WHERE id=$1 AND project_id=$2 AND task_id=$3 AND role=$4 AND status='running'`,[session.process_id,projectId,task_id,session.role]);
   if(active.rowCount)parentId=session.process_id!;
   else {
    const authorized=await pool.query(`SELECT note_id AS id FROM agent_peer_queue WHERE note_id=$1 AND project_id=$2 AND task_id=$3 AND role=$4 AND status='running'
     UNION ALL SELECT id FROM ai_task_runs WHERE id=$1 AND project_id=$2 AND task_id=$3 AND $4='development' AND status IN ('queued','running')
     UNION ALL SELECT id FROM ai_test_runs WHERE id=$1 AND project_id=$2 AND task_id=$3 AND $4='testing' AND status IN ('queued','running')
     UNION ALL SELECT id FROM agent_analysis_runs WHERE id=$1 AND project_id=$2 AND task_id=$3 AND $4='analysis' AND status IN ('queued','running')`,
     [session.process_id,projectId,task_id,session.role]);
    if(!authorized.rowCount)throw rejected('Назначать работу может только действующий исполнитель этой задачи',403);
   }
  }
  return delegateWork(pool,{projectId,taskId:task_id,role,objective,acceptance,sourceRole:session.role,parentId,tools});
 }
 case 'work.report':{
  if(!session.task_id||!session.process_id)throw rejected('Нет активного поручения с привязкой к задаче',403);
  const {result,evidence,status}=z.object({
   result:z.string().trim().min(20).max(3000),evidence:z.string().trim().min(12).max(3000),
   status:z.enum(['submitted','blocked'])
  }).parse(params);
  return reportWork(pool,{projectId,taskId:session.task_id,assignmentId:session.process_id,
   role:session.role,status,result,evidence});
 }
 case 'work.review':{
  if(session.role!=='manager')throw rejected('Принять результат может только ПМ',403);
  const {assignment_id,action,reason}=z.object({
   assignment_id:uuid,action:z.enum(['accept','retry','cancel']),
   reason:z.string().trim().min(12).max(2000)
  }).parse(params);
  return reviewWork(pool,{projectId,assignmentId:assignment_id,action,reason});
 }
 case 'work.grant':{
  if(session.role!=='manager')throw rejected('Выдавать дополнительные инструменты может только ПМ',403);
  const {assignment_id,tools,reason}=z.object({
   assignment_id:uuid,tools:z.array(z.string()).min(1).max(12),
   reason:z.string().trim().min(12).max(1600)
  }).parse(params);
  return grantWorkTools(pool,{projectId,assignmentId:assignment_id,tools,reason});
 }
 default:throw rejected('Неизвестный инструмент для поручений: '+name,404);
 }
}

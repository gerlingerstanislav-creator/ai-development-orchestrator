import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';

/** Read-only inventory from the same tables used to execute agents. */
export function registerProjectTeamRoutes(app:FastifyInstance,deps:{pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>}){
 const {pool,access}=deps;
 app.get('/api/projects/:id/team',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id))return;
  const [stages,specialists,memory]=await Promise.all([
   pool.query('SELECT stage,label,position,agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 ORDER BY position',[id]),
   pool.query('SELECT role,agent_name,agent_instructions FROM project_specialist_agents WHERE project_id=$1 ORDER BY role',[id]),
   pool.query("SELECT id,role,kind,body,evidence,status,created_at,reviewed_at FROM agent_memory WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500",[id])
  ]);
  const entries=stages.rows.map(row=>({
   id:'stage:'+row.stage,role:row.stage,name:row.agent_name,stage:row.label,
   type:'workflow',instructions:row.agent_instructions
  }));
  // Specialist roles are distinct from workflow stages: a DevOps advisor has
  // an independent context even when the deployment stage is disabled.
  entries.push(...specialists.rows.map(row=>({
   id:'specialist:'+row.role,role:row.role,name:row.agent_name,stage:'Специалист',
   type:'specialist',instructions:row.agent_instructions
  })));
  // The manager and business analyst are conversational roles, not Kanban stages.
  entries.unshift(
   {id:'conversation:manager',role:'manager',name:'ПМ',stage:'Коммуникации',type:'conversation',instructions:''},
   {id:'conversation:analyst',role:'analyst',name:'БА',stage:'Бизнес-анализ',type:'conversation',instructions:''}
  );
  return {agents:entries,memory:memory.rows};
 });
}

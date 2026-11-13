import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {findActiveProjectOperation,projectDeletionConfirmation} from '../../project-lifecycle.js';
import {agentInstructions} from '../../agent-instructions.js';
import {workflowDefaults,workflowAgentDefaults,workflowStageDescriptions} from './domain/workflow-defaults.js';

type Deps={
 pool:Pick<Pool,'query'|'connect'>;
 uid:(req:any)=>string;
 access:(req:any,reply:any,id:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/**
 * Project lifecycle API: ownership, soft-delete, final removal and creation.
 * Keep project-scoped transactions and membership guard in one feature.
 */
export function registerProjectCoreRoutes(app:FastifyInstance,{pool,uid,access,requireAdmin}:Deps){
app.get('/api/me',async(req)=>{const r=await pool.query('SELECT id,email FROM users WHERE id=$1',[uid(req)]);return r.rows[0];});
app.get('/api/projects',async(req)=>{
 const r=await pool.query('SELECT p.id,p.name,p.description,p.agents_running,p.created_at,(p.owner_id=$1) AS is_owner FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC',[uid(req)]);
 return r.rows;
});
// Operator control plane: PM remains reachable while specialist dispatch is stopped.
// An already-running external job is not killed, preserving its git/QA checkpoint.
app.post('/api/projects/:id/agents/state',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const {running}=parse(z.object({running:z.boolean()}),req.body||{});
 const changed=await pool.query('UPDATE projects SET agents_running=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING agents_running',[id,running]);
 if(!changed.rowCount)return reply.code(404).send({error:'Проект не найден'});
 return {running:changed.rows[0].agents_running};
});
app.get('/api/projects/trash',async(req)=>{
 const r=await pool.query('SELECT id,name,description,deleted_at FROM projects WHERE owner_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',[uid(req)]);
 return r.rows;
});
app.post('/api/projects/:id/trash',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const result=await client.query('SELECT id,name,owner_id,deleted_at FROM projects WHERE id=$1 FOR UPDATE',[id]);
  const project=result.rows[0];
  if(!project||project.owner_id!==uid(req)){await client.query('ROLLBACK');return reply.code(404).send({error:'Проект не найден или не принадлежит вам'});}
  if(project.deleted_at){await client.query('ROLLBACK');return reply.code(409).send({error:'Проект уже находится в корзине'});}
  if(await findActiveProjectOperation(client,id)){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'В проекте есть незавершённые процессы. Завершите или отмените их перед переносом в корзину.'});
  }
  const moved=await client.query('UPDATE projects SET deleted_at=now() WHERE id=$1 RETURNING id,name,deleted_at',[id]);
  await client.query('COMMIT');return moved.rows[0];
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.post('/api/projects/:id/restore',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 const restored=await pool.query('UPDATE projects SET deleted_at=NULL WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL RETURNING id,name,description',[id,uid(req)]);
 if(!restored.rowCount)return reply.code(404).send({error:'Проект не найден в корзине'});
 return restored.rows[0];
});
app.delete('/api/projects/:id/permanent',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 const {confirmation}=parse(z.object({confirmation:z.string().max(120)}),req.body||{});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const found=await client.query('SELECT id,name,owner_id,deleted_at FROM projects WHERE id=$1 FOR UPDATE',[id]);
  const project=found.rows[0];
  if(!project||project.owner_id!==uid(req)||!project.deleted_at){
   await client.query('ROLLBACK');return reply.code(404).send({error:'Проект отсутствует в корзине'});
  }
  if(!projectDeletionConfirmation(project.name,confirmation)){
   await client.query('ROLLBACK');return reply.code(400).send({error:'Для окончательного удаления введите точное название проекта'});
  }
  if(await findActiveProjectOperation(client,id)){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'Найдены незавершённые процессы. Удаление остановлено без потери данных.'});
  }
  // Only project-scoped links cascade. Credentials are personal resources and
  // must survive project deletion, even when this was their last project.
  // No GitHub API operations are performed.
  await client.query('DELETE FROM projects WHERE id=$1',[id]);
  await client.query('COMMIT');
  return {deleted:true,project_id:id,github_untouched:true};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.post('/api/projects',async(req,reply)=>{
 const {name,description}=parse(z.object({name:z.string().trim().min(1).max(120),description:z.string().max(5000).default('')}),req.body);
 const id=randomUUID(),client=await pool.connect();
 try{await client.query('BEGIN');
 await client.query('INSERT INTO projects(id,name,description,owner_id) VALUES($1,$2,$3,$4)',[id,name,description,uid(req)]);
 await client.query('INSERT INTO memberships(project_id,user_id,role) VALUES($1,$2,$3)',[id,uid(req),'admin']);
 for(let i=0;i<workflowDefaults.length;i++){const [stage,label,mode]=workflowDefaults[i];const agent=workflowAgentDefaults[stage];await client.query('INSERT INTO workflow_stages(project_id,stage,label,mode,position,agent_name,agent_instructions,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,stage,label,mode,i,agent?.name??'',agent?.instructions??'',workflowStageDescriptions[stage]??'']);}
 await client.query("INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions) VALUES($1,'devops','AI-DevOps',$2) ON CONFLICT DO NOTHING",[id,agentInstructions.devops]);
 await client.query(`INSERT INTO project_conversation_agents(project_id,role,agent_name,agent_instructions)
  VALUES($1,'manager','Менеджер проекта',$2),($1,'analyst','Бизнес-аналитик',$3)
  ON CONFLICT(project_id,role) DO NOTHING`,[id,agentInstructions.manager,agentInstructions.analyst]);
 await client.query('INSERT INTO project_deployment_settings(project_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
 await client.query('COMMIT');return reply.code(201).send({id,name,description});}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.get('/api/projects/:id',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const r=await pool.query('SELECT * FROM projects WHERE id=$1',[id]);return r.rows[0];});

}

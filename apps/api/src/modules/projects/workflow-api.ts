import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {validateHealthUrl} from '../../deployment-automation.js';
import {workflowResponsibility} from '../../workflow-responsibilities.js';
import {validStages,validMode} from './domain/workflow-stages.js';

type Deps={
 pool:Pool;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/** Workflow configuration and specialist deployment controls.
 * Keep user-triggered transitions atomic and distinct from Temporal execution.
 */
export function registerWorkflowSettingsRoutes(app:FastifyInstance,{pool,uid,access,requireAdmin}:Deps){
app.get('/api/projects/:id/specialist-agents/devops',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const r=await pool.query("SELECT role,agent_name,agent_instructions,updated_at FROM project_specialist_agents WHERE project_id=$1 AND role='devops'",[id]);
 return r.rows[0]||reply.code(404).send({error:'DevOps-агент не настроен'});
});
app.put('/api/projects/:id/specialist-agents/devops',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const p=parse(z.object({agent_name:z.string().trim().min(1).max(120),agent_instructions:z.string().trim().min(1).max(12000)}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const r=await client.query("INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions) VALUES($1,'devops',$2,$3) ON CONFLICT(project_id,role) DO UPDATE SET agent_name=EXCLUDED.agent_name,agent_instructions=EXCLUDED.agent_instructions,updated_at=now() RETURNING role,agent_name,agent_instructions,updated_at",[id,p.agent_name,p.agent_instructions]);
  await client.query("UPDATE workflow_stages SET agent_name=$2,agent_instructions=$3 WHERE project_id=$1 AND stage='deployment'",[id,p.agent_name,p.agent_instructions]);
  await client.query('COMMIT');
  return r.rows[0];
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.get('/api/projects/:id/deployment/settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 return (await pool.query("SELECT mode,health_url,environment,updated_at FROM project_deployment_settings WHERE project_id=$1",[id])).rows[0]||{mode:'skip'};
});
app.put('/api/projects/:id/deployment/settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {mode,health_url,environment}=parse(z.object({
  mode:z.enum(['skip','manual','automatic']),
  health_url:z.string().max(300).default(''),
  environment:z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).default('production')
 }),req.body);
 if(mode==='automatic'&&!health_url)return reply.code(400).send({error:'Настрой HTTPS URL проверки окружения'});
 if(health_url)validateHealthUrl(health_url);
 const updated=await pool.query("INSERT INTO project_deployment_settings(project_id,mode,health_url,environment) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET mode=$2,health_url=$3,environment=$4,updated_at=now() RETURNING mode,health_url,environment,updated_at",[id,mode,health_url,environment]);
 return updated.rows[0];
});
app.post('/api/projects/:id/tasks/:taskId/deployment/resolve',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {outcome,reason}=parse(z.object({outcome:z.enum(['skipped','manual_confirmed']),reason:z.string().trim().min(5).max(1500)}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const task=await client.query("SELECT stage FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE",[id,taskId]);
  if(!task.rowCount||task.rows[0].stage!=='deployment'){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Задача не находится на этапе выкладки'});
  }
  const record=await client.query("UPDATE task_deployment_records SET status=$3,reason=$4,actor_id=$5,updated_at=now() WHERE project_id=$1 AND task_id=$2 AND status='pending' RETURNING task_id",[id,taskId,outcome,reason,uid(req)]);
  if(!record.rowCount)throw Object.assign(new Error('Не найдена ожидающая выкладка для этой задачи'),{statusCode:409});
  await client.query("UPDATE tasks SET stage='documentation',updated_at=now() WHERE project_id=$1 AND id=$2",[id,taskId]);
  await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)",[randomUUID(),taskId,uid(req),outcome==='skipped'?'deployment_skipped':'deployment_manual_confirmed',reason]);
  await client.query('COMMIT');
  return {stage:'documentation',deployment_status:outcome};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.get('/api/projects/:id/workflow',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT stage,label,mode,position,agent_name,agent_instructions,description FROM workflow_stages WHERE project_id=$1 ORDER BY position',[id])).rows.map(stage=>({...stage,responsibility:workflowResponsibility(stage.stage)}));});
app.patch('/api/projects/:id/workflow/:stage',async(req:any,reply)=>{
 const {id,stage}=parse(z.object({id:z.string().uuid(),stage:validStages}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const {mode,agent_name,agent_instructions,description}=parse(z.object({
  description:z.string().trim().max(320).optional(),
  mode:validMode.optional(),
  agent_name:z.string().trim().min(1).max(100).optional(),
  agent_instructions:z.string().max(12000).optional()
 }).refine(v=>Object.keys(v).length>0,'Укажи настройку для изменения'),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const updated=await client.query(
   'UPDATE workflow_stages SET mode=COALESCE($1,mode),agent_name=COALESCE($2,agent_name),agent_instructions=COALESCE($3,agent_instructions),description=COALESCE($4,description) WHERE project_id=$5 AND stage=$6 RETURNING stage,label,mode,position,agent_name,agent_instructions,description',
   [mode??null,agent_name??null,agent_instructions??null,description??null,id,stage]);
  if(!updated.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Этап не найден'});}
  if(stage==='deployment'&&(agent_name!==undefined||agent_instructions!==undefined)){
   const current=updated.rows[0];
   await client.query("INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions) VALUES($1,'devops',$2,$3) ON CONFLICT(project_id,role) DO UPDATE SET agent_name=EXCLUDED.agent_name,agent_instructions=EXCLUDED.agent_instructions,updated_at=now()",
    [id,current.agent_name,current.agent_instructions]);
  }
  await client.query('COMMIT');
  return updated.rows[0];
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});

}

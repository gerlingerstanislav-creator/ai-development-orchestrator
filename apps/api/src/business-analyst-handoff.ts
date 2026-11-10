import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
const uuid=z.string().uuid();

/** The BA cannot create backlog tasks via model tools. Only an explicit user
 * action on this authenticated endpoint transfers an approved scope to the SA. */
export function registerBusinessAnalystHandoff(app:FastifyInstance,deps:{
 pool:Pool;uid:(req:any)=>string;access:(req:any,reply:any,id:string)=>Promise<boolean>;
}){
 const {pool,uid,access}=deps;
 app.post('/api/projects/:id/business-analyst/handoff',async(req:any,reply)=>{
  const params=z.object({id:uuid}).safeParse(req.params);
  if(!params.success)return reply.code(400).send({error:'Некорректный идентификатор проекта'});
  const {id}=params.data;
  if(!await access(req,reply,id))return;
  const payload=z.object({
   title:z.string().trim().min(5).max(220),
   description:z.string().trim().min(20).max(18000),
   approved:z.literal(true)
  }).safeParse(req.body);
  if(!payload.success)return reply.code(400).send({error:'Укажи название и описание согласованного пакета и подтверди передачу',details:payload.error.flatten()});
  const {title,description}=payload.data;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const taskId=randomUUID();
   await client.query("INSERT INTO tasks(id,project_id,title,description,type,stage,analysis_state,position) VALUES($1,$2,$3,$4,'task','analysis','new',(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2))",
    [taskId,id,title,description]);
   await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'created','Согласованный пакет изменений передан бизнес-аналитиком системному аналитику')",
    [randomUUID(),taskId,uid(req)]);
   await client.query('COMMIT');
   return reply.code(201).send({task_id:taskId,stage:'analysis',message:'Пакет передан системному аналитику'});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
 });
}

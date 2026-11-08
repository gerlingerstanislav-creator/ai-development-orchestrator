import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

type Dependencies={
 pool:pg.Pool; uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 codexUrl:string; runnerKey:string;
};
const messageSchema=z.object({message:z.string().trim().min(3).max(4000)});
function jsonObject(text:string):Record<string,unknown>{
 const first=text.indexOf('{'),last=text.lastIndexOf('}');
 if(first<0||last<=first)throw new Error('AI не вернул структурированный ответ');
 try{return JSON.parse(text.slice(first,last+1));}
 catch{throw new Error('AI вернул некорректный JSON. Повтори запрос.');}
}
export function registerAssistantRoutes(app:FastifyInstance,deps:Dependencies){
 const {pool,uid,access,requireAdmin,codexUrl,runnerKey}=deps;
 async function configuration(id:string){
  const r=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
  return r.rows[0]||{model:'gpt-6-luna',reasoning:'low',enabled:false};
 }
 async function checkQuota(id:string,reply:any){
  const r=await pool.query("SELECT count(*)::int AS n FROM assistant_usage WHERE project_id=$1 AND created_at > now() - interval '24 hours'",[id]);
  if(r.rows[0].n>=20){reply.code(429).send({error:'Лимит AI-переписки: 20 запросов за 24 часа'});return false;}
  return true;
 }
 async function completion(prompt:string,config:any){
  const response=await fetch(codexUrl+'/assistant',{method:'POST',
   headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt}),
   signal:AbortSignal.timeout(115000)});
  const data=await response.json() as any;
  if(!response.ok)throw new Error(String(data.error||'Codex недоступен').slice(0,700));
  if(typeof data.message!=='string'||!data.message.trim())throw new Error('Codex вернул пустой ответ');
  return data.message.trim().slice(0,16000);
 }
 async function history(id:string,taskId:string|null){
  const r=await pool.query('SELECT role,body FROM assistant_messages WHERE project_id=$1 AND task_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC LIMIT 10',[id,taskId]);
  return r.rows.reverse().map(x=>x.role+': '+x.body.slice(0,1600)).join('\n\n');
 }
 async function store(id:string,taskId:string|null,actor:string|null,role:'user'|'assistant',body:string,createdTask:string|null=null){
  await pool.query('INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,created_task_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [randomUUID(),id,taskId,actor,role,body,createdTask]);
 }
 async function countCall(id:string,actor:string){
  await pool.query('INSERT INTO assistant_usage(id,project_id,actor_id) VALUES($1,$2,$3)',[randomUUID(),id,actor]);
 }
 app.get('/api/projects/:id/assistant/messages',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id))return;
  return (await pool.query('SELECT id,role,body,created_task_id,created_at FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL ORDER BY created_at ASC LIMIT 100',[id])).rows;
 });
 app.post('/api/projects/:id/assistant',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message}=messageSchema.parse(req.body);
  const config=await configuration(id);
  if(!config.enabled)return reply.code(409).send({error:'Включи ручной AI в настройках проекта'});
  if(!await checkQuota(id,reply))return;
  const create=/(создай|создать|добавь|заведи|оформи)\s+.{0,100}(задач[уаи]|таск)|(задач[уаи]|таск)\s+.{0,100}(создай|создать|добавь|заведи|оформи)/i.test(message);
  const project=await pool.query('SELECT name,description FROM projects WHERE id=$1',[id]);
  const conversation=await history(id,null);
  let prompt:string;
  if(create){
   const existing=await pool.query('SELECT title FROM tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 25',[id]);
   prompt=['Составь одну задачу разработки по запросу пользователя. Ответь ТОЛЬКО JSON без Markdown.',
    'Формат: {"title":"краткое название","description":"конкретное требование и критерии приёмки"}',
    'Не выдумывай детали и не создавай несколько задач.',
    'Проект: '+project.rows[0].name,
    'Уже существующие задачи: '+existing.rows.map(x=>x.title).join(' | '),
    'История:\n'+conversation,'Запрос:\n'+message].join('\n\n');
  }else{
   prompt=['Ты ассистент проекта разработки. Отвечай кратко, по делу и на русском.',
    'Не создавай задачу, если пользователь не попросил об этом явно.',
    'Проект: '+project.rows[0].name,'Описание: '+project.rows[0].description.slice(0,2000),
    'История:\n'+conversation,'Запрос:\n'+message].join('\n\n');
  }
  const raw=await completion(prompt,config);
  let taskId:string|null=null,answer=raw;
  if(create){
   const data=z.object({title:z.string().trim().min(3).max(180),description:z.string().trim().min(3).max(10000)}).parse(jsonObject(raw));
   taskId=randomUUID();
   await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage) VALUES($1,$2,$3,$4,'task','backlog')",[taskId,id,data.title,data.description]);
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'created','Создано из AI-чата проекта']);
   answer='Создана задача: '+data.title+'\n\n'+data.description;
  }
  await store(id,null,uid(req),'user',message);
  await store(id,null,null,'assistant',answer,taskId);
  await countCall(id,uid(req));
  return {message:answer,created_task_id:taskId};
 });
}

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

type Dependencies={
 pool:Pool; uid:(req:any)=>string;
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
 async function rulesContext(id:string){
  const r=await pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 80',[id]);
  return r.rows.map(x=>'- '+x.body).join('\n').slice(0,12000);
 }
  async function checkQuota(_id:string,reply:any){
  const settings=await pool.query('SELECT chat_requests_per_24h FROM service_ai_limits WHERE id=1');
  const limit=Number(settings.rows[0]?.chat_requests_per_24h||0);
  if(limit===0)return true;
  const used=await pool.query("SELECT count(*)::int AS n FROM assistant_usage WHERE created_at > now() - interval '24 hours'");
  if(used.rows[0].n>=limit){reply.code(429).send({error:'Достигнут общий лимит ChatGPT-запросов сервиса за 24 часа'});return false;}
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
  const rules=await rulesContext(id);
  const repoLink=(await pool.query('SELECT repository,default_branch,target_branch FROM project_git_repositories WHERE project_id=$1',[id])).rows[0];
  const repoContext=repoLink
   ? 'GitHub-репозиторий уже подключён: '+repoLink.repository+'. Целевая ветка PR: '+(repoLink.target_branch||repoLink.default_branch)+'. Не задавай вопросов о выборе репозитория, ветки или способе публикации, если это не явное требование пользователя. GitHub Pages не предполагается по умолчанию.'
   : 'GitHub-репозиторий ещё не привязан к проекту. Если для исполнения потребуется репозиторий, сообщи об этом как о настройке, не предлагай GitHub Pages без явного запроса.';
  let prompt:string;
  let existingIds:string[]=[];
  if(create){
   const existing=await pool.query('SELECT id,title,description,stage FROM tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',[id]);
   existingIds=existing.rows.map((t:{id:string})=>t.id);
   const docs=await pool.query('SELECT title,body FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 10',[id]);
   prompt=['Составь одну задачу разработки по запросу пользователя. Ответь ТОЛЬКО JSON без Markdown.',
    'Формат: {"title":"краткое название","description":"конкретное ТЗ и критерии приёмки","questions":["только блокирующие вопросы"],"related_ids":["UUID существующих похожих задач"],"relation_reason":"объяснение потенциальных пересечений","suggested_rules":["только универсальные правила для проекта, если выявлена повторяющаяся закономерность"]}.',
    'Сначала проверь всю постановку на неопределённости и сформируй сразу ПОЛНЫЙ список всех существенных блокирующих вопросов одним ответом. Не задавай их по одному в последовательных диалогах.',
    'Не задавай вопросы, ответ на которые уже есть в контексте или настройках проекта. Если запрос достаточно ясен, questions должен быть [].',
    'Из списка задач выбирай только реальные UUID, не выдумывай идентификаторы.',
    'При похожей задаче не объединяй карточки автоматически, только предложи связь.',
    'Не выдумывай детали и не создавай несколько задач.',
    'Утверждённые правила проекта (соблюдай, не меняй):\n'+rules,
    'Контекст GitHub проекта: '+repoContext,
    'Проект: '+project.rows[0].name,
    'Другие задачи (UUID, название и описание): '+JSON.stringify(existing.rows).slice(0,9000),
    'Документы проекта: '+JSON.stringify(docs.rows).slice(0,9000),
    'История:\n'+conversation,'Запрос:\n'+message].join('\n\n');
  }else{
   prompt=['Ты ассистент проекта разработки. Отвечай кратко, по делу и на русском.',
    'Не создавай задачу, если пользователь не попросил об этом явно.',
    'Правила проекта:\n'+rules,
    'GitHub проекта: '+repoContext,
    'Проект: '+project.rows[0].name,'Описание: '+project.rows[0].description.slice(0,2000),
    'История:\n'+conversation,'Запрос:\n'+message].join('\n\n');
  }
  let raw:string;
  try{raw=await completion(prompt,config);}catch(error){return reply.code(503).send({error:'Ошибка Codex: '+String(error instanceof Error?error.message:error).slice(0,350)});}
  let taskId:string|null=null,answer=raw;
  if(create){
   const data=z.object({
    title:z.string().trim().min(3).max(180),description:z.string().trim().min(3).max(10000),
    questions:z.array(z.string().min(3).max(600)).max(20).default([]),
    related_ids:z.array(z.string().uuid()).max(10).default([]),
    relation_reason:z.string().max(1500).optional(),
    suggested_rules:z.array(z.string().trim().min(5).max(800)).max(5).default([])
   }).parse(jsonObject(raw));
   taskId=randomUUID();
   const related=data.related_ids.filter(x=>existingIds.includes(x));
   const state=data.questions.length?'needs_clarification':'ready_for_development';
   await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage,analysis_state,clarification_questions,related_task_ids) VALUES($1,$2,$3,$4,'task','analysis',$5,$6,$7)",
     [taskId,id,data.title,data.description,state,JSON.stringify(data.questions),JSON.stringify(related)]);
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
     [randomUUID(),taskId,uid(req),'created','Создано через AI-чат и проанализировано']);
   const analysisNote=(data.questions.length?'Нужно уточнить:\n'+data.questions.map((q,i)=>(i+1)+'. '+q).join('\n'):'Вопросов, блокирующих разработку, нет. Можно отправлять задачу в разработку.')+
    (related.length?'\n\nПотенциально связанные задачи: '+related.join(', ')+'\n'+(data.relation_reason||''):'');
   for(const rule of data.suggested_rules){
    const exists=await pool.query("SELECT 1 FROM project_rules WHERE project_id=$1 AND lower(body)=lower($2) UNION ALL SELECT 1 FROM project_rule_suggestions WHERE project_id=$1 AND lower(body)=lower($2) AND status='pending' LIMIT 1",[id,rule]);
    if(!exists.rowCount)await pool.query('INSERT INTO project_rule_suggestions(id,project_id,task_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),id,taskId,rule]);
   }
   await store(id,taskId,null,'assistant',analysisNote);
   answer='Создана задача в колонке «Анализ»: '+data.title+'\n\n'+(data.questions.length?'Вопросы находятся в чате задачи.':'ТЗ готово к подтверждению.')+
      (related.length?'\nОбнаружены связанные задачи: '+related.length:'');
  }
  await store(id,null,uid(req),'user',message);
  await store(id,null,null,'assistant',answer,taskId);
  await countCall(id,uid(req));
  return {message:answer,created_task_id:taskId};
 });
 app.get('/api/projects/:id/tasks/:taskId/assistant/messages',async(req:any,reply)=>{
  const {id,taskId}=z.object({id:z.string().uuid(),taskId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id))return;
  const t=await pool.query('SELECT 1 FROM tasks WHERE project_id=$1 AND id=$2',[id,taskId]);
  if(!t.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  return (await pool.query('SELECT id,role,body,created_at FROM assistant_messages WHERE project_id=$1 AND task_id=$2 ORDER BY created_at ASC LIMIT 120',[id,taskId])).rows;
 });
 app.post('/api/projects/:id/tasks/:taskId/assistant',async(req:any,reply)=>{
  const {id,taskId}=z.object({id:z.string().uuid(),taskId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message,mode}=messageSchema.extend({mode:z.enum(['chat','analyze']).default('chat')}).parse(req.body);
  const result=await pool.query('SELECT title,description,stage,analysis_state,clarification_questions FROM tasks WHERE project_id=$1 AND id=$2',[id,taskId]);
  if(!result.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  const task=result.rows[0];
  if(mode==='analyze'&&task.stage!=='analysis')return reply.code(409).send({error:'Перемести задачу в колонку «Анализ»'});
  const config=await configuration(id);
  if(!config.enabled)return reply.code(409).send({error:'Включи ручной AI в настройках проекта'});
  if(!await checkQuota(id,reply))return;
  const other=await pool.query('SELECT id,title,description,stage FROM tasks WHERE project_id=$1 AND id<>$2 ORDER BY updated_at DESC LIMIT 30',[id,taskId]);
  const link=(await pool.query('SELECT repository,default_branch,target_branch FROM project_git_repositories WHERE project_id=$1',[id])).rows[0];
  const repoContext=link?'Подключённый репозиторий: '+link.repository+'; целевая ветка: '+(link.target_branch||link.default_branch)+'. НЕ задавай вопросы о репозитории, выборе GitHub Pages и целевой ветке без прямого запроса пользователя.':'GitHub-репозиторий не подключён.';
  const rules=await rulesContext(id);
  const docs=await pool.query('SELECT title,body FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 8',[id]);
  const context=['Утверждённые правила проекта:\n'+rules,'Настройки GitHub проекта:\n'+repoContext,'Документы проекта:\n'+JSON.stringify(docs.rows).slice(0,6500),'Название: '+task.title,'Описание:\n'+task.description.slice(0,9000),
   'Открытые вопросы: '+JSON.stringify(task.clarification_questions),
   'Другие задачи проекта: '+JSON.stringify(other.rows).slice(0,9000),
   'История:\n'+await history(id,taskId),'Сообщение пользователя:\n'+message].join('\n\n');
  const refining=task.stage==='analysis';
  const prompt=refining?[
   'Ты системный аналитик. Ответ пользователя может уточнять открытые вопросы или содержать дополнительное требование. Обнови ТЗ, не теряя ранее согласованные требования.',
   'Верни только валидный JSON {"summary":"краткое актуальное ТЗ с критериями приёмки","details":"что уточнили, что осталось проверить, обнаруженные пересечения задач","questions":["только оставшиеся блокирующие вопросы"],"related_ids":["UUID связанных задач из списка"],"suggested_rules":["только универсальные полезные правила для будущих задач"]}.',
   'Проанализируй сразу ВСЕ возможные блокирующие вопросы, возвращай их единым списком questions. Не дроби уточнения на серию последовательных вопросов. Не спрашивай известные настройки проекта.',
   'Если нет блокирующих вопросов, верни пустой массив questions. Не придумывай ответы. Не объединяй карточки без разрешения.',
   context
  ].join('\n\n'):[
   'Ты инженерный AI-помощник внутри задачи. Ответь на русском по существу. Не утверждай, что менял код.',context
  ].join('\n\n');
  let raw:string;
  try{raw=await completion(prompt,config);}catch(error){return reply.code(503).send({error:'Ошибка Codex: '+String(error instanceof Error?error.message:error).slice(0,350)});}
  let summary:string|null=null,answer=raw;
  let questions:string[]=[];
  if(refining){
   const analyzed=z.object({
    summary:z.string().trim().min(10).max(10000),details:z.string().trim().min(3).max(16000),
    questions:z.array(z.string().min(3).max(600)).max(20).default([]),
    related_ids:z.array(z.string().uuid()).max(10).default([]),
    suggested_rules:z.array(z.string().trim().min(5).max(800)).max(5).default([])
   }).parse(jsonObject(raw));
   summary=analyzed.summary;questions=analyzed.questions;
   answer=analyzed.details+(questions.length?'\n\nОстались вопросы:\n'+questions.map((q,i)=>(i+1)+'. '+q).join('\n'):'\n\nБлокирующих вопросов нет. Можно отправлять задачу в разработку.');
   const related=analyzed.related_ids.filter(x=>other.rows.some(o=>o.id===x));
   await pool.query("UPDATE tasks SET description=$1,clarification_questions=$2,related_task_ids=$3,analysis_state=$4,updated_at=now() WHERE id=$5 AND project_id=$6",
    [summary,JSON.stringify(questions),JSON.stringify(related),questions.length?'needs_clarification':'ready_for_development',taskId,id]);
   for(const rule of analyzed.suggested_rules){
    const dup=await pool.query("SELECT 1 FROM project_rules WHERE project_id=$1 AND lower(body)=lower($2) UNION ALL SELECT 1 FROM project_rule_suggestions WHERE project_id=$1 AND lower(body)=lower($2) AND status='pending' LIMIT 1",[id,rule]);
    if(!dup.rowCount)await pool.query('INSERT INTO project_rule_suggestions(id,project_id,task_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),id,taskId,rule]);
   }
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(),taskId,uid(req),'analyzed','ТЗ и открытые вопросы обновлены по результатам AI-анализа']);
  }
  await store(id,taskId,uid(req),'user',mode==='analyze'?message+'\n\nИсходное описание до анализа:\n'+task.description:message);
  await store(id,taskId,null,'assistant',answer);
  await countCall(id,uid(req));
  return {message:answer,summary,questions};
 });


 app.post('/api/projects/:id/tasks/:taskId/approve-development',async(req:any,reply)=>{
  const {id,taskId}=z.object({id:z.string().uuid(),taskId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const task=await pool.query('SELECT stage,analysis_state,clarification_questions FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
  if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  if(task.rows[0].stage!=='analysis'||task.rows[0].analysis_state!=='ready_for_development'||(task.rows[0].clarification_questions||[]).length)
   return reply.code(409).send({error:'Сначала ответь на блокирующие вопросы AI-аналитика'});
  await pool.query("UPDATE tasks SET stage='development',analysis_state='approved',updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,id]);
  await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'stage_changed','Анализ → Разработка')",[randomUUID(),taskId,uid(req)]);
  return {ok:true};
 });

}

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {extractGitHubDocumentLocation,readGitHubMarkdownFiles,wantsDocumentSynthesis} from './github-document-import.js';

type Dependencies={
 pool:Pool; uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 codexUrl:string; runnerKey:string; decryptToken:(encrypted:string)=>string;
};
const messageSchema=z.object({message:z.string().trim().min(3).max(4000)});
function jsonObject(text:string):Record<string,unknown>{
 const first=text.indexOf('{'),last=text.lastIndexOf('}');
 if(first<0||last<=first)throw new Error('AI не вернул структурированный ответ');
 try{return JSON.parse(text.slice(first,last+1));}
 catch{throw new Error('AI вернул некорректный JSON. Повтори запрос.');}
}
export function registerAssistantRoutes(app:FastifyInstance,deps:Dependencies){
 const {pool,uid,access,requireAdmin,codexUrl,runnerKey,decryptToken}=deps;
 async function configuration(id:string){
  const r=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
  return r.rows[0]||{model:'gpt-6-luna',reasoning:'low',enabled:false};
 }
 async function rulesContext(id:string){
  const r=await pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 80',[id]);
  return r.rows.map(x=>'- '+x.body).join('\n').slice(0,12000);
 }
  async function completion(prompt:string,config:any){
  const response=await fetch(codexUrl+'/assistant',{method:'POST',
   headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt}),
   signal:AbortSignal.timeout(115000)});
  const data=await response.json() as any;
  if(!response.ok)throw new Error(String(data.error||'Codex недоступен').slice(0,700));
  if(typeof data.message!=='string'||!data.message.trim())throw new Error('Codex вернул пустой ответ');
  return {text:data.message.trim().slice(0,16000),usage:data.usage as {input_tokens:number;cached_input_tokens:number;output_tokens:number}|undefined};
 }
 async function history(id:string,taskId:string|null){
  const r=await pool.query('SELECT role,body FROM assistant_messages WHERE project_id=$1 AND task_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC LIMIT 10',[id,taskId]);
  return r.rows.reverse().map(x=>x.role+': '+x.body.slice(0,1600)).join('\n\n');
 }
 async function store(id:string,taskId:string|null,actor:string|null,role:'user'|'assistant',body:string,createdTask:string|null=null,createdDocument:string|null=null){
  await pool.query('INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,created_task_id,created_document_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [randomUUID(),id,taskId,actor,role,body,createdTask,createdDocument]);
 }
 async function storeTokenUsage(id:string,taskId:string|null,model:string,usage:{input_tokens:number;cached_input_tokens:number;output_tokens:number}|undefined){
  if(!usage)return;
  await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,'chat',$5,$6,$7,$8)",
   [randomUUID(),id,taskId,randomUUID(),model,Math.max(0,Number(usage.input_tokens)||0),Math.max(0,Number(usage.cached_input_tokens)||0),Math.max(0,Number(usage.output_tokens)||0)]);
 }
 async function countCall(id:string,actor:string){
  await pool.query('INSERT INTO assistant_usage(id,project_id,actor_id) VALUES($1,$2,$3)',[randomUUID(),id,actor]);
 }
 app.get('/api/projects/:id/assistant/messages',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id))return;
  return (await pool.query('SELECT id,role,body,created_task_id,created_document_id,created_at FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL ORDER BY created_at ASC LIMIT 100',[id])).rows;
 });
 app.post('/api/projects/:id/assistant',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message}=messageSchema.parse(req.body);
  const conversation=await history(id,null);
  const location=extractGitHubDocumentLocation(message,conversation);
  const synthesize=wantsDocumentSynthesis(message,conversation)||
   !!location&&/(?:перенес|импортир|загруз|созда|сформир|сдела|подготов)/i.test(message)&&
   /(?:документ|страниц|на основе|на базе|из репозитория)/i.test(message);
  if(synthesize){
   if(!location)return reply.code(409).send({error:'Для создания документов на основе GitHub пришли ссылку на исходный каталог, например https://github.com/owner/repo/tree/main/docs'});
   const config=await configuration(id);
   if(!config.enabled)return reply.code(409).send({error:'Включи AI в настройках проекта: для переработки документации требуется Codex.'});
   try{
    const connected=await pool.query("SELECT secret_encrypted FROM connections WHERE owner_id=$1 AND provider='github_token' ORDER BY created_at DESC LIMIT 8",[uid(req)]);
    const tokens:string[]=[];
    for(const c of connected.rows){try{tokens.push(decryptToken(c.secret_encrypted));}catch{continue;}}
    const files=await readGitHubMarkdownFiles(location,tokens);
    if(!files.length)return reply.code(409).send({error:'В указанном каталоге нет Markdown-файлов.'});
    const project=await pool.query('SELECT name,description FROM projects WHERE id=$1',[id]);
    const existingDocs=await pool.query('SELECT title,body FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 20',[id]);
    const rules=await rulesContext(id);
    // Feed source documents to Codex, not an assumed summary. Bound per file size
    // so every input file is represented even for large collections.
    const perFile=Math.max(4000,Math.floor(115000/files.length));
    const sourceText=files.map((file,i)=>{
     const excerpt=file.body.slice(0,perFile);
     return '### Source '+(i+1)+': '+file.path+'\n'+excerpt+
      (excerpt.length<file.body.length?'\n[ФАЙЛ ДЛИННЕЕ ЛИМИТА КОНТЕКСТА — ПРОДОЛЖЕНИЕ НЕ ВКЛЮЧЕНО]':'');
    }).join('\n\n');
    const prompt=[
     'Ты системный аналитик и технический писатель. Переработай существующие документы из GitHub в НОВЫЙ СОГЛАСОВАННЫЙ НАБОР ДОКУМЕНТОВ для текущего проекта в приложении.',
     'Не копируй документы один к одному. Синтезируй структуру, устрани повторы, распредели информацию по тематическим страницам. Сохрани факты и ограничения исходников. Не выдавай исходную идею за уже реализованную систему.',
     'Верни ТОЛЬКО корректный JSON без Markdown-обёртки, формат {"collection_title":"Название раздела","documents":[{"title":"Название новой страницы","body":"Полный Markdown","sources":["пути исходных файлов"]}],"notes":"кратко об ограничениях и предположениях"}.',
     'Создай 3-6 содержательных документов. Предложенные темы: обзор проекта, функциональные требования, пользовательские сценарии, архитектура/ограничения, MVP и план развития. Подстрой под содержание исходников.',
     'Каждый документ должен содержать самостоятельный Markdown с заголовками и конкретными фактами. Для неточных или противоречивых пунктов добавь явное указание, что требуется решение.',
     'Запрещено записывать файлы обратно в GitHub. Это содержимое для внутреннего раздела «Документация» приложения. Пользователь явно запросил НОВЫЙ набор, а не импорт исходных файлов.',
     'Имена файлов источников допустимы только из списка ниже. Добавь в конец каждого документа раздел «Источники» с ссылками/именами использованных файлов. Новые факты не выдумывай.',
     'Название текущего проекта: '+String(project.rows[0]?.name||''),
     'Описание текущего проекта: '+String(project.rows[0]?.description||'').slice(0,3000),
     'Правила: '+rules.slice(0,6000),
     'Уже созданные страницы в проекте: '+JSON.stringify(existingDocs.rows.map((d:any)=>({title:d.title,excerpt:String(d.body).slice(0,600)}))).slice(0,6000),
     'Инструкция пользователя: '+message,
     'Исходный репозиторий: '+location.owner+'/'+location.repository+' (ветка '+location.branch+', каталог '+location.path+')',
     'Исходные Markdown-файлы ('+files.length+'):\n'+sourceText
    ].join('\n\n');
    const result=await completion(prompt,config);
    await storeTokenUsage(id,null,config.model,result.usage);
    const structure=z.object({
     collection_title:z.string().trim().min(3).max(180),
     documents:z.array(z.object({
      title:z.string().trim().min(3).max(180),
      body:z.string().trim().min(100).max(15000),
      sources:z.array(z.string()).default([])
     })).min(2).max(8),
     notes:z.string().max(2000).default('')
    }).parse(jsonObject(result.text));
    const client=await pool.connect();
    let rootId:string;
    const sourceKey='github-ai:'+location.owner+'/'+location.repository+'@'+location.branch+':'+location.path;
    try{
     await client.query('BEGIN');
     const root=await client.query(
      "INSERT INTO documents(id,project_id,title,body,parent_id,import_source) VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO UPDATE SET title=EXCLUDED.title RETURNING id",
      [randomUUID(),id,structure.collection_title,
       '# '+structure.collection_title+'\n\nДокументация составлена AI на основе '+files.length+' Markdown-файлов из '+location.owner+'/'+location.repository+'.\n\n'+structure.notes,
       sourceKey]);
     rootId=root.rows[0].id;
     for(const [idx,doc] of structure.documents.entries()){
      const docKey=sourceKey+'/generated/'+idx;
      const sources=doc.sources.filter(name=>files.some(file=>file.path===name));
      const body=doc.body+(sources.length?'\n\n---\n**Исходные материалы:** '+sources.join(', '):'');
      await client.query(
       "INSERT INTO documents(id,project_id,title,body,parent_id,import_source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO NOTHING",
       [randomUUID(),id,doc.title,body,rootId,docKey]);
     }
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const answer='Создан новый набор документов на основе материалов из '+location.owner+'/'+location.repository+': '+structure.documents.length+' тематических страниц. AI переработал исходные материалы и разместил их в разделе «Документация» проекта. '+(structure.notes?'\n\nПримечания: '+structure.notes:'');
    await store(id,null,uid(req),'user',message);
    await store(id,null,null,'assistant',answer,null,rootId!);
    await countCall(id,uid(req));
    return {message:answer,created_task_id:null,created_document_id:rootId!,generated_documents:structure.documents.length};
   }catch(error){
    const reason=error instanceof Error?error.message:'Неизвестная ошибка';
    return reply.code(409).send({error:'Не удалось создать набор документов: '+reason.slice(0,600)});
   }
  }
  const config=await configuration(id);
  if(!config.enabled)return reply.code(409).send({error:'Включи ручной AI в настройках проекта'});
  const create=/(создай|создать|добавь|заведи|оформи)\s+.{0,100}(задач[уаи]|таск)|(задач[уаи]|таск)\s+.{0,100}(создай|создать|добавь|заведи|оформи)/i.test(message);
  // Document commands take priority over task detection. Mentioning documentation
  // in a task request alone must NOT create a document.
  const createDocument=/(?:создай|создать|добавь|добавить|составь|напиши|подготовь|оформи|заведи)\s+(?:нов(?:ый|ую|ое)\s+)?(?:документ(?:ацию)?|страниц[уы]|раздел\s+документации|описание\s+проекта)(?![а-яёa-z])|(?:документ|страниц[ауеы]|документаци[юи])\s+.{0,70}(?:создай|создать|добавь|подготовь|напиши)/i.test(message);

  const project=await pool.query('SELECT name,description FROM projects WHERE id=$1',[id]);
  const rules=await rulesContext(id);
  const repoLink=(await pool.query('SELECT repository,default_branch,target_branch FROM project_git_repositories WHERE project_id=$1',[id])).rows[0];
  const repoContext=repoLink
   ? 'GitHub-репозиторий уже подключён: '+repoLink.repository+'. Целевая ветка PR: '+(repoLink.target_branch||repoLink.default_branch)+'. Не задавай вопросов о выборе репозитория, ветки или способе публикации, если это не явное требование пользователя. GitHub Pages не предполагается по умолчанию.'
   : 'GitHub-репозиторий ещё не привязан к проекту. Если для исполнения потребуется репозиторий, сообщи об этом как о настройке, не предлагай GitHub Pages без явного запроса.';
  let prompt:string;
  let existingIds:string[]=[];
  if(createDocument){
   const existingDocs=await pool.query('SELECT id,title,body,parent_id FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 40',[id]);
   prompt=['Ты технический писатель проекта. Пользователь явно попросил СОЗДАТЬ страницу документации. Верни ТОЛЬКО JSON без Markdown-обёртки.',
    'Формат: {"title":"название документа","body":"полноценное содержимое Markdown","parent_id":"UUID существующей родительской страницы или null"}.',
    'Не создавай задачу разработки. Подготовь содержательный документ на русском с заголовками и разделами.',
    'Не выдумывай факты о проекте. Когда информации мало, явно отмечай предположения и открытые вопросы.',
    'Разрешено выбрать parent_id исключительно из приведённых UUID. Если подходящего родителя нет, используй null.',
    'Название проекта: '+project.rows[0].name,
    'Описание проекта: '+project.rows[0].description.slice(0,3000),
    'Правила проекта:\n'+rules,
    'Настройки GitHub:\n'+repoContext,
    'Существующая документация: '+JSON.stringify(existingDocs.rows.map((doc:any)=>({...doc,body:String(doc.body).slice(0,2500)}))).slice(0,11000),
    'История чата:\n'+conversation,
    'Запрос пользователя:\n'+message].join('\n\n');
  }else if(create){
   const existing=await pool.query('SELECT id,title,description,stage FROM tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',[id]);
   existingIds=existing.rows.map((t:{id:string})=>t.id);
   const docs=await pool.query('SELECT title,body FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 10',[id]);
   prompt=['Составь одну задачу разработки по запросу пользователя. Ответь ТОЛЬКО JSON без Markdown.',
    'Формат: {"title":"краткое название","description":"конкретное ТЗ и критерии приёмки","questions":["только блокирующие вопросы"],"related_ids":["UUID существующих похожих задач"],"depends_on_task_id":"UUID задачи, от незавершённого кода которой действительно зависит новая задача, иначе null","relation_reason":"объяснение потенциальных пересечений","suggested_rules":["только универсальные правила для проекта, если выявлена повторяющаяся закономерность"]}.',
    'Сначала проверь всю постановку на неопределённости и сформируй сразу ПОЛНЫЙ список всех существенных блокирующих вопросов одним ответом. Не задавай их по одному в последовательных диалогах.',
    'Не задавай вопросы, ответ на которые уже есть в контексте или настройках проекта. Если запрос достаточно ясен, questions должен быть [].',
    'Из списка задач выбирай только реальные UUID, не выдумывай идентификаторы.',
    'Информационная похожесть НЕ означает кодовую зависимость. Заполняй depends_on_task_id только если для реализации новой задачи требуется код или функциональность другой ещё не слитой задачи. Выбирай один непосредственный родитель из доступных UUID. Связанные задачи без зависимости остаются в related_ids.',
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
  try{const response=await completion(prompt,config);raw=response.text;await storeTokenUsage(id,null,config.model,response.usage);}catch(error){return reply.code(503).send({error:'Ошибка Codex: '+String(error instanceof Error?error.message:error).slice(0,350)});}
  let taskId:string|null=null,documentId:string|null=null,answer=raw;
  if(createDocument){
   const parsed=z.object({
    title:z.string().trim().min(2).max(200),
    body:z.string().trim().min(10).max(14000),
    parent_id:z.string().uuid().nullable().default(null)
   }).parse(jsonObject(raw));
   const parent=parsed.parent_id
    ?await pool.query('SELECT 1 FROM documents WHERE project_id=$1 AND id=$2',[id,parsed.parent_id])
    :null;
   const parentId=parent?.rowCount?parsed.parent_id:null;
   documentId=randomUUID();
   await pool.query('INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,$3,$4,$5)',
    [documentId,id,parsed.title,parsed.body,parentId]);
   answer='Документ «'+parsed.title+'» создан в разделе «Документация». Его можно открыть и редактировать прямо там.';
  }else if(create){
   const data=z.object({
    title:z.string().trim().min(3).max(180),description:z.string().trim().min(3).max(10000),
    questions:z.array(z.string().min(3).max(600)).max(20).default([]),
    related_ids:z.array(z.string().uuid()).max(10).default([]),
    depends_on_task_id:z.string().uuid().nullable().default(null),
    relation_reason:z.string().max(1500).optional(),
    suggested_rules:z.array(z.string().trim().min(5).max(800)).max(5).default([])
   }).parse(jsonObject(raw));
   taskId=randomUUID();
   const related=data.related_ids.filter(x=>existingIds.includes(x));
   const dependency=data.depends_on_task_id&&existingIds.includes(data.depends_on_task_id)?data.depends_on_task_id:null;
   const state=data.questions.length?'needs_clarification':'ready_for_development';
   await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage,analysis_state,clarification_questions,related_task_ids,depends_on_task_id,dependency_source) VALUES($1,$2,$3,$4,'task','analysis',$5,$6,$7,$8,'ai')",
     [taskId,id,data.title,data.description,state,JSON.stringify(data.questions),JSON.stringify(related),dependency]);
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
     [randomUUID(),taskId,uid(req),'created','Создано через AI-чат и проанализировано']);
   const analysisNote=(data.questions.length?'Нужно уточнить:\n'+data.questions.map((q,i)=>(i+1)+'. '+q).join('\n'):'Вопросов, блокирующих разработку, нет. Можно отправлять задачу в разработку.')+
    (related.length?'\n\nПотенциально связанные задачи: '+related.join(', ')+'\n'+(data.relation_reason||''):'')+
    (dependency?'\n\nКодовая зависимость: задача '+dependency+'. Новая ветка будет создана от ветки этой задачи, если она ещё не слита.':'');
   for(const rule of data.suggested_rules){
    const exists=await pool.query("SELECT 1 FROM project_rules WHERE project_id=$1 AND lower(body)=lower($2) UNION ALL SELECT 1 FROM project_rule_suggestions WHERE project_id=$1 AND lower(body)=lower($2) AND status='pending' LIMIT 1",[id,rule]);
    if(!exists.rowCount)await pool.query('INSERT INTO project_rule_suggestions(id,project_id,task_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),id,taskId,rule]);
   }
   await store(id,taskId,null,'assistant',analysisNote);
   answer='Создана задача в колонке «Анализ»: '+data.title+'\n\n'+(data.questions.length?'Вопросы находятся в чате задачи.':'ТЗ готово к подтверждению.')+
      (related.length?'\nОбнаружены связанные задачи: '+related.length:'');
  }
  await store(id,null,uid(req),'user',message);
  await store(id,null,null,'assistant',answer,taskId,documentId);
  await countCall(id,uid(req));
  return {message:answer,created_task_id:taskId,created_document_id:documentId};
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
  const result=await pool.query('SELECT title,description,stage,analysis_state,clarification_questions,depends_on_task_id,dependency_source,git_branch FROM tasks WHERE project_id=$1 AND id=$2',[id,taskId]);
  if(!result.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  const task=result.rows[0];
  if(mode==='analyze'&&task.stage!=='analysis')return reply.code(409).send({error:'Перемести задачу в колонку «Анализ»'});
  const config=await configuration(id);
  if(!config.enabled)return reply.code(409).send({error:'Включи ручной AI в настройках проекта'});
  const other=await pool.query('SELECT id,title,description,stage FROM tasks WHERE project_id=$1 AND id<>$2 ORDER BY updated_at DESC LIMIT 30',[id,taskId]);
  const link=(await pool.query('SELECT repository,default_branch,target_branch FROM project_git_repositories WHERE project_id=$1',[id])).rows[0];
  const repoContext=link?'Подключённый репозиторий: '+link.repository+'; целевая ветка: '+(link.target_branch||link.default_branch)+'. НЕ задавай вопросы о репозитории, выборе GitHub Pages и целевой ветке без прямого запроса пользователя.':'GitHub-репозиторий не подключён.';
  const rules=await rulesContext(id);
  const docs=await pool.query('SELECT title,body FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 8',[id]);
  const context=['Утверждённые правила проекта:\n'+rules,'Настройки GitHub проекта:\n'+repoContext,'Документы проекта:\n'+JSON.stringify(docs.rows).slice(0,6500),'Название: '+task.title,'Описание:\n'+task.description.slice(0,9000),
   'Открытые вопросы: '+JSON.stringify(task.clarification_questions),
   'Текущая кодовая зависимость: '+String(task.depends_on_task_id||'нет'),
   'Другие задачи проекта: '+JSON.stringify(other.rows).slice(0,9000),
   'История:\n'+await history(id,taskId),'Сообщение пользователя:\n'+message].join('\n\n');
  const refining=task.stage==='analysis';
  const prompt=refining?[
   'Ты системный аналитик. Ответ пользователя может уточнять открытые вопросы или содержать дополнительное требование. Обнови ТЗ, не теряя ранее согласованные требования.',
   'Верни только валидный JSON {"summary":"краткое актуальное ТЗ с критериями приёмки","details":"что уточнили, что осталось проверить, обнаруженные пересечения задач","questions":["только оставшиеся блокирующие вопросы"],"related_ids":["UUID связанных задач из списка"],"depends_on_task_id":"UUID прямой кодовой зависимости либо null","suggested_rules":["только универсальные полезные правила для будущих задач"]}.',
   'Не путай информационную связь с зависимостью по коду. Выбирай depends_on_task_id только при явной необходимости использовать незавершённые изменения другой задачи.',
   'Проанализируй сразу ВСЕ возможные блокирующие вопросы, возвращай их единым списком questions. Не дроби уточнения на серию последовательных вопросов. Не спрашивай известные настройки проекта.',
   'Если нет блокирующих вопросов, верни пустой массив questions. Не придумывай ответы. Не объединяй карточки без разрешения.',
   context
  ].join('\n\n'):[
   'Ты инженерный AI-помощник внутри задачи. Ответь на русском по существу. Не утверждай, что менял код.',context
  ].join('\n\n');
  let raw:string;
  try{const response=await completion(prompt,config);raw=response.text;await storeTokenUsage(id,taskId,config.model,response.usage);}catch(error){return reply.code(503).send({error:'Ошибка Codex: '+String(error instanceof Error?error.message:error).slice(0,350)});}
  let summary:string|null=null,answer=raw;
  let questions:string[]=[];
  if(refining){
   const analyzed=z.object({
    summary:z.string().trim().min(10).max(10000),details:z.string().trim().min(3).max(16000),
    questions:z.array(z.string().min(3).max(600)).max(20).default([]),
    related_ids:z.array(z.string().uuid()).max(10).default([]),
    depends_on_task_id:z.string().uuid().nullable().default(null),
    suggested_rules:z.array(z.string().trim().min(5).max(800)).max(5).default([])
   }).parse(jsonObject(raw));
   summary=analyzed.summary;questions=analyzed.questions;
   answer=analyzed.details+(questions.length?'\n\nОстались вопросы:\n'+questions.map((q,i)=>(i+1)+'. '+q).join('\n'):'\n\nБлокирующих вопросов нет. Можно отправлять задачу в разработку.');
   const related=analyzed.related_ids.filter(x=>other.rows.some(o=>o.id===x));
   await pool.query("UPDATE tasks SET description=$1,clarification_questions=$2,related_task_ids=$3,analysis_state=$4,updated_at=now() WHERE id=$5 AND project_id=$6",
    [summary,JSON.stringify(questions),JSON.stringify(related),questions.length?'needs_clarification':'ready_for_development',taskId,id]);
   if(!task.git_branch&&task.dependency_source==='ai'){
    const dep=analyzed.depends_on_task_id;
    if(!dep || other.rows.some(o=>o.id===dep)){
     // Avoid cycles by walking the proposed parent chain, including existing AI links.
     const cycle=dep?await pool.query('WITH RECURSIVE chain AS (SELECT id,depends_on_task_id,ARRAY[id] AS trail FROM tasks WHERE project_id=$1 AND id=$2 UNION ALL SELECT t.id,t.depends_on_task_id,c.trail||t.id FROM tasks t JOIN chain c ON t.id=c.depends_on_task_id WHERE t.project_id=$1 AND NOT t.id=ANY(c.trail)) SELECT 1 FROM chain WHERE id=$3 LIMIT 1',[id,dep,taskId]):{rowCount:0};
     if(!cycle.rowCount)await pool.query("UPDATE tasks SET depends_on_task_id=$3 WHERE id=$1 AND project_id=$2",[taskId,id,dep]);
    }
   }
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

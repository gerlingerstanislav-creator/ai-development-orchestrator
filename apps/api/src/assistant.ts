import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import {extractGitHubDocumentLocation,readGitHubMarkdownFiles,wantsDocumentSynthesis} from './github-document-import.js';
import {pendingAgentQuestions,taskNotesContext} from './task-agent-notes.js';
import {saveSpecRevision} from './requirements.js';

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
 async function stageAgentContext(id:string,stage:string){
  const record=await pool.query('SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage=$2',[id,stage]);
  const row=record.rows[0];
  if(!row)return '';
  return 'Роль исполнителя: '+String(row.agent_name||'')+'\nДополнительные инструкции этапа (не отменяют системные правила):\n'+String(row.agent_instructions||'').slice(0,7000);
 }
 async function rulesContext(id:string){
  const r=await pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 80',[id]);
  return r.rows.map(x=>'- '+x.body).join('\n').slice(0,12000);
 }
  async function completion(prompt:string,config:any,options?:{
   maxAttempts?:number;onRetry?:(attempt:number,maxAttempts:number,reason:string)=>Promise<void>
  }){
   const maxAttempts=options?.maxAttempts??1;
   for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
     const response=await fetch(codexUrl+'/assistant',{method:'POST',
      headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
      body:JSON.stringify({model:config.model,reasoning:config.reasoning,prompt}),
      signal:AbortSignal.timeout(maxAttempts>1?255000:115000)});
     const data=await response.json().catch(()=>({})) as any;
     if(!response.ok){
      const error=Object.assign(new Error(String(data.error||'Codex недоступен').slice(0,700)),{statusCode:response.status});
      throw error;
     }
     if(typeof data.message!=='string'||!data.message.trim())throw new Error('Codex вернул пустой ответ');
     if(data.message.length>120000)throw new Error('Ответ Codex превысил безопасный объём. Нужно уменьшить размер итоговых разделов документации.');
     return {text:data.message.trim(),usage:data.usage as {input_tokens:number;cached_input_tokens:number;output_tokens:number}|undefined};
    }catch(error){
     const reason=error instanceof Error?error.message:String(error);
     const code=(error as {statusCode?:number})?.statusCode;
     const retryable=code===429||code===503&&/timeout|времени|связи|перегруз|busy|несколько/i.test(reason)
      ||/timed?\s*out|timeout|aborted|AbortError|превысил ограничение времени|превышено время|несколько AI-диалогов|fetch failed|ECONNRESET|ETIMEDOUT/i.test(reason);
     if(!retryable||attempt>=maxAttempts)throw error;
     await options?.onRetry?.(attempt,maxAttempts,reason);
     await new Promise(resolve=>setTimeout(resolve,Math.min(10000,attempt*3000)));
    }
   }
   throw Error('Codex не завершил запрос');
  }

 async function processEvent(projectId:string,processId:string,stage:string,detail:string,level='info'){
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,level,stage,detail) VALUES($1,$2,$3,'document_import',$4,$5,$6)",
   [randomUUID(),projectId,processId,level,stage,detail.slice(0,2500)]);
 }
 async function saveImportedDraft(projectId:string,jobId:string,draft:any,sourceKey:string){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const root=await client.query(
    "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,document_kind,implementation_status) VALUES($1,$2,$3,$4,NULL,$5,'technical','unverified') ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,updated_at=now() RETURNING id",
    [randomUUID(),projectId,draft.collection_title,'# '+draft.collection_title+'\n\nИсточник: '+draft.sourceName+'\n\n'+draft.notes,sourceKey]);
   const rootId:string=root.rows[0].id;
   for(const [idx,doc] of draft.documents.entries()){
    const sources=doc.sources.filter((name:string)=>draft.sourcePaths.includes(name));
    const body=doc.body+(sources.length?'\n\n---\n**Исходные материалы:** '+sources.join(', '):'');
    await client.query(
     "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,document_kind,implementation_status) VALUES($1,$2,$3,$4,$5,$6,'technical','unverified') ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,parent_id=EXCLUDED.parent_id,updated_at=now()",
     [randomUUID(),projectId,doc.title,body,rootId,sourceKey+'/generated/'+idx]);
   }
   const result={message:'Импортированы '+draft.sourcePaths.length+' исходных файлов, сохранены '+draft.documents.length+' страниц.',created_task_id:null,created_document_id:rootId,generated_documents:draft.documents.length};
   // Transactional status means a failed chat save cannot mark an already committed import failed.
   await client.query("UPDATE document_import_jobs SET status='completed',message='Документация сохранена',result=$2,saved_documents=$3,updated_at=now() WHERE id=$1",
    [jobId,JSON.stringify(result),draft.documents.length]);
   await client.query('COMMIT');
   return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
 }
 async function history(id:string,taskId:string|null,channel:'project'|'documentation'='project'){
  const r=await pool.query('SELECT role,body FROM assistant_messages WHERE project_id=$1 AND task_id IS NOT DISTINCT FROM $2 AND channel=$3 ORDER BY created_at DESC LIMIT 10',[id,taskId,channel]);
  return r.rows.reverse().map(x=>x.role+': '+x.body.slice(0,1600)).join('\n\n');
 }
 async function store(id:string,taskId:string|null,actor:string|null,role:'user'|'assistant',body:string,createdTask:string|null=null,createdDocument:string|null=null,channel:'project'|'documentation'='project'){
  await pool.query('INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,created_task_id,created_document_id,channel) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
   [randomUUID(),id,taskId,actor,role,body,createdTask,createdDocument,channel]);
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
  const {mode}=z.object({mode:z.enum(['project','documentation']).default('project')}).parse(req.query);
  return (await pool.query('SELECT id,role,body,created_task_id,created_document_id,created_at FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL AND channel=$2 ORDER BY created_at ASC LIMIT 100',[id,mode])).rows;
 });
 app.get('/api/projects/:id/document-import/:jobId',async(req:any,reply)=>{
  const {id,jobId}=z.object({id:z.string().uuid(),jobId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id))return;
  const job=await pool.query('SELECT id,status,message,result FROM document_import_jobs WHERE id=$1 AND project_id=$2 AND actor_id=$3',[jobId,id,uid(req)]);
  if(!job.rowCount)return reply.code(404).send({error:'Импорт не найден'});
  return job.rows[0];
 });

 app.post('/api/projects/:id/document-import/:jobId/retry-save',async(req:any,reply)=>{
  const {id,jobId}=z.object({id:z.string().uuid(),jobId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const record=await pool.query('SELECT * FROM document_import_jobs WHERE id=$1 AND project_id=$2 AND actor_id=$3',[jobId,id,uid(req)]);
  if(!record.rowCount)return reply.code(404).send({error:'Импорт не найден'});
  const job=record.rows[0];
  if(job.status==='completed')return job.result;
  if(job.status!=='failed'||!job.draft_result||!job.source_key)return reply.code(409).send({error:'Нет готового черновика: требуется повторный анализ источника'});
  await processEvent(id,jobId,'retry_save','Повтор сохранения готовых документов');
  try{
   const result=await saveImportedDraft(id,jobId,job.draft_result,job.source_key);
   await processEvent(id,jobId,'completed','Повторное сохранение завершено');
   return result;
  }catch(error){
   const reason=error instanceof Error?error.message:String(error);
   await processEvent(id,jobId,'save_failed',reason,'error');
   return reply.code(409).send({error:'Ошибка сохранения: '+reason.slice(0,650)});
  }
 });
 app.post('/api/projects/:id/assistant',async(req:any,reply)=>{
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message,mode}=messageSchema.extend({mode:z.enum(['project','documentation']).default('project')}).parse(req.body);
  const documentationMode=mode==='documentation';
  const conversation=await history(id,null,mode);
  // Explicit project-document actions always outrank references to GitHub in older messages.
  // A clarification like "I mean documents in our project" continues the last document command.
  const documentAction=/(?:создай|создать|добавь|добавить|составь|напиши|подготовь|оформи|заведи|сделай|сформируй)\s+(?:(?:нов(?:ый|ую|ое)|отдельн(?:ый|ую|ое))\s+)?(?:документ(?:ацию)?|страниц[уы]|раздел(?:\s+документации)?|описание\s+проекта)(?![а-яёa-z])|(?:документ|страниц[ауеы]|документаци[юи]|раздел)\s+.{0,70}(?:создай|создать|добавь|подготовь|напиши)/i;
  const explicitDocumentCreation=documentAction.test(message);
  const lastUserRequest=conversation.split('\n\n').filter(x=>x.startsWith('user: ')).slice(-1)[0]?.slice(6)||'';
  const documentClarification=/(?:я\s+(?:говорю|имел)|имею\s+в\s+виду|именно|в\s+нашем\s+(?:сервисе|приложении|проекте)|внутри\s+(?:сервиса|проекта))/i.test(message)
   &&/(?:документ|документаци|страниц|раздел)/i.test(message)
   &&(documentAction.test(lastUserRequest)||(/(?:нет доступного инструмента|не могу создать|для этого нужна|создания документов)/i.test(conversation)&&/(?:документ|раздел|страниц)/i.test(conversation)));
  const localDocumentIntent=(explicitDocumentCreation||documentClarification)
   &&!/(?:из\s+(?:github|репозитория)|на\s+основе\s+(?:документов|файлов)|импортир|перенеси\s+из)/i.test(message);
  const location=extractGitHubDocumentLocation(message,conversation);
  // A missing source or unclear action is a conversation, not a reason to
  // hallucinate unavailable integrations or silently create the wrong object.
  const docImportIntent=/(?:документ|док[уи]|файл|markdown|страниц|документаци)/i.test(message+' '+conversation)
   &&/(?:github|репозитор|из ideas|из идеи|на основе|на базе)/i.test(message+' '+conversation)
   &&/(?:перенес|перенести|импортир|загруз|скопир|взял|возьми|забер|собер|созда|сформир|сдела|генерир|переработ|подготов|перетащ)/i.test(message)
   &&!/(?:создай|создать|добавь|добавить)\s+.{0,60}(?:задач|таск)/i.test(message);
  const sourceSpecified=!!location;
  if((docImportIntent||documentationMode&&/(?:импорт|загруз|перенес|из\\s+другого|источник)/i.test(message))&&!sourceSpecified&&!localDocumentIntent){
   const answer='Могу сделать это в разделе «Документация» текущего проекта. Уточни источник: пришли ссылку на папку GitHub с исходными Markdown-файлами (например, https://github.com/owner/repo/tree/main/docs) либо укажи путь к каталогу Markdown в подключённом репозитории. Также могу (1) переработать материалы в новый структурированный набор — рекомендую этот вариант, или (2) скопировать исходные файлы без изменений. Как поступим?';
   await store(id,null,uid(req),'user',message,null,null,mode);
   await store(id,null,null,'assistant',answer,null,null,mode);
   return {message:answer,created_task_id:null,created_document_id:null};
  }
  const synthesize=wantsDocumentSynthesis(message,conversation)||
   !!location&&/(?:перенес|импортир|загруз|созда|сформир|сдела|подготов)/i.test(message)&&
   /(?:документ|страниц|на основе|на базе|из репозитория)/i.test(message);
  const explicitImport=/(?:импортир|перенес|загруз|скопир|забер|взять|возьми|на\s+основе|из\s+репозитория|github\.com\/)/i.test(message);
  if((synthesize||documentationMode&&!!location&&explicitImport)&&!localDocumentIntent){
   if(!location)return reply.code(409).send({error:'Для создания документов на основе GitHub пришли ссылку на исходный каталог, например https://github.com/owner/repo/tree/main/docs'});
   const config=await configuration(id);
   if(!config.enabled)return reply.code(409).send({error:'Включи AI в настройках проекта: для переработки документации требуется Codex.'});
   const jobId=randomUUID();
   const sourceUrl='https://github.com/'+location.owner+'/'+location.repository+'/tree/'+location.branch+'/'+location.path;
   const sourceKey='github-ai:'+location.owner+'/'+location.repository+'@'+location.branch+':'+location.path;
   await pool.query("INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,source_url,source_key,request_text) VALUES($1,$2,$3,'running','Чтение исходных Markdown-файлов',$4,$5,$6)",[jobId,id,uid(req),sourceUrl,sourceKey,message]);
   await processEvent(id,jobId,'started','Чтение источника: '+sourceUrl);
   const actorId=uid(req);
   const updateProgress=async(stage:string,message:string)=>{
    await pool.query("UPDATE document_import_jobs SET message=$2,updated_at=now() WHERE id=$1",[jobId,message]);
    await processEvent(id,jobId,stage,message);
   };
   void (async()=>{
   try{
    const connected=await pool.query("SELECT secret_encrypted FROM connections WHERE owner_id=$1 AND provider='github_token' ORDER BY created_at DESC LIMIT 8",[uid(req)]);
    const tokens:string[]=[];
    for(const c of connected.rows){try{tokens.push(decryptToken(c.secret_encrypted));}catch{continue;}}
    const files=await readGitHubMarkdownFiles(location,tokens);
    await pool.query('UPDATE document_import_jobs SET source_file_count=$2 WHERE id=$1',[jobId,files.length]);
    await updateProgress('reading','Прочитано Markdown-файлов: '+files.length+'. Подготовка анализа.');
    if(!files.length)throw Error('В указанном каталоге нет Markdown-файлов.');
    const project=await pool.query('SELECT name,description FROM projects WHERE id=$1',[id]);
    const existingDocs=await pool.query('SELECT title,body FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 20',[id]);
    const getInstructions=async()=>{
     const instructions=await pool.query('SELECT body FROM process_instructions WHERE project_id=$1 AND process_id=$2 ORDER BY created_at DESC LIMIT 8',[id,jobId]);
     return instructions.rows.reverse().map((row:any)=>'- '+String(row.body).slice(0,900)).join('\n').slice(-1800);
    };
    const rules=await rulesContext(id);
    const documentationAgent=await stageAgentContext(id,'documentation');
    // Summarise every source chunk separately: the Codex assistant endpoint has
    // a strict 24k-character prompt limit. Never silently drop source tails.
    // Keep prompts well below the limit even after JSON serialization.
    type SourceDigest={path:string;notes:string};
    const chunks:Array<{path:string;part:number;total:number;content:string}>=[];
    const CHUNK_SIZE=8500;
    for(const file of files){
     const count=Math.ceil(file.body.length/CHUNK_SIZE)||1;
     for(let i=0;i<count;i++)chunks.push({
      path:file.path,part:i+1,total:count,
      content:file.body.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE)
     });
    }
    const digests:SourceDigest[]=[];
    await pool.query('UPDATE document_import_jobs SET total_chunks=$2 WHERE id=$1',[jobId,chunks.length]);
    let partNumber=0;
    for(const chunk of chunks){
     partNumber++;
     const currentInstructions=await getInstructions();
     const contentSha=createHash('sha256').update(chunk.content).update('\n'+message).update('\n'+currentInstructions).digest('hex');
     const previous=await pool.query(
      `SELECT c.notes FROM document_import_checkpoints c JOIN document_import_jobs j ON j.id=c.job_id
       WHERE j.project_id=$1 AND j.actor_id=$2 AND j.source_key=$3 AND c.chunk_index=$4
        AND c.file_path=$5 AND c.content_sha=$6
       ORDER BY c.created_at DESC LIMIT 1`,
      [id,actorId,sourceKey,partNumber,chunk.path,contentSha]);
     if(previous.rowCount){
      digests.push({path:chunk.path,notes:String(previous.rows[0].notes)});
      await pool.query('UPDATE document_import_jobs SET analyzed_chunks=$2 WHERE id=$1',[jobId,partNumber]);
      await updateProgress('checkpoint_reused','Восстановлен ранее обработанный фрагмент '+partNumber+' из '+chunks.length);
      continue;
     }
     const instruction=[
      'Ты аналитик импортируемых Markdown-документов. Внимательно извлеки факты и требования из ЭТОГО фрагмента, а не пытайся сразу создать итоговую документацию.',
      'Верни ТОЛЬКО JSON: {"notes":"подробные, но компактные Markdown-заметки с фактами, требованиями, ограничениями, решениями, гипотезами, противоречиями и именами сущностей"}',
      'Учитывай точные значения, имена, параметры, статусы и ограничения. Ничего не выдумывай. Отмечай, если мысль обрывается на границе фрагмента.',
      'Источник: '+chunk.path+'; фрагмент '+chunk.part+' из '+chunk.total+'.',
      'Дополнительные уточнения пользователя (если есть): '+currentInstructions,
      'Файл ('+partNumber+'/'+chunks.length+'):',
      chunk.content
     ].join('\n\n');
     await pool.query('UPDATE document_import_jobs SET analyzed_chunks=$2,total_chunks=$3 WHERE id=$1',[jobId,partNumber-1,chunks.length]);
     await updateProgress('analyzing','Анализ файлов: фрагмент '+partNumber+' из '+chunks.length);
     const result=await completion(instruction,config,{maxAttempts:3,
      onRetry:async(attempt,maxAttempts,reason)=>updateProgress('retrying',
       'Фрагмент '+partNumber+'/'+chunks.length+': повтор '+(attempt+1)+'/'+maxAttempts+' после ошибки Codex: '+reason.slice(0,220))
     });
     await storeTokenUsage(id,null,config.model,result.usage);
     const parsed=z.object({notes:z.string().trim().min(20).max(12000)}).parse(jsonObject(result.text));
     await pool.query(
      'INSERT INTO document_import_checkpoints(job_id,chunk_index,file_path,content_sha,notes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id,chunk_index) DO UPDATE SET notes=EXCLUDED.notes,content_sha=EXCLUDED.content_sha',
      [jobId,partNumber,chunk.path,contentSha,parsed.notes]);
     digests.push({path:chunk.path,notes:parsed.notes});
     await pool.query('UPDATE document_import_jobs SET analyzed_chunks=$2,total_chunks=$3 WHERE id=$1',[jobId,partNumber,chunks.length]);
     await updateProgress('checkpoint_saved','Завершён анализ и сохранён фрагмент '+partNumber+' из '+chunks.length);
    }
    // For larger repositories, recursively condense notes by bounded groups.
    // This protects the final synthesis prompt from exceeding the runner limit.
    let summaries=digests.map((x,i)=>'### '+x.path+' · '+(i+1)+'\n'+x.notes);
    let rounds=0;
    while(summaries.join('\n\n').length>12500){
     rounds++;
     if(rounds>12)throw Error('Слишком большой объём документации для автоматического объединения за один запрос');
     await updateProgress('summarizing','Объединение конспектов: этап '+rounds);
     const next:string[]=[];
     let batch:string[]=[];
     let size=0;
     const flush=async()=>{
      if(!batch.length)return;
      const prompt=[
       'Объедини конспекты исходных Markdown-документов без потери уникальных требований, ограничений, имён и решений.',
       'Не добавляй новых фактов. Укажи пути исходных файлов у сохранённых фактов.',
       'Верни ТОЛЬКО JSON: {"notes":"структурированный конспект Markdown"}',
       batch.join('\n\n')
      ].join('\n\n');
      const result=await completion(prompt,config,{maxAttempts:3,
       onRetry:async(attempt,maxAttempts,reason)=>updateProgress('retrying','Объединение конспектов: повтор '+(attempt+1)+'/'+maxAttempts+' · '+reason.slice(0,220))
      });
      await storeTokenUsage(id,null,config.model,result.usage);
      const parsed=z.object({notes:z.string().trim().min(20).max(10000)}).parse(jsonObject(result.text));
      next.push(parsed.notes);
      batch=[];size=0;
     };
     for(const item of summaries){
      if(batch.length && size+item.length>12500)await flush();
      // A single unusually large digest is further broken up, not dropped.
      if(item.length>12500){
       for(let i=0;i<item.length;i+=10000){
        if(batch.length)await flush();
        batch.push(item.slice(i,i+10000));await flush();
       }
      }else{batch.push(item);size+=item.length;}
     }
     await flush();
     if(next.join('\n\n').length>=summaries.join('\n\n').length)
      throw Error('Codex не смог достаточно сократить конспекты для создания итоговой документации');
     summaries=next;
    }
    const prompt=[
     'Ты системный аналитик и технический писатель. На основе ПОЛНЫХ конспектов прочитанных Markdown-файлов создай НОВЫЙ набор документации для проекта.',
     'Переработай и структурируй сведения, устрани повторы. Сохрани ограничения, статусы, пользовательские сценарии и принятые решения.',
     'Верни ТОЛЬКО корректный JSON: {"collection_title":"Название раздела","documents":[{"title":"Название","body":"Полный Markdown","sources":["пути исходных файлов"]}],"notes":"ограничения и вопросы"}.',
     'Создай 3–6 самостоятельных тематических Markdown-страниц; не выдумывай факты и не выдавай гипотезы за реализацию.',
     'Не записывай изменения в GitHub. Итоговые документы будут сохранены во внутреннем разделе «Документация».',
     'Проект: '+String(project.rows[0]?.name||''),
     'Описание: '+String(project.rows[0]?.description||'').slice(0,900),
     'Правила: '+rules.slice(0,1500),
     'Инструкции исполнителя документации: '+documentationAgent.slice(0,1100),
     'Существующие документы: '+JSON.stringify(existingDocs.rows.map((d:any)=>({title:d.title}))).slice(0,2200),
     'Запрос: '+message.slice(0,2000),
     'Уточнения пользователя, поступившие во время импорта: '+(await getInstructions()),
     'Источник: '+location.owner+'/'+location.repository+'@'+location.branch+'/'+location.path,
     'Исходные пути файлов: '+files.map(f=>f.path).join(', ').slice(0,1800),
     'Конспекты всех фрагментов:\n'+summaries.join('\n\n')
    ].join('\n\n');
    if(prompt.length>22000)throw Error('Конспекты не поместились в допустимый запрос Codex');
    await updateProgress('generating','Формирование итоговой структуры документации');
    const result=await completion(prompt,config,{maxAttempts:3,
     onRetry:async(attempt,maxAttempts,reason)=>updateProgress('retrying','Формирование документации: повтор '+(attempt+1)+'/'+maxAttempts+' · '+reason.slice(0,220))
    });
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
    const draft={...structure,sourcePaths:files.map(file=>file.path),sourceName:location.owner+'/'+location.repository};
    // Persist generated content BEFORE attempting SQL writes, so a failed save
    // can be repeated without paying to analyze the original files again.
    await pool.query('UPDATE document_import_jobs SET draft_result=$2 WHERE id=$1',[jobId,JSON.stringify(draft)]);
    await updateProgress('saving','Сохранение документов в проект');
    const resultSaved=await saveImportedDraft(id,jobId,draft,sourceKey);
    await processEvent(id,jobId,'completed','Документы сохранены: '+resultSaved.generated_documents+' страниц');
    try{
     await store(id,null,actorId,'user',message,null,null,mode);
     await store(id,null,null,'assistant',resultSaved.message,null,resultSaved.created_document_id,mode);
     await countCall(id,actorId);
    }catch(error){
     await processEvent(id,jobId,'chat_warning',String(error instanceof Error?error.message:error),'warning').catch(()=>{});
    }
   }catch(error){
    const reason=error instanceof Error?error.message:'Неизвестная ошибка';
    await processEvent(id,jobId,'failed',reason,'error').catch(()=>{});
    await pool.query("UPDATE document_import_jobs SET status='failed',message=$2,updated_at=now() WHERE id=$1 AND status<>'completed'",
     [jobId,'Ошибка импорта: '+reason.slice(0,600)]).catch(()=>{});
   }
   })();
   return reply.code(202).send({import_job_id:jobId,message:'Импорт начат'});
  }
  // Documentation workspace: discuss requirements and atomically apply structured edits.
  // The model is a planner, not a database writer; only validated operations are executed.
  if(documentationMode){
   const config=await configuration(id);
   if(!config.enabled)return reply.code(409).send({error:'Включи AI в настройках проекта'});
   const project=(await pool.query('SELECT name,description FROM projects WHERE id=$1',[id])).rows[0];
   const docs=(await pool.query('SELECT id,title,body,parent_id FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 80',[id])).rows;
   const rules=await rulesContext(id);
   const agentInstructions=await stageAgentContext(id,'documentation');
   const prompt=[
    'Ты AI-редактор документации проекта. Ведёшь диалог, выясняешь требования и после каждого содержательного ответа СОЗДАЁШЬ или ОБНОВЛЯЕШЬ тематические страницы документации внутри приложения.',
    'Верни только JSON: {"reply":"ответ пользователю и при необходимости уточняющий вопрос","operations":[{"op":"create","key":"new-overview","title":"Название","body":"Markdown","parent_id":null,"parent_key":null},{"op":"update","id":"UUID существующего документа","title":"Название","body":"ПОЛНОЕ новое содержимое Markdown","parent_id":null}]}',
    'Не удаляй страницы. Существующие документы обновляй бережно: сохраняй подтверждённые сведения, не перезаписывай их гипотезами.',
    'Создавай новые страницы только при достаточном содержании. Если информации мало, задай один конкретный вопрос и верни operations: [].',
    'Каждую новую страницу можно вложить в уже существующий документ через parent_id (UUID), или в созданную В ЭТОМ ЖЕ ОТВЕТЕ страницу через parent_key (её key). Все созданные key должны быть уникальными. Сначала родители, потом потомки.',
    'Поле id для update выбирай только из существующих UUID. Для create id не нужно. Не используй ключи, которых не существует.',
    'Не утверждай, что сохранил изменения, если operations пуст. Не пиши в GitHub. Размещай содержимое только в документации проекта.',
    'Не выдумывай факты. Непроверенное обозначай как гипотезу или вопрос, не смешивая с утверждёнными решениями.',
    'Если пользователь присылает ссылку на внешний источник, не придумывай его содержимое и попроси поддерживаемую GitHub-ссылку на каталог Markdown, если она не передана.',
    'Проект: '+String(project?.name||''),
    'Описание: '+String(project?.description||'').slice(0,3500),
    'Правила: '+rules.slice(0,6000),
    'Инструкции AI-технического писателя: '+agentInstructions,
    'Существующие страницы: '+JSON.stringify(docs.map((d:any)=>({...d,body:String(d.body).slice(0,5000)}))).slice(0,54000),
    'Диалог:\n'+conversation.slice(-12000),
    'Последнее сообщение:\n'+message
   ].join('\n\n');
   try{
    const result=await completion(prompt,config);
    const output=z.object({
     reply:z.string().trim().min(1).max(4000),
     operations:z.array(z.discriminatedUnion('op',[
      z.object({op:z.literal('create'),key:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),title:z.string().trim().min(2).max(180),body:z.string().trim().min(10).max(15000),parent_id:z.string().uuid().nullable().optional(),parent_key:z.string().nullable().optional()}),
      z.object({op:z.literal('update'),id:z.string().uuid(),title:z.string().trim().min(2).max(180),body:z.string().trim().min(10).max(15000),parent_id:z.string().uuid().nullable().optional()})
     ])).max(12)
    }).parse(jsonObject(result.text));
    const known=new Set<string>(docs.map((d:any)=>d.id));
    const ids=new Map<string,string>();
    const prepared:Array<{id:string;op:'create'|'update';title:string;body:string;parentId:string|null;key?:string}>=[];
    const seenKeys=new Set<string>();
    for(const op of output.operations){
     if(op.op==='update'){
      if(!known.has(op.id))throw Error('AI сослался на несуществующую страницу документации');
      const original=docs.find((d:any)=>d.id===op.id);
      const parent=op.parent_id===undefined?(original?.parent_id||null):op.parent_id;
      if(parent!==null&&!known.has(parent))throw Error('Неизвестный родитель документа');
      if(parent===op.id)throw Error('Документ не может быть вложен в самого себя');
      prepared.push({id:op.id,op:'update',title:op.title,body:op.body,parentId:parent});
     }else{
      if(seenKeys.has(op.key))throw Error('Дублирующийся ключ новой страницы');
      const parent:string|null=op.parent_key?(ids.get(op.parent_key)||null):(op.parent_id||null);
      if(op.parent_key&&!parent)throw Error('Родительская страница должна быть создана раньше дочерней');
      if(parent!==null&&!known.has(parent)&&![...ids.values()].includes(parent))throw Error('Неизвестный родитель новой страницы');
      const newId=randomUUID();ids.set(op.key,newId);seenKeys.add(op.key);
      prepared.push({id:newId,op:'create',title:op.title,body:op.body,parentId:parent,key:op.key});
     }
    }
    // Validate the resulting whole document tree before any writes.
    const parentLinks=new Map<string,string|null>(docs.map((d:any)=>[d.id,d.parent_id||null]));
    for(const op of prepared)parentLinks.set(op.id,op.parentId);
    for(const start of parentLinks.keys()){
     const visited=new Set<string>();
     let cursor:string|null=start;
     while(cursor){
      if(visited.has(cursor))throw Error('Предлагаемая структура документации содержит циклическое вложение');
      visited.add(cursor);
      cursor=parentLinks.get(cursor)||null;
     }
    }
    const client=await pool.connect();
    try{
     await client.query('BEGIN');
     for(const op of prepared){
      if(op.op==='create')await client.query('INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,$3,$4,$5)',[op.id,id,op.title,op.body,op.parentId]);
      else await client.query('UPDATE documents SET title=$3,body=$4,parent_id=$5,updated_at=now() WHERE id=$1 AND project_id=$2',[op.id,id,op.title,op.body,op.parentId]);
     }
     await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    const made=prepared.filter(x=>x.op==='create').length,changed=prepared.filter(x=>x.op==='update').length;
    const answer=output.reply+(prepared.length?'\n\nДокументация обновлена: создано '+made+', изменено '+changed+' страниц.':'');
    const documentId=prepared[0]?.id||null;
    await store(id,null,uid(req),'user',message,null,null,mode);
    await store(id,null,null,'assistant',answer,null,documentId,mode);
    await storeTokenUsage(id,null,config.model,result.usage);
    await countCall(id,uid(req));
    return {message:answer,created_task_id:null,created_document_id:documentId,changed_documents:prepared.length};
   }catch(error){
    return reply.code(409).send({error:'Не удалось обработать документацию: '+String(error instanceof Error?error.message:error).slice(0,500)});
   }
  }
  const config=await configuration(id);
  if(!config.enabled)return reply.code(409).send({error:'Включи ручной AI в настройках проекта'});
  const create=/(создай|создать|добавь|заведи|оформи)\s+.{0,100}(задач[уаи]|таск)|(задач[уаи]|таск)\s+.{0,100}(создай|создать|добавь|заведи|оформи)/i.test(message);
  // Document commands take priority over task detection. Mentioning documentation
  // in a task request alone must NOT create a document.
  const createDocument=localDocumentIntent;

  const project=await pool.query('SELECT name,description FROM projects WHERE id=$1',[id]);
  const rules=await rulesContext(id);
  const analystInstructions=await stageAgentContext(id,'analysis');
  const docInstructions=await stageAgentContext(id,'documentation');
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
    'Если просят создать новый раздел документации, создай корневую страницу (parent_id: null) с осмысленным заголовком и содержимым. Если пользователь уточняет ранее заданную команду, выполни исходную команду с учётом уточнения.',
    'Название проекта: '+project.rows[0].name,
    'Описание проекта: '+project.rows[0].description.slice(0,3000),
    'Правила проекта:\n'+rules,
    'Инструкции агента: '+docInstructions,
    'Настройки GitHub:\n'+repoContext,
    'Существующая документация: '+JSON.stringify(existingDocs.rows.map((doc:any)=>({...doc,body:String(doc.body).slice(0,2500)}))).slice(0,11000),
    'История чата:\n'+conversation,
    'Исходная команда, которую уточняет пользователь: '+(documentClarification?lastUserRequest:'нет'),
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
    'Инструкции аналитика: '+analystInstructions,
    'Контекст GitHub проекта: '+repoContext,
    'Проект: '+project.rows[0].name,
    'Другие задачи (UUID, название и описание): '+JSON.stringify(existing.rows).slice(0,9000),
    'Документы проекта: '+JSON.stringify(docs.rows).slice(0,9000),
    'История:\n'+conversation,'Запрос:\n'+message].join('\n\n');
  }else{
   prompt=['Ты Менеджер проекта AI Development Orchestrator — единственный собеседник заказчика. Отвечай кратко, по делу и на русском. Не выдавай внутренние вопросы или просьбы других специалистов за самостоятельные вопросы заказчику: сначала проверь контекст и имеющиеся инструменты. Не обещай действий, которые не были запущены.',
    'Если намерение пользователя, объект действия или источник данных неясны — задай один конкретный уточняющий вопрос или предложи 2–3 практических варианта с рекомендацией. Не делай вид, что понял, и не заменяй действие пустым советом.',
    'Учитывай историю диалога: уточнение пользователя относится к предыдущему запросу. Не проси повторить уже известные детали.',
    'В приложении поддерживается создание задач, создание Markdown-документов, а также чтение GitHub Markdown и составление НОВОГО комплекта документов в разделе «Документация» проекта на основе этих материалов.',
    'Исходные документы можно прочитать по URL GitHub на папку или файл. Для закрытого репозитория нужен доступ подключённого GitHub токена. Это не означает запись обратно в репозиторий.',
    'Не утверждай, что необходима отдельная «сессия документов» или «поддерживаемое хранилище документов» — раздел уже существует в PostgreSQL. Не придумывай несуществующих ограничений и возможностей.',
    'Если доступ к GitHub не подтверждён, объясни, что проверка произойдёт при импорте; не утверждай, что доступа нет без проверки.',
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
  const analystInstructions=await stageAgentContext(id,'analysis');
  const docs=await pool.query('SELECT title,body FROM documents WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 8',[id]);
  const context=['Инструкции аналитика: '+analystInstructions,'Утверждённые правила проекта:\n'+rules,'Настройки GitHub проекта:\n'+repoContext,'Документы проекта:\n'+JSON.stringify(docs.rows).slice(0,6500),'Название: '+task.title,'Описание:\n'+task.description.slice(0,9000),
   'Открытые вопросы: '+JSON.stringify(task.clarification_questions),
   'Текущая кодовая зависимость: '+String(task.depends_on_task_id||'нет'),
   'Другие задачи проекта: '+JSON.stringify(other.rows).slice(0,9000),
   'История:\n'+await history(id,taskId),
   'Рабочие комментарии участников задачи (это не утверждённые требования): '+await taskNotesContext(pool,id,taskId,task.stage==='analysis'?'analysis':task.stage),
   'Сообщение пользователя:\n'+message].join('\n\n');
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
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const current=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
    if(!current.rowCount||current.rows[0].stage!=='analysis')throw Error('Этап задачи изменился во время анализа');
    await saveSpecRevision(client,current.rows[0],{title:current.rows[0].title,description:summary!,origin:'analyst',actorId:uid(req),reason:'Уточнение ТЗ системным аналитиком',reviewStatus:'current'});
    await client.query("UPDATE tasks SET clarification_questions=$1,related_task_ids=$2,analysis_state=$3,spec_review_status='current',spec_reviewed_version=spec_version,updated_at=now() WHERE id=$4 AND project_id=$5",
     [JSON.stringify(questions),JSON.stringify(related),questions.length?'needs_clarification':'ready_for_development',taskId,id]);
    await client.query('COMMIT');
   }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
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
  const task=await pool.query('SELECT stage,analysis_state,clarification_questions,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
  if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  if(task.rows[0].stage!=='analysis'||task.rows[0].analysis_state!=='ready_for_development'||task.rows[0].spec_review_status!=='current'||(task.rows[0].clarification_questions||[]).length||await pendingAgentQuestions(pool,id,taskId))
   return reply.code(409).send({error:'Сначала ответь на блокирующие вопросы AI-аналитика'});
  await pool.query("UPDATE tasks SET stage='development',analysis_state='approved',updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,id]);
  await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'stage_changed','Анализ → Разработка')",[randomUUID(),taskId,uid(req)]);
  return {ok:true};
 });

}

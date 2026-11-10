import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {recordAgentActivity} from './task-agent-activity.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {pendingAgentQuestions} from './task-agent-notes.js';

type Deps={pool:Pool;uid:(req:any)=>string;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>;codexUrl:string;runnerKey:string};
const uuid=z.string().uuid();
export function registerKnowledgeRoutes(app:FastifyInstance,d:Deps){
 const {pool,uid,access,requireAdmin,codexUrl,runnerKey}=d;
 async function ask(id:string,prompt:string){
  const cfg=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
  if(!cfg.rows[0]?.enabled)throw new Error('Включи AI в настройках проекта');
  const writer=await pool.query("SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage='documentation'",[id]);
  const role=writer.rows[0];
  if(role)prompt+='\n\nИнструкции этапа документации ('+String(role.agent_name||'AI-технический писатель')+'): '+String(role.agent_instructions||'').slice(0,7000);
  const r=await fetch(codexUrl+'/assistant',{method:'POST',headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},body:JSON.stringify({prompt,model:cfg.rows[0].model,reasoning:cfg.rows[0].reasoning}),signal:AbortSignal.timeout(115000)});
  const data=await r.json().catch(()=>({})) as any;
  if(!r.ok)throw new Error(String(data.error||'Ошибка Codex').slice(0,300));
  if(typeof data.message!=='string')throw new Error('Пустой ответ AI');
  const first=data.message.indexOf('{'),last=data.message.lastIndexOf('}');
  if(first<0||last<=first)throw new Error('AI вернул ответ без JSON');
  return JSON.parse(data.message.slice(first,last+1));
 }
 app.get('/api/projects/:id/rules',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  return (await pool.query('SELECT id,body,origin,source_task_id,created_at FROM project_rules WHERE project_id=$1 ORDER BY created_at',[id])).rows;
 });
 app.post('/api/projects/:id/rules',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {body}=z.object({body:z.string().trim().min(5).max(2500)}).parse(req.body);
  const existing=await pool.query('SELECT 1 FROM project_rules WHERE project_id=$1 AND lower(body)=lower($2)',[id,body]);
  if(existing.rowCount)return reply.code(409).send({error:'Такое правило уже существует'});
  const ruleId=randomUUID();await pool.query('INSERT INTO project_rules(id,project_id,body) VALUES($1,$2,$3)',[ruleId,id,body]);
  return reply.code(201).send({id:ruleId,body,origin:'manual'});
 });
 app.delete('/api/projects/:id/rules/:ruleId',async(req:any,reply)=>{
  const {id,ruleId}=z.object({id:uuid,ruleId:uuid}).parse(req.params);if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const r=await pool.query('DELETE FROM project_rules WHERE id=$1 AND project_id=$2 RETURNING id',[ruleId,id]);
  if(!r.rowCount)return reply.code(404).send({error:'Правило не найдено'});return {ok:true};
 });
 app.get('/api/projects/:id/rule-suggestions',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  return (await pool.query("SELECT id,body,task_id,created_at FROM project_rule_suggestions WHERE project_id=$1 AND status='pending' ORDER BY created_at",[id])).rows;
 });
 app.post('/api/projects/:id/rule-suggestions/:suggestionId/decision',async(req:any,reply)=>{
  const {id,suggestionId}=z.object({id:uuid,suggestionId:uuid}).parse(req.params);if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {decision}=z.object({decision:z.enum(['approve','reject'])}).parse(req.body);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const r=await client.query("SELECT * FROM project_rule_suggestions WHERE id=$1 AND project_id=$2 AND status='pending' FOR UPDATE",[suggestionId,id]);
   if(!r.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'Предложение уже обработано'});}
   const row=r.rows[0];
   if(decision==='approve'){
    const dup=await client.query('SELECT 1 FROM project_rules WHERE project_id=$1 AND lower(body)=lower($2)',[id,row.body]);
    if(!dup.rowCount)await client.query("INSERT INTO project_rules(id,project_id,body,origin,source_task_id) VALUES($1,$2,$3,'ai_approved',$4)",[randomUUID(),id,row.body,row.task_id]);
   }
   await client.query('UPDATE project_rule_suggestions SET status=$1 WHERE id=$2',[decision==='approve'?'approved':'rejected',suggestionId]);
   await client.query('COMMIT');return {ok:true};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
 app.get('/api/projects/:id/documentation/pending',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  return (await pool.query("SELECT id,title,description,pr_url FROM tasks WHERE project_id=$1 AND stage='documentation' ORDER BY updated_at",[id])).rows;
 });
 app.post('/api/projects/:id/documentation/update',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const request=z.object({task_id:z.string().uuid().optional()}).parse(req.body||{});
  const pending=request.task_id
   ?await pool.query("SELECT id,title,description,pr_url FROM tasks WHERE project_id=$1 AND id=$2 AND stage='documentation' ORDER BY updated_at LIMIT 1",[id,request.task_id])
   :await pool.query("SELECT id,title,description,pr_url FROM tasks WHERE project_id=$1 AND stage='documentation' ORDER BY updated_at LIMIT 15",[id]);
  if(!pending.rowCount)return reply.code(409).send({error:'Нет слитых задач, ожидающих документации'});
  for(const task of pending.rows)if(await pendingAgentQuestions(pool,id,task.id))return reply.code(409).send({error:'Документация ожидает ответы на вопросы агентов по задаче '+task.title});
  const doc=(await pool.query("SELECT id,title,body FROM documents WHERE project_id=$1 AND title='Реализованные возможности' LIMIT 1",[id])).rows[0];
  const rules=await pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 60',[id]);
  // Only explicitly linked thematic pages are candidates; no blind rewriting of unrelated human documents.
  const candidate=await pool.query("SELECT DISTINCT d.id,d.title,d.body,d.updated_at FROM documents d JOIN knowledge_task_links l ON l.document_id=d.id AND l.project_id=d.project_id WHERE d.project_id=$1 AND l.task_id=ANY($2::uuid[]) AND d.system_key IS NULL AND d.title<>'Реализованные возможности' AND d.knowledge_status IN ('approved','draft') ORDER BY d.updated_at DESC LIMIT 8",[id,pending.rows.map(x=>x.id)]);
  const prompt=['Ты технический писатель. Обнови документацию только по уже слитым Pull Request.',
   'Ответь ТОЛЬКО JSON {"body":"полное Markdown-содержимое документа Реализованные возможности","updates":[{"document_id":"UUID связанного документа","body":"полное предлагаемое Markdown-содержимое","reason":"какая задача и PR доказывают изменение"}]}.',
   'Для связанных документов СОЗДАВАЙ ТОЛЬКО ПРЕДЛОЖЕНИЯ на согласование, не объявляй поведение реализованным без достоверных подтверждений. Если PR diff недоступен, не делай предположений об изменении разделов; updates может быть пустым.',
   'Не удаляй прежние реализованные возможности. Не выдумывай факты, не включай секреты.',
   'Рабочие комментарии и история обсуждений не являются утверждённой функциональностью. Не переписывай их в документацию как факт.',
   'Предыдущий документ:\n'+String(doc?.body||'# Реализованные возможности\n').slice(0,40000),
   'Правила проекта (учитывай, не изменяй):\n'+rules.rows.map(x=>x.body).join('\n').slice(0,7000),
   'Связанные документы для возможного обновления:\n'+JSON.stringify(candidate.rows.map(d=>({id:d.id,title:d.title,body:String(d.body).slice(0,8500)}))).slice(0,30000),
   'Выполненные задачи:\n'+JSON.stringify(pending.rows).slice(0,22000)].join('\n\n');
  const ids=pending.rows.map(x=>x.id);
  const runId=randomUUID();
  await recordAgentActivity(pool,id,ids,runId,'documentation','running','Документатор обрабатывает слитые изменения');
  let body:string;
  let updates:Array<{document_id:string;body:string;reason:string}>=[];
  try{
   const parsed=z.object({body:z.string().min(20).max(90000),updates:z.array(z.object({document_id:z.string().uuid(),body:z.string().min(20).max(100000),reason:z.string().min(5).max(2000)})).max(8).default([])}).parse(await ask(id,prompt));
   body=parsed.body;
   updates=parsed.updates.filter(p=>candidate.rows.some(d=>d.id===p.document_id&&d.body!==p.body));
  }
  catch(e){
   await recordAgentActivity(pool,id,ids,runId,'documentation','failed','Не удалось подготовить изменения документации.');
   return reply.code(503).send({error:e instanceof Error?e.message:'Ошибка обновления документации'});
  }
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const locks=await client.query("SELECT id FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) AND stage='documentation' FOR UPDATE",[id,ids]);
   if(locks.rowCount!==ids.length)throw new Error('Задачи изменились во время обновления. Повтори.');
   let documentId=doc?.id as string|undefined;
   if(documentId)await client.query('UPDATE documents SET body=$1,updated_at=now() WHERE id=$2 AND project_id=$3',[body,documentId,id]);
   else{const parent=(await client.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='architecture'",[id])).rows[0];
     if(!parent)throw Error('Не найден системный раздел архитектуры');
     documentId=randomUUID();await client.query("INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,'Реализованные возможности',$3,$4)",[documentId,id,body,parent.id]);}
   await client.query('INSERT INTO document_versions(id,document_id,task_ids,body) VALUES($1,$2,$3,$4)',[randomUUID(),documentId,JSON.stringify(ids),body]);
   let proposed=0;
   for(const update of updates){
    const current=(await client.query('SELECT id,updated_at FROM documents WHERE id=$1 AND project_id=$2 AND system_key IS NULL FOR UPDATE',[update.document_id,id])).rows[0];
    const base=candidate.rows.find(d=>d.id===update.document_id);
    if(!current||!base||new Date(current.updated_at).getTime()!==new Date(base.updated_at).getTime())continue;
    const result=await client.query("INSERT INTO knowledge_document_updates(id,project_id,document_id,task_ids,base_version,proposed_body,reason) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
     [randomUUID(),id,update.document_id,ids,base.updated_at,update.body,update.reason]);
    proposed+=result.rowCount||0;
   }
   await client.query("UPDATE tasks SET stage='done',documentation_updated_at=now(),updated_at=now() WHERE project_id=$1 AND id=ANY($2::uuid[])",[id,ids]);
   for(const taskId of ids)await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'documentation_updated','Документация обновлена после слияния')",[randomUUID(),taskId,uid(req)]);
   await recordAgentActivity(client,id,ids,runId,'documentation','completed','Обновлён документ «Реализованные возможности».');
   await client.query('COMMIT');
   return {ok:true,updated_tasks:ids.length,document_id:documentId,proposals:proposed};
  }catch(e){
   await client.query('ROLLBACK');
   await recordAgentActivity(client,id,ids,runId,'documentation','failed','Не удалось сохранить изменения документации.');
   return reply.code(409).send({error:e instanceof Error?e.message:'Ошибка'});
  }finally{client.release();}
 });
 app.get('/api/projects/:id/documentation/versions',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  return (await pool.query('SELECT v.id,v.task_ids,v.created_at FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.project_id=$1 ORDER BY v.created_at DESC LIMIT 30',[id])).rows;
 });
}

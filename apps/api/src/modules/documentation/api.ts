import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fingerprint} from '../../topic-import.js';
import {validDocParent} from './infrastructure/document-hierarchy.js';

type Deps={
 pool:Pool;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/** Documentation HTTP boundary: CRUD and user approval of imported changes. */
export function registerDocumentationRoutes(app:FastifyInstance,{pool,access,requireAdmin}:Deps){
const docParent=z.string().uuid().nullable().optional();
app.get('/api/projects/:id/documentation/proposals',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 return (await pool.query("SELECT v.id,v.job_id,v.topic_key,v.document_id,v.title,v.proposed_body,v.status,v.created_at,d.title AS document_title FROM document_import_proposals v JOIN documents d ON d.id=v.document_id WHERE v.project_id=$1 AND v.status='open' ORDER BY v.created_at",[id])).rows;
});
app.post('/api/projects/:id/documentation/proposals/:proposalId/decision',async(req:any,reply)=>{
 const {id,proposalId}=parse(z.object({id:z.string().uuid(),proposalId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {decision}=parse(z.object({decision:z.enum(['approve','reject'])}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const v=(await client.query("SELECT * FROM document_import_proposals WHERE id=$1 AND project_id=$2 AND status='open' FOR UPDATE",[proposalId,id])).rows[0];
  if(!v){await client.query('ROLLBACK');return reply.code(409).send({error:'Предложение уже обработано'});}
  const d=(await client.query('SELECT id,title,body,system_key FROM documents WHERE id=$1 AND project_id=$2 FOR UPDATE',[v.document_id,id])).rows[0];
  if(!d||d.system_key){await client.query('ROLLBACK');return reply.code(409).send({error:'Страница недоступна для обновления'});}
  if(decision==='approve'){
   if(fingerprint(d.title,d.body)!==v.base_hash){await client.query('ROLLBACK');return reply.code(409).send({error:'Страница изменилась после формирования предложения. Нужна повторная сверка.'});}
   await client.query("UPDATE documents SET title=$2,body=$3,import_synced_hash=$4,updated_at=now() WHERE id=$1",[d.id,v.title,v.proposed_body,fingerprint(v.title,v.proposed_body)]);
  }
  await client.query("UPDATE document_import_proposals SET status=$2,decided_at=now() WHERE id=$1",[proposalId,decision==='approve'?'approved':'rejected']);
  await client.query('COMMIT');
  return {ok:true,decision};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.get('/api/projects/:id/docs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 return (await pool.query("SELECT * FROM documents WHERE project_id=$1 ORDER BY CASE system_key WHEN 'spec' THEN 0 WHEN 'architecture' THEN 1 WHEN 'operations' THEN 2 WHEN 'design' THEN 3 WHEN 'research' THEN 4 ELSE 5 END, title ASC, id ASC",[id])).rows;
});
app.post('/api/projects/:id/docs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const {title,body,parent_id,document_kind,implementation_status,implementation_evidence}=parse(z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000).default(''),parent_id:docParent,document_kind:z.enum(['technical','functional']).default('technical'),implementation_status:z.enum(['unverified','planned','partial','implemented']).default('unverified'),implementation_evidence:z.string().max(2000).default('')}),req.body);
 if(!parent_id)return reply.code(409).send({error:'Создавай страницы внутри одного из пяти системных разделов'});
  if(!await validDocParent(pool,id,null,parent_id))return reply.code(400).send({error:'Родительская страница не найдена в проекте'});
 const docId=randomUUID();
 await pool.query('INSERT INTO documents(id,project_id,title,body,parent_id,document_kind,implementation_status,implementation_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[docId,id,title,body,parent_id??null,document_kind,implementation_status,implementation_evidence]);
 return reply.code(201).send({id:docId});
});
app.patch('/api/projects/:id/docs/:docId',async(req:any,reply)=>{
 const {id,docId}=parse(z.object({id:z.string().uuid(),docId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000),parent_id:docParent,document_kind:z.enum(['technical','functional']).optional(),implementation_status:z.enum(['unverified','planned','partial','implemented']).optional(),implementation_evidence:z.string().max(2000).optional()}),req.body);
 const old=await pool.query('SELECT parent_id,system_key,title FROM documents WHERE id=$1 AND project_id=$2',[docId,id]);
 if(!old.rowCount)return reply.code(404).send({error:'Документ не найден'});
 const parentId=data.parent_id===undefined?old.rows[0].parent_id:data.parent_id;
 if(old.rows[0].system_key && (data.title!==old.rows[0].title || parentId!==null))return reply.code(409).send({error:'Название и расположение системного раздела нельзя менять'});
  if(!old.rows[0].system_key&&!parentId)return reply.code(409).send({error:'Страницу нельзя переместить за пределы системных разделов'});
  if(!await validDocParent(pool,id,docId,parentId))return reply.code(400).send({error:'Нельзя переместить страницу в себя, своего потомка или другой проект'});
 await pool.query("UPDATE documents SET title=$1,body=$2,parent_id=$3,document_kind=COALESCE($6,document_kind),implementation_status=COALESCE($7,implementation_status),implementation_evidence=COALESCE($8,implementation_evidence),updated_at=clock_timestamp() WHERE id=$4 AND project_id=$5",[data.title,data.body,parentId,docId,id,data.document_kind||null,data.implementation_status||null,data.implementation_evidence??null]);
 return {ok:true};
});
app.delete('/api/projects/:id/docs/:docId',async(req:any,reply)=>{
 const {id,docId}=parse(z.object({id:z.string().uuid(),docId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const document=await pool.query('SELECT id,system_key FROM documents WHERE id=$1 AND project_id=$2',[docId,id]);
 if(!document.rowCount)return reply.code(404).send({error:'Документ не найден'});
  if(document.rows[0].system_key)return reply.code(409).send({error:'Системный раздел документации нельзя удалить'});
 const children=await pool.query('SELECT count(*)::int AS total FROM documents WHERE project_id=$1 AND parent_id=$2',[id,docId]);
 if(children.rows[0].total>0)return reply.code(409).send({error:'У документа есть вложенные страницы. Сначала перемести или удали дочерние страницы.'});
 await pool.query('DELETE FROM documents WHERE project_id=$1 AND id=$2',[id,docId]);
 return {ok:true};
});
}

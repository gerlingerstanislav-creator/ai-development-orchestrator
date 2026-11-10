import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {moduleInput,buildKnowledgeContext} from './knowledge-workflow.js';

const uuid=z.string().uuid();
type Deps={pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>};
const taskLink=z.object({document_id:uuid,task_id:uuid,relation:z.enum(['implements','requires','tests','documents','affected_by'])});
const artifactLink=z.object({document_id:uuid,artifact_kind:z.enum(['qa_case','pr','component']),artifact_ref:z.string().trim().min(2).max(600),relation:z.string().trim().min(2).max(80)});
function apiError(text:string){return Object.assign(new Error(text),{statusCode:400});}

export function registerKnowledgeWorkflowRoutes(app:FastifyInstance,d:Deps){
 const {pool,access,requireAdmin}=d;
 const project=async(req:any,reply:any)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return null;
  return id;
 };
 app.get('/api/projects/:id/knowledge/instructions',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id)return;
  const r=await pool.query("SELECT id,title,body,stage,tags,mandatory,status,priority,revision,updated_at FROM knowledge_instruction_modules WHERE project_id=$1 ORDER BY mandatory DESC,priority DESC,title",[id]);
  return {modules:r.rows};
 });
 app.post('/api/projects/:id/knowledge/instructions',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id||!await requireAdmin(req,reply))return;
  const data=moduleInput.parse(req.body);
  const newId=randomUUID();
  await pool.query('INSERT INTO knowledge_instruction_modules(id,project_id,title,body,stage,tags,mandatory,status,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
   [newId,id,data.title,data.body,data.stage,data.tags,data.mandatory,data.status,data.priority]);
  return reply.code(201).send({id:newId});
 });
 app.patch('/api/projects/:id/knowledge/instructions/:instructionId',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id||!await requireAdmin(req,reply))return;
  const {instructionId}=z.object({instructionId:uuid}).parse(req.params);
  const data=moduleInput.partial().extend({expected_revision:z.number().int().positive()}).parse(req.body);
  if(!Object.keys(data).some(x=>x!=='expected_revision'))return reply.code(400).send({error:'Нет изменений'});
  const current=(await pool.query('SELECT * FROM knowledge_instruction_modules WHERE project_id=$1 AND id=$2',[id,instructionId])).rows[0];
  if(!current)return reply.code(404).send({error:'Инструкция не найдена'});
  const result=await pool.query(
   'UPDATE knowledge_instruction_modules SET title=$4,body=$5,stage=$6,tags=$7,mandatory=$8,status=$9,priority=$10,revision=revision+1,updated_at=now() WHERE id=$1 AND project_id=$2 AND revision=$3 RETURNING revision',
   [instructionId,id,data.expected_revision,data.title??current.title,data.body??current.body,data.stage===undefined?current.stage:data.stage,data.tags??current.tags,data.mandatory??current.mandatory,data.status??current.status,data.priority??current.priority]);
  if(!result.rowCount)return reply.code(409).send({error:'Инструкция уже изменена'});
  return {ok:true,revision:result.rows[0].revision};
 });
 app.delete('/api/projects/:id/knowledge/instructions/:instructionId',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id||!await requireAdmin(req,reply))return;
  const {instructionId}=z.object({instructionId:uuid}).parse(req.params);
  const r=await pool.query('DELETE FROM knowledge_instruction_modules WHERE id=$1 AND project_id=$2 RETURNING id',[instructionId,id]);
  if(!r.rowCount)return reply.code(404).send({error:'Инструкция не найдена'});
  return {ok:true};
 });
 app.get('/api/projects/:id/knowledge/task-links',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id)return;
  const {task_id,document_id}=z.object({task_id:uuid.optional(),document_id:uuid.optional()}).refine(v=>Boolean(v.task_id||v.document_id),'Необходимо указать задачу или документ').parse(req.query);
  const r=await pool.query('SELECT l.id,l.document_id,l.task_id,l.relation,d.title,d.knowledge_status FROM knowledge_task_links l JOIN documents d ON d.id=l.document_id AND d.project_id=l.project_id WHERE l.project_id=$1 AND ($2::uuid IS NULL OR l.task_id=$2) AND ($3::uuid IS NULL OR l.document_id=$3) ORDER BY d.title LIMIT 200',[id,task_id||null,document_id||null]);
  return {links:r.rows};
 });
 app.post('/api/projects/:id/knowledge/task-links',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id||!await requireAdmin(req,reply))return;
  const data=taskLink.parse(req.body);
  const r=await pool.query(
   'INSERT INTO knowledge_task_links(id,project_id,document_id,task_id,relation) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM documents WHERE id=$3 AND project_id=$2) AND EXISTS(SELECT 1 FROM tasks WHERE id=$4 AND project_id=$2) ON CONFLICT(project_id,document_id,task_id,relation) DO UPDATE SET relation=EXCLUDED.relation RETURNING id',
   [randomUUID(),id,data.document_id,data.task_id,data.relation]);
  if(!r.rowCount)return reply.code(400).send({error:'Задача и документ должны принадлежать проекту'});
  return reply.code(201).send({id:r.rows[0].id});
 });
 app.delete('/api/projects/:id/knowledge/task-links/:linkId',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id||!await requireAdmin(req,reply))return;
  const {linkId}=z.object({linkId:uuid}).parse(req.params);
  const r=await pool.query('DELETE FROM knowledge_task_links WHERE id=$1 AND project_id=$2 RETURNING id',[linkId,id]);
  if(!r.rowCount)return reply.code(404).send({error:'Связь не найдена'});
  return {ok:true};
 });
 app.get('/api/projects/:id/knowledge/artifact-links',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id)return;
  const {document_id}=z.object({document_id:uuid}).parse(req.query);
  const r=await pool.query('SELECT id,artifact_kind,artifact_ref,relation,created_at FROM knowledge_artifact_links WHERE project_id=$1 AND document_id=$2 ORDER BY created_at DESC',[id,document_id]);
  return {links:r.rows};
 });
 app.post('/api/projects/:id/knowledge/artifact-links',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id||!await requireAdmin(req,reply))return;
  const data=artifactLink.parse(req.body);
  const document=await pool.query('SELECT 1 FROM documents WHERE project_id=$1 AND id=$2',[id,data.document_id]);
  if(!document.rowCount)return reply.code(404).send({error:'Документ не найден'});
  if(data.artifact_kind==='qa_case'){
   if(!uuid.safeParse(data.artifact_ref).success)return reply.code(400).send({error:'Необходимо указать UUID тест-кейса'});
   const testCase=await pool.query('SELECT 1 FROM qa_test_cases WHERE id=$1 AND project_id=$2',[data.artifact_ref,id]);
   if(!testCase.rowCount)return reply.code(400).send({error:'Тест-кейс должен принадлежать проекту'});
  }
  if(data.artifact_kind==='pr'){
   const tasks=await pool.query('SELECT 1 FROM tasks WHERE project_id=$1 AND pr_url=$2',[id,data.artifact_ref]);
   if(!tasks.rowCount)return reply.code(400).send({error:'PR не привязан к задачам проекта'});
  }
  if(data.artifact_kind==='component'&&(!/^[\w./@-]+$/.test(data.artifact_ref)||data.artifact_ref.includes('..')))
   return reply.code(400).send({error:'Некорректный путь компонента'});
  const r=await pool.query('INSERT INTO knowledge_artifact_links(id,project_id,document_id,artifact_kind,artifact_ref,relation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,document_id,artifact_kind,artifact_ref,relation) DO UPDATE SET relation=EXCLUDED.relation RETURNING id',
   [randomUUID(),id,data.document_id,data.artifact_kind,data.artifact_ref,data.relation]);
  return reply.code(201).send({id:r.rows[0].id});
 });
 app.delete('/api/projects/:id/knowledge/artifact-links/:linkId',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id||!await requireAdmin(req,reply))return;
  const {linkId}=z.object({linkId:uuid}).parse(req.params);
  const r=await pool.query('DELETE FROM knowledge_artifact_links WHERE id=$1 AND project_id=$2 RETURNING id',[linkId,id]);
  if(!r.rowCount)return reply.code(404).send({error:'Связь не найдена'});
  return {ok:true};
 });
 app.get('/api/projects/:id/knowledge/task-context',async(req:any,reply)=>{
  const id=await project(req,reply);if(!id)return;
  const {task_id,stage}=z.object({task_id:uuid,stage:z.enum(['analysis','development','testing','documentation','manager']).default('analysis')}).parse(req.query);
  return buildKnowledgeContext(pool,{projectId:id,taskId:task_id,stage,budgetChars:10000});
 });
}

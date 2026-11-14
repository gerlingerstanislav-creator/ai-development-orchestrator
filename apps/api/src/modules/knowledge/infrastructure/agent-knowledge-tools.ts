import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {AgentSession} from '../../../agent-tools.js';
import {markdownSections,sectionBody} from '../../../markdown-knowledge-sections.js';
import {buildKnowledgeContext} from '../../../knowledge-workflow.js';
import {createDoc,updateDoc,deleteDoc,documentRevision as revision,createPage,updatePage,deleteEmptyPage} from './agent-document-pages.js';

const uuid=z.string().uuid();
const rejected=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const KNOWLEDGE_TOOLS=new Set([
 'documents.list','documents.read','documents.search','documents.create',
 'documents.update','documents.delete','documents.changeset','knowledge.search',
 'knowledge.read','knowledge.sections','knowledge.section','knowledge.related',
 'knowledge.context'
]);
export function isAgentKnowledgeTool(name:string){return KNOWLEDGE_TOOLS.has(name);}

/** Task/project-bound document and knowledge MCP commands. Use the exact DB
 * handle of the caller's MCP transaction; never create a second transaction.
 * Read-only sessions still persist bounded context-read audit evidence.
 */
export async function executeAgentKnowledgeTool(
 pool:Pick<Pool,'query'>,session:AgentSession,name:string,params:Record<string,unknown>
):Promise<unknown>{
 const projectId=session.project_id;
 switch(name){
 case 'documents.list':{
  const r=await pool.query('SELECT d.id,d.title,d.parent_id,d.system_key,d.updated_at,d.import_source,length(btrim(d.body))::int AS content_length,(SELECT count(*)::int FROM documents child WHERE child.project_id=d.project_id AND child.parent_id=d.id) AS child_count FROM documents d WHERE d.project_id=$1 ORDER BY d.title LIMIT 400',[projectId]);
  return {documents:r.rows.map(d=>({...d,revision:revision(d.updated_at)}))};
 }
 case 'documents.read':{
  const {document_id}=z.object({document_id:uuid}).parse(params);
  const r=await pool.query('SELECT id,title,body,parent_id,system_key,source_refs,updated_at,knowledge_status AS status FROM documents WHERE project_id=$1 AND id=$2',[projectId,document_id]);
  if(!r.rowCount)throw rejected('Страница не найдена',404);
  const document={...r.rows[0],revision:revision(r.rows[0].updated_at)};
  if(session.read_only)await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id,process_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [randomUUID(),projectId,session.task_id??null,document_id,document.revision,session.role,session.id,session.process_id??null]);
  return {document};
 }
 case 'documents.search':{
  const {query}=z.object({query:z.string().trim().min(2).max(150)}).parse(params);
  const r=await pool.query('SELECT id,title,parent_id,system_key,left(body,700) excerpt,updated_at,knowledge_status AS status FROM documents WHERE project_id=$1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY updated_at DESC LIMIT 40',
   [projectId,'%'+query+'%']);
  return {documents:r.rows.map(d=>({...d,revision:revision(d.updated_at)}))};
 }
 case 'documents.create':return createPage(pool,projectId,createDoc.parse(params));
 case 'documents.update':{
  const values=updateDoc.parse(params);
  return updatePage(pool,projectId,values);
 }
 case 'documents.delete':return deleteEmptyPage(pool,projectId,deleteDoc.parse(params));
 case 'documents.changeset':{
  const {operations}=z.object({operations:z.array(z.discriminatedUnion('op',[
   createDoc.extend({op:z.literal('create')}),
   updateDoc.extend({op:z.literal('update')}),
   deleteDoc.extend({op:z.literal('delete')})
  ])).min(1).max(40)}).parse(params);
  const changed=[];
  for(const operation of operations){
   if(operation.op==='create')changed.push(await createPage(pool,projectId,operation));
   else if(operation.op==='update')changed.push(await updatePage(pool,projectId,operation));
   else changed.push(await deleteEmptyPage(pool,projectId,operation));
  }
  return {changed};
 }

 case 'knowledge.search':{
  const {query,limit}=z.object({query:z.string().trim().min(2).max(300),limit:z.number().int().min(1).max(20).default(8)}).parse(params);
  const r=await pool.query(
   "SELECT id,title,parent_id,knowledge_summary AS summary,knowledge_tags AS tags,updated_at AS version,ts_rank_cd(to_tsvector('simple',title||' '||body),plainto_tsquery('simple',$2)) AS score FROM documents WHERE project_id=$1 AND knowledge_status='approved' AND (to_tsvector('simple',title||' '||body) @@ plainto_tsquery('simple',$2) OR title ILIKE '%'||$2||'%' OR body ILIKE '%'||$2||'%') ORDER BY score DESC,updated_at DESC LIMIT $3",
   [projectId,query,limit]);
  return {results:r.rows};
 }
 case 'knowledge.read':{
  const {document_id,mode,task_id}=z.object({document_id:uuid,mode:z.enum(['summary','full']).default('summary'),task_id:uuid.optional()}).parse(params);
  const r=await pool.query("SELECT id,title,parent_id,body,knowledge_summary,knowledge_status,knowledge_tags,updated_at FROM documents WHERE project_id=$1 AND id=$2 AND knowledge_status='approved'",[projectId,document_id]);
  if(!r.rowCount)throw rejected('Утверждённый документ не найден',404);
  if(task_id){
   const task=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[task_id,projectId]);
   if(!task.rowCount)throw rejected('Задача не найдена',404);
  }
  const d=r.rows[0];
  await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id,process_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [randomUUID(),projectId,task_id||null,document_id,revision(d.updated_at),session.role,session.id,session.process_id??null]);
  return {document:{id:d.id,title:d.title,parent_id:d.parent_id,status:d.knowledge_status,summary:d.knowledge_summary||d.body.slice(0,360),tags:d.knowledge_tags,version:revision(d.updated_at),...(mode==='full'?{body:d.body}:{})}};
 }


 case 'knowledge.sections':{
  const {document_id}=z.object({document_id:uuid}).parse(params);
  const r=await pool.query("SELECT title,body,updated_at FROM documents WHERE project_id=$1 AND id=$2 AND knowledge_status='approved'",[projectId,document_id]);
  if(!r.rowCount)throw rejected('Утверждённый документ не найден',404);
  const sections=markdownSections(document_id,String(r.rows[0].body)).map(s=>({section_id:s.section_id,level:s.level,title:s.title}));
  return {document_id,title:r.rows[0].title,version:revision(r.rows[0].updated_at),sections};
 }
 case 'knowledge.section':{
  const {document_id,section_id,task_id}=z.object({document_id:uuid,section_id:z.union([uuid,z.number().int().min(0)]),task_id:uuid.optional()}).parse(params);
  const r=await pool.query("SELECT body,title,updated_at FROM documents WHERE project_id=$1 AND id=$2 AND knowledge_status='approved'",[projectId,document_id]);
  if(!r.rowCount)throw rejected('Утверждённый документ не найден',404);
  if(task_id&&!await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[task_id,projectId]).then(r=>r.rowCount))throw rejected('Задача не найдена',404);
  const section=markdownSections(document_id,String(r.rows[0].body)).find(s=>typeof section_id==='number'?s.line===section_id:s.section_id===section_id);
  if(!section)throw rejected('Раздел не найден',404);
  await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id,process_id,section_id,section_title) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [randomUUID(),projectId,task_id||null,document_id,revision(r.rows[0].updated_at),session.role,session.id,session.process_id??null,section.section_id,section.title]);
  return {document_id,section_id:section.section_id,title:section.title,body:sectionBody(String(r.rows[0].body),section),version:revision(r.rows[0].updated_at)};
 }

 case 'knowledge.related':{
  const {document_id}=z.object({document_id:uuid}).parse(params);
  const r=await pool.query("SELECT k.id,k.relation,d.id AS related_document_id,d.title,d.knowledge_summary AS summary FROM knowledge_links k JOIN documents d ON d.id=CASE WHEN k.source_document_id=$2 THEN k.target_document_id ELSE k.source_document_id END AND d.project_id=$1 WHERE k.project_id=$1 AND (k.source_document_id=$2 OR k.target_document_id=$2) AND d.knowledge_status='approved' LIMIT 60",[projectId,document_id]);
  return {results:r.rows};
 }
 case 'knowledge.context':{
  const {task_id,stage,tags}=z.object({
   task_id:uuid,stage:z.enum(['analysis','development','testing','documentation','manager']).default('analysis'),
   tags:z.array(z.string().min(1).max(60)).max(24).default([])
  }).parse(params);
  return buildKnowledgeContext(pool,{projectId,taskId:task_id,stage,sessionId:session.id,tags});
 }
 default:throw rejected('Неизвестный документальный инструмент: '+name,404);
 }
}

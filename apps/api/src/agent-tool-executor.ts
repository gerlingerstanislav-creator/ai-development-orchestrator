import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hashSecret,type AgentSession} from './agent-tools.js';
import {extractGitHubDocumentLocation} from './github-document-import.js';
import {listIterations,readIteration,saveIteration,queueIterationPlanning,recommendIterationLaunch} from './project-iterations.js';
import {tasksWithCustomerQuestions} from './project-manager.js';
import {taskConversationEvidence} from './task-agent-notes.js';
import {buildKnowledgeContext} from './knowledge-workflow.js';
import {markdownSections,sectionBody} from './markdown-knowledge-sections.js';

const uuid=z.string().uuid();
const createDoc=z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000).default(''),parent_id:uuid,
 idempotency_key:z.string().min(8).max(120).optional()});
const updateDoc=z.object({document_id:uuid,expected_revision:z.string().datetime({offset:true}),title:z.string().trim().min(1).max(200).optional(),body:z.string().max(100000).optional(),parent_id:uuid.optional(),
 idempotency_key:z.string().min(8).max(120).optional()});
const revision=(value:unknown)=>new Date(value as string).toISOString();
function rejected(message:string,statusCode=409){return Object.assign(new Error(message),{statusCode});}
async function parentExists(db:Pick<Pool,'query'>,projectId:string,id:string){
 return !!(await db.query('SELECT id FROM documents WHERE id=$1 AND project_id=$2',[id,projectId])).rowCount;
}
async function createPage(db:Pick<Pool,'query'>,projectId:string,params:z.infer<typeof createDoc>){
 if(!await parentExists(db,projectId,params.parent_id))throw rejected('Родительская страница не найдена',404);
 const id=randomUUID();
 await db.query('INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,$3,$4,$5)',
  [id,projectId,params.title,params.body,params.parent_id]);
 return {id,title:params.title,parent_id:params.parent_id};
}
async function updatePage(db:Pick<Pool,'query'>,projectId:string,params:z.infer<typeof updateDoc>){
 const old=(await db.query('SELECT id,title,body,parent_id,system_key,updated_at FROM documents WHERE project_id=$1 AND id=$2 FOR UPDATE',
  [projectId,params.document_id])).rows[0];
 if(!old)throw rejected('Страница не найдена',404);
 const title=params.title??old.title,parent=params.parent_id??old.parent_id;
 if(old.system_key&&(title!==old.title||parent!==old.parent_id))throw rejected('Системный раздел нельзя переименовать или переместить');
 if(![params.title,params.body,params.parent_id].some(x=>x!==undefined))throw rejected('Нет изменений',400);
 if(parent!==old.parent_id){
  if(!await parentExists(db,projectId,parent))throw rejected('Родительская страница не найдена',404);
  const ancestors=await db.query(
   'WITH RECURSIVE parents AS (SELECT id,parent_id FROM documents WHERE id=$1 AND project_id=$2 UNION ALL SELECT d.id,d.parent_id FROM documents d JOIN parents p ON p.parent_id=d.id WHERE d.project_id=$2) SELECT id FROM parents WHERE id=$3 LIMIT 1',
   [parent,projectId,params.document_id]);
  if(ancestors.rowCount)throw rejected('Нельзя переместить страницу в собственного потомка');
 }
 if(revision(old.updated_at)!==revision(params.expected_revision))throw rejected('Страница изменилась с момента чтения. Получи новую revision через documents.read.');
 const updated=await db.query(
  'WITH updated AS (UPDATE documents SET title=$3,body=$4,parent_id=$5,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2 RETURNING id,body,updated_at), revision AS (INSERT INTO document_versions(id,document_id,body) SELECT gen_random_uuid(),id,body FROM updated) SELECT updated_at FROM updated',
  [projectId,params.document_id,title,params.body??old.body,parent]);
 return {id:params.document_id,revision:revision(updated.rows[0].updated_at)};
}
export async function executeAgentTool(pool:Pick<Pool,'query'>,session:AgentSession,name:string,args:unknown,
 _startWorkflow:(jobId:string)=>Promise<void>):Promise<unknown>{
 const projectId=session.project_id,actorId=session.actor_id;
 const params=(args&&typeof args==='object'&&!Array.isArray(args)?args:{}) as Record<string,unknown>;
 switch(name){
 case 'iterations.list':return listIterations(pool,projectId);
 case 'iterations.read':{
  const {iteration_id}=z.object({iteration_id:uuid}).parse(params);
  return readIteration(pool,projectId,iteration_id);
 }
 case 'iterations.save':return saveIteration(pool,projectId,params);
 case 'iterations.prepare_plan':return queueIterationPlanning(pool,projectId,actorId,params);
 case 'iterations.recommend_launch':return recommendIterationLaunch(pool,projectId,params);
 case 'project.context':{
  const [p,stages,rules,github]=await Promise.all([
   pool.query('SELECT id,name,description FROM projects WHERE id=$1',[projectId]),
   pool.query('SELECT stage,label,mode,agent_name,agent_instructions,position FROM workflow_stages WHERE project_id=$1 ORDER BY position',[projectId]),
   pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 80',[projectId]),
   pool.query('SELECT repository,target_branch,default_branch FROM project_git_repositories WHERE project_id=$1',[projectId])
  ]);
  return {project:p.rows[0],workflow:stages.rows,rules:rules.rows.map(r=>r.body),github:github.rows[0]||null};
 }
 case 'documents.list':{
  const r=await pool.query('SELECT id,title,parent_id,system_key,updated_at,import_source FROM documents WHERE project_id=$1 ORDER BY title LIMIT 400',[projectId]);
  return {documents:r.rows.map(d=>({...d,revision:revision(d.updated_at)}))};
 }
 case 'documents.read':{
  const {document_id}=z.object({document_id:uuid}).parse(params);
  const r=await pool.query('SELECT id,title,body,parent_id,system_key,source_refs,updated_at FROM documents WHERE project_id=$1 AND id=$2',[projectId,document_id]);
  if(!r.rowCount)throw rejected('Страница не найдена',404);
  return {document:{...r.rows[0],revision:revision(r.rows[0].updated_at)}};
 }
 case 'documents.search':{
  const {query}=z.object({query:z.string().trim().min(2).max(150)}).parse(params);
  const r=await pool.query('SELECT id,title,parent_id,system_key,left(body,1500) excerpt,updated_at FROM documents WHERE project_id=$1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY updated_at DESC LIMIT 40',
   [projectId,'%'+query+'%']);
  return {documents:r.rows.map(d=>({...d,revision:revision(d.updated_at)}))};
 }
 case 'tasks.request_owner_question_cleanup':
 case 'documentation.request_reset':{
  z.object({}).strict().parse(params);
  return {requires_user_confirmation:true};
 }
 case 'documents.create':return createPage(pool,projectId,createDoc.parse(params));
 case 'documents.update':{
  const values=updateDoc.parse(params);
  return updatePage(pool,projectId,values);
 }
 case 'documents.changeset':{
  const {operations}=z.object({operations:z.array(z.discriminatedUnion('op',[
   createDoc.extend({op:z.literal('create')}),
   updateDoc.extend({op:z.literal('update')})
  ])).min(1).max(40)}).parse(params);
  const changed=[];
  for(const operation of operations){
   if(operation.op==='create')changed.push(await createPage(pool,projectId,operation));
   else changed.push(await updatePage(pool,projectId,operation));
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
  await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [randomUUID(),projectId,task_id||null,document_id,revision(d.updated_at),session.role,session.id]);
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
  await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [randomUUID(),projectId,task_id||null,document_id,revision(r.rows[0].updated_at),session.role,session.id]);
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

 case 'tasks.list':{
  const {product_owner_questions_only}=z.object({product_owner_questions_only:z.boolean().optional()}).parse(params);
  if(product_owner_questions_only){
   const tasks=(await tasksWithCustomerQuestions(pool,projectId)).filter(task=>task.awaits_product_owner);
   return {tasks:tasks.map(({id,title,stage,type,document_id,question_status,analysis_state,display_number})=>({id,title,stage,type,document_id,question_status,analysis_state,display_number}))};
  }
  const r=await pool.query('SELECT id,title,description,type,stage,analysis_state,display_number,document_id,question_status,updated_at FROM tasks WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 500',[projectId]);
  return {tasks:r.rows};
 }
 case 'tasks.read':{
  const {task_id}=z.object({task_id:uuid}).parse(params);
  const r=await pool.query('SELECT id,title,description,stage,analysis_state,clarification_questions,depends_on_task_id,pr_url,updated_at FROM tasks WHERE project_id=$1 AND id=$2',[projectId,task_id]);
  if(!r.rowCount)throw rejected('Задача не найдена',404);
  const [conversation,questions]=await Promise.all([
   taskConversationEvidence(pool,projectId,task_id),
   pool.query("SELECT body AS question,answer,answer_author FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status='answered' AND answer IS NOT NULL ORDER BY answered_at DESC NULLS LAST,id DESC LIMIT 12",[projectId,task_id])
  ]);
  return {task:r.rows[0],conversation,answered_questions:questions.rows};
 }
 case 'tasks.create':{
  const {title,description}=z.object({title:z.string().trim().min(3).max(180),description:z.string().trim().min(10).max(12000)}).parse(params);
  const id=randomUUID();
  // Same initial state as the public task-creation API: the agent can create
  // work, but cannot bypass analysis or requirement acceptance by creating it.
  await pool.query("INSERT INTO tasks(id,project_id,title,description,type,position) VALUES($1,$2,$3,$4,'task',(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2))",[id,projectId,title,description]);
  await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'created','Создано агентом через инструменты сервиса')",[randomUUID(),id,actorId]);
  return {id,stage:'backlog'};
 }
 case 'questions.list':{
  const r=await pool.query("SELECT q.id,q.description AS question,q.question_answer AS answer,q.question_status AS status,q.document_id,d.title AS document_title FROM tasks q JOIN documents d ON d.id=q.document_id WHERE q.project_id=$1 AND q.type='question' AND q.question_status IN ('open','answered') ORDER BY q.created_at DESC LIMIT 500",[projectId]);
  return {questions:r.rows};
 }
 case 'questions.create':{
  const {document_id,question}=z.object({document_id:uuid,question:z.string().trim().min(8).max(700)}).parse(params);
  if(!await parentExists(pool,projectId,document_id))throw rejected('Документ не найден',404);
  const key=hashSecret(question.trim().toLowerCase()).slice(0,24);
  await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage,position,document_id,question_key,question_topic,question_status) VALUES($1,$2,$3,$4,'question','backlog',(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2),$5,$6,'agent','open') ON CONFLICT DO NOTHING",
   [randomUUID(),projectId,question.slice(0,300),question,document_id,key]);
  return {document_id,question_key:key};
 }
 case 'documentation.import':case 'documentation.rebuild':case 'documentation.organize':{
  const data=z.object({source_url:z.string().url().max(1000).optional(),instructions:z.string().max(4000).default('')}).parse(params);
  const location=name==='documentation.import'?extractGitHubDocumentLocation(data.source_url||''):null;
  if(name==='documentation.import'&&!location)throw rejected('Укажи URL папки или Markdown-файла GitHub');
  const jobId=randomUUID(),sourceUrl=data.source_url||null;
  const input={location,attachments:[],mode:'documentation',documentId:null,
   structureOnly:name==='documentation.organize',rebuildSpec:name==='documentation.rebuild'};
  const sourceKey=location?'github-ai:'+location.owner+'/'+location.repository+'@'+location.branch+':'+location.path:name+':'+jobId;
  const competing=await pool.query(
   "SELECT id FROM document_import_jobs WHERE project_id=$1 AND status IN ('running','queued') LIMIT 1 FOR UPDATE",
   [projectId]);
  if(competing.rowCount)throw rejected('В проекте уже выполняется процесс аналитика');
  // The job and audit event commit together. Temporal is started only after COMMIT,
  // and a retry of the same idempotency key recovers a queued job, not a new one.
  await pool.query(
   "INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,source_url,source_key,request_text,analyst_input) VALUES($1,$2,$3,'queued','Запуск процесса ожидает Temporal',$4,$5,$6,$7)",
   [jobId,projectId,actorId,sourceUrl,sourceKey,data.instructions||name,JSON.stringify(input)]);
  return {import_job_id:jobId,status:'queued',kind:name};
 }
 case 'processes.list':{
  const [a,b]=await Promise.all([
   pool.query('SELECT id,status,message,created_at,updated_at FROM document_import_jobs WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 30',[projectId]),
   pool.query('SELECT id,task_id,status,message,created_at,completed_at FROM ai_task_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',[projectId])
  ]);
  return {documentation:a.rows,development:b.rows};
 }
 case 'processes.report':{
  const {stage,message}=z.object({stage:z.string().trim().min(2).max(80),message:z.string().trim().min(3).max(2000)}).parse(params);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'agent',$4,$5)",
   [randomUUID(),projectId,session.id,stage,message]);
  return {reported:true};
 }
 case 'memory.list':{
  const r=await pool.query('SELECT id,role,kind,body,evidence,status,created_at FROM agent_memory WHERE project_id=$1 ORDER BY created_at DESC LIMIT 60',[projectId]);
  return {memories:r.rows};
 }
 case 'memory.record':{
  const {kind,text,evidence}=z.object({kind:z.enum(['observation','instruction_suggestion']),text:z.string().trim().min(15).max(1600),evidence:z.string().max(600).default('')}).parse(params);
  const id=randomUUID(),status=kind==='observation'?'recorded':'proposed';
  await pool.query(
   'INSERT INTO agent_memory(id,project_id,session_id,role,kind,body,evidence,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [id,projectId,session.id,session.role,kind,text,evidence,status]);
  return {id,status};
 }
 default:throw rejected('Неизвестный инструмент: '+name,404);
 }
}

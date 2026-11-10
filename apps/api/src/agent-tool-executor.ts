import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hashSecret,type AgentSession} from './agent-tools.js';
import {extractGitHubDocumentLocation} from './github-document-import.js';

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
  'UPDATE documents SET title=$3,body=$4,parent_id=$5,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2 RETURNING updated_at',
  [projectId,params.document_id,title,params.body??old.body,parent]);
 return {id:params.document_id,revision:revision(updated.rows[0].updated_at)};
}
export async function executeAgentTool(pool:Pick<Pool,'query'>,session:AgentSession,name:string,args:unknown,
 _startWorkflow:(jobId:string)=>Promise<void>):Promise<unknown>{
 const projectId=session.project_id,actorId=session.actor_id;
 const params=(args&&typeof args==='object'&&!Array.isArray(args)?args:{}) as Record<string,unknown>;
 switch(name){
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
 case 'tasks.list':{
  const r=await pool.query('SELECT id,title,description,stage,analysis_state,display_number,updated_at FROM tasks WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 100',[projectId]);
  return {tasks:r.rows};
 }
 case 'tasks.read':{
  const {task_id}=z.object({task_id:uuid}).parse(params);
  const r=await pool.query('SELECT id,title,description,stage,analysis_state,clarification_questions,depends_on_task_id,pr_url,updated_at FROM tasks WHERE project_id=$1 AND id=$2',[projectId,task_id]);
  if(!r.rowCount)throw rejected('Задача не найдена',404);return {task:r.rows[0]};
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
  const r=await pool.query("SELECT q.id,q.question,q.answer,q.status,q.document_id,d.title AS document_title FROM documentation_questions q JOIN documents d ON d.id=q.document_id WHERE q.project_id=$1 AND q.status IN ('open','answered') ORDER BY q.created_at DESC LIMIT 100",[projectId]);
  return {questions:r.rows};
 }
 case 'questions.create':{
  const {document_id,question}=z.object({document_id:uuid,question:z.string().trim().min(8).max(700)}).parse(params);
  if(!await parentExists(pool,projectId,document_id))throw rejected('Документ не найден',404);
  const key=hashSecret(question.trim().toLowerCase()).slice(0,24);
  await pool.query("INSERT INTO documentation_questions(id,project_id,job_id,topic_key,question_key,document_id,question) VALUES($1,$2,NULL,'agent',$3,$4,$5) ON CONFLICT(project_id,document_id,question_key) DO NOTHING",
   [randomUUID(),projectId,key,document_id,question]);
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

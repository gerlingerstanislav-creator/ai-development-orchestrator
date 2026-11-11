import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {agentToolCatalog,readAgentSession,hashSecret,toolsForRole,type AgentSession} from './agent-tools.js';
import {executeAgentTool} from './agent-tool-executor.js';

const uuid=z.string().uuid();
const callSchema=z.object({
 name:z.string().min(2).max(90),
 arguments:z.record(z.unknown()).default({})
});
function redactArgs(args:Record<string,unknown>){
 const safe=JSON.parse(JSON.stringify(args));
 for(const key of ['body','instructions','description','question','text'])
  if(typeof safe[key]==='string')safe[key]={size:Buffer.byteLength(safe[key]),sha256:hashSecret(safe[key])};
 if(Array.isArray(safe.operations))
  safe.operations=safe.operations.map((op:any)=>({...op,body:typeof op.body==='string'?{size:Buffer.byteLength(op.body),sha256:hashSecret(op.body)}:undefined}));
 return safe;
}
export function registerAgentToolRoutes(app:FastifyInstance, deps:{
 pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 startDocumentationWorkflow:(jobId:string)=>Promise<void>;
 startIterationPlanning?:(runId:string)=>Promise<void>;
 delegateManagerAction?:(session:AgentSession,name:string,args:Record<string,unknown>)=>Promise<unknown>;
}){
 const {pool,access,requireAdmin,startDocumentationWorkflow,startIterationPlanning,delegateManagerAction}=deps;
 async function startQueuedJob(jobId:string){
  const row=(await pool.query('SELECT status FROM document_import_jobs WHERE id=$1',[jobId])).rows[0];
  if(!row)throw Object.assign(Error('Процесс не найден'),{statusCode:404});
  if(row.status==='completed')return 'completed';
  if(row.status==='failed')return 'failed';
  await pool.query("UPDATE document_import_jobs SET status='running',message='Temporal: запуск процесса' WHERE id=$1 AND status='queued'",[jobId]);
  try{
   await startDocumentationWorkflow(jobId);
  }catch(error){
   // Replaying a committed idempotent operation is allowed to find
   // the same Temporal workflow already executing, not to start a duplicate.
   const duplicate=error instanceof Error&&
    (error.name==='WorkflowExecutionAlreadyStartedError'||error.name==='WorkflowAlreadyStartedError');
   if(!duplicate){
    // Keep the persisted job retryable when Temporal is temporarily offline.
    // No new job ID or duplicate document import is created on subsequent starts.
    await pool.query("UPDATE document_import_jobs SET status='queued',message=$2 WHERE id=$1 AND status='running' AND message='Temporal: запуск процесса'",
     [jobId,'Ожидается повторный запуск Temporal: '+String(error instanceof Error?error.message:error).slice(0,250)]);
    throw error;
   }
  }
  return 'running';
 }
 // An API crash can happen after the queued job commits and before Temporal
 // accepts its workflow start. Reconcile durable intent after restarts and
 // periodically; duplicate workflow IDs are treated as already started.
 let recoverTimer:ReturnType<typeof setInterval>|null=null;
 let recovering=false;
 async function recoverQueuedJobs(){
  if(recovering)return;
  recovering=true;
  try{
   const pending=await pool.query(
    "SELECT id FROM document_import_jobs WHERE analyst_input IS NOT NULL AND (status='queued' OR (status='running' AND message='Temporal: запуск процесса')) ORDER BY created_at LIMIT 15");
   for(const job of pending.rows){
    try{await startQueuedJob(job.id);}
    catch(error){app.log.error({error,jobId:job.id},'Could not recover durable agent workflow start');}
   }
   if(startIterationPlanning){
    const iterations=await pool.query("SELECT id FROM iteration_planning_runs WHERE status='queued' ORDER BY created_at LIMIT 15");
    for(const run of iterations.rows){
     await startIterationPlanning(run.id).catch(error=>app.log.error({error,runId:run.id},'Could not dispatch iteration planning'));
    }
   }
  }finally{recovering=false;}
 }
 app.addHook('onReady',async()=>{
  await recoverQueuedJobs().catch(error=>app.log.error({error},'Agent workflow recovery failed'));
  recoverTimer=setInterval(()=>{
   void recoverQueuedJobs().catch(error=>app.log.error({error},'Agent workflow recovery failed'));
  },20000);
  recoverTimer.unref?.();
 });
 app.addHook('onClose',async()=>{if(recoverTimer)clearInterval(recoverTimer);});
 const authenticate=async(req:any,reply:any)=>{
  const session=await readAgentSession(pool,String(req.headers['x-agent-token']||''));
  if(!session){reply.code(403).send({error:'Сессия агента недоступна или истекла'});return null;}
  return session;
 };
 app.get('/internal/agent-tools/catalog',async(req:any,reply)=>{
  const session=await authenticate(req,reply);if(!session)return;
  return {tools:toolsForRole(session.role)};
 });
 app.post('/internal/agent-tools/call',async(req:any,reply)=>{
  const session=await authenticate(req,reply);if(!session)return;
  const parsed=callSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'Неверные параметры вызова инструмента'});
  const {name,arguments:args}=parsed.data;
  const tool=toolsForRole(session.role).find(tool=>tool.name===name);
  if(!tool)return reply.code(403).send({error:'Инструмент недоступен для роли '+session.role});
  const key=typeof args.idempotency_key==='string'&&args.idempotency_key.length>=8&&args.idempotency_key.length<=120?args.idempotency_key:null;
  const digest=hashSecret(JSON.stringify({name,args}));
  const mutating=!tool.annotations.readOnlyHint;
  // All PostgreSQL changes and their success evidence use the SAME
  // transaction, including document changesets, task creation and memories.
  const connection=mutating?await pool.connect():null;
  let txOpen=false;
  try{
   if(connection){await connection.query('BEGIN');txOpen=true;}
   const db=connection||pool;
   if(connection&&key)
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
     [session.project_id+':'+name+':'+key]);
   if(connection&&name.startsWith('documentation.'))
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
     [session.project_id+':documentation']);
   if(key){
    const previous=await db.query(
     'SELECT result,arguments FROM agent_tool_events WHERE project_id=$1 AND tool=$2 AND idempotency_key=$3 AND success=true LIMIT 1',
     [session.project_id,name,key]);
    if(previous.rowCount){
     const previousDigest=previous.rows[0].arguments?.request_digest;
     if(previousDigest!==digest){
      if(connection){await connection.query('ROLLBACK');txOpen=false;}
      return reply.code(409).send({error:'Ключ идемпотентности уже используется с другими аргументами'});
     }
     if(connection){await connection.query('COMMIT');txOpen=false;}
     const result=previous.rows[0].result;
     if(name.startsWith('documentation.')&&result?.import_job_id)
      return {result:{...result,status:await startQueuedJob(result.import_job_id)},cached:true};
     if(startIterationPlanning&&['iterations.prepare_plan','pm.decisions.record'].includes(name)&&result?.planning_run_id&&result?.status==='queued')
      await startIterationPlanning(result.planning_run_id).catch(error=>req.log.error({error},'Iteration planning will retry dispatch'));
     return {result,cached:true};
    }
   }
   const delegated=['approvals.decide','approvals.answer_question','workflow.approve_development'].includes(name);
   if(delegated&&(!delegateManagerAction||session.role!=='manager'))throw Error('Недоступно делегированное действие ПМ');
   const result=delegated
    ?await delegateManagerAction!(session,name,args)
    :await executeAgentTool(db as Pool,session,name,args,startDocumentationWorkflow);
   await db.query(
    'INSERT INTO agent_tool_events(id,session_id,project_id,tool,arguments,result,success,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
    [randomUUID(),session.id,session.project_id,name,JSON.stringify({...redactArgs(args),request_digest:digest}),JSON.stringify(result),key]);
   if(connection){await connection.query('COMMIT');txOpen=false;}
   if(name.startsWith('documentation.')&&(result as any)?.import_job_id){
    const state=await startQueuedJob((result as any).import_job_id);
    return {result:{...(result as object),status:state}};
   }
   const planning=result as {planning_run_id?:string;status?:string};
   if(startIterationPlanning&&['iterations.prepare_plan','pm.decisions.record'].includes(name)&&planning.planning_run_id&&planning.status==='queued')
    await startIterationPlanning(planning.planning_run_id).catch(error=>req.log.error({error},'Iteration planning will retry dispatch'));
   return {result};
  }catch(error){
   if(txOpen&&connection)await connection.query('ROLLBACK').catch(()=>{});
   const message=error instanceof Error?error.message:String(error);
   await pool.query(
    'INSERT INTO agent_tool_events(id,session_id,project_id,tool,arguments,result,success) VALUES($1,$2,$3,$4,$5,$6,false)',
    [randomUUID(),session.id,session.project_id,name,JSON.stringify({...redactArgs(args),request_digest:digest}),JSON.stringify({error:message.slice(0,400)})]).catch(()=>{});
   return reply.code(Math.min(599,Math.max(400,Number((error as any).statusCode)||400))).send({error:message.slice(0,650)});
  }finally{connection?.release();}
 });
 app.get('/api/projects/:id/agent-memory',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const r=await pool.query('SELECT id,role,kind,body,evidence,status,created_at FROM agent_memory WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[id]);
  return {memories:r.rows};
 });
 app.post('/api/projects/:id/agent-memory/:memoryId/review',async(req:any,reply)=>{
  const {id,memoryId}=z.object({id:uuid,memoryId:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {decision}=z.object({decision:z.enum(['approved','rejected'])}).parse(req.body);
  const r=await pool.query(
   "UPDATE agent_memory SET status=$3,reviewed_at=now() WHERE project_id=$1 AND id=$2 AND status='proposed' RETURNING id,kind,body,status",
   [id,memoryId,decision]);
  if(!r.rowCount)return reply.code(409).send({error:'Предложение уже обработано'});
  return {memory:r.rows[0]};
 });
 app.get('/api/projects/:id/agent-tool-events',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const r=await pool.query(
   'SELECT id,session_id,tool,arguments,result,success,created_at FROM agent_tool_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 120',
   [id]);
  return {events:r.rows};
 });
}

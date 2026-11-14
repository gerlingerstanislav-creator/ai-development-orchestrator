import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {agentToolCatalog,readAgentSession,hashSecret,toolsForRole,toolsForSession,readSessionToolGrants,createAgentReaderSession,finishAgentSession,readerRoles,type AgentSession} from './agent-tools.js';
import {executeAgentTool} from './agent-tool-executor.js';
import {annotatePmToolResult} from './pm-goal-policy.js';
import {inspectGitHubProjectSource} from './documentation-preparation.js';

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
 runnerSecret?:string;
 startDocumentationWorkflow:(jobId:string)=>Promise<void>;
 startIterationPlanning?:(runId:string)=>Promise<void>;
 delegateManagerAction?:(session:AgentSession,name:string,args:Record<string,unknown>)=>Promise<unknown>;
 decryptToken?:(encrypted:string)=>string;
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
 const authorizeRunner=(req:any,reply:any)=>{
  const supplied=Buffer.from(String(req.headers['x-runner-secret']||''));
  const expected=Buffer.from(deps.runnerSecret||'');
  if(expected.length>=32&&supplied.length===expected.length&&timingSafeEqual(supplied,expected))return true;
  reply.code(403).send({error:'Доступно только исполнителю агента'});
  return false;
 };
 app.post('/internal/agent-tools/reader-sessions',async(req,reply)=>{
  if(!authorizeRunner(req,reply))return;
  const scope=z.object({projectId:uuid,role:z.enum(readerRoles),taskId:uuid.optional(),processId:uuid.optional(),actorId:uuid.optional()}).strict().safeParse(req.body);
  if(!scope.success)return reply.code(400).send({error:'Некорректная область чтения'});
  const session=await createAgentReaderSession(pool,scope.data);
  if(!session)return reply.code(404).send({error:'Проект или задача недоступны'});
  return reply.code(201).send(session);
 });
 app.delete('/internal/agent-tools/reader-sessions',async(req,reply)=>{
  if(!authorizeRunner(req,reply))return;
  const session=await readAgentSession(pool,String(req.headers['x-agent-token']||''));
  if(session)await finishAgentSession(pool,session.id); // Every transient reader/specialist session is closed.
  return reply.code(204).send();
 });
 app.get('/internal/agent-tools/catalog',async(req:any,reply)=>{
  const session=await authenticate(req,reply);if(!session)return;
  const grants=await readSessionToolGrants(pool,session);
  return {tools:toolsForSession(session.role,session.read_only,grants)};
 });
 app.post('/internal/agent-tools/call',async(req:any,reply)=>{
  const session=await authenticate(req,reply);if(!session)return;
  const parsed=callSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'Неверные параметры вызова инструмента'});
  const {name,arguments:args}=parsed.data;
  const grantedTools=await readSessionToolGrants(pool,session);
  const tool=toolsForSession(session.role,session.read_only,grantedTools).find(tool=>tool.name===name);
  if(!tool)return reply.code(403).send({error:'Инструмент недоступен для роли '+session.role});
  const key=!session.read_only&&typeof args.idempotency_key==='string'&&args.idempotency_key.length>=8&&args.idempotency_key.length<=120?args.idempotency_key:null;
  const digest=hashSecret(JSON.stringify({name,args}));
  const mutating=!tool.annotations.readOnlyHint;
  if(mutating&&session.role==='documentation'){
   if(!session.process_id)return reply.code(403).send({error:'Нет поручения аналитика'});
   const running=await pool.query(
    "SELECT id FROM document_import_jobs WHERE id=$1 AND project_id=$2 AND status='running' UNION ALL SELECT id FROM agent_work_assignments WHERE id=$1 AND project_id=$2 AND task_id=$3 AND role='documentation' AND status='running'",
    [session.process_id,session.project_id,session.task_id||null]);
   if(!running.rowCount)return reply.code(409).send({error:'Поручение аналитика уже не выполняется'});
  }
  // All PostgreSQL changes and their success evidence use the SAME
  // transaction, including document changesets, task creation and memories.
  const connection=mutating?await pool.connect():null;
  let txOpen=false;
  try{
   if(connection){await connection.query('BEGIN');txOpen=true;}
   const db=connection||pool;
   // Revocation and source-spec changes must not race elevated side effects.
   // Keep a share lock on the actual task and assignment until the tool audit
   // and its database effects commit atomically.
   if(connection&&!toolsForRole(session.role,session.read_only).some(tool=>tool.name===name)){
    const live=await readSessionToolGrants(connection,session,true);
    if(!live.includes(name))throw Object.assign(Error('Дополнительное право отозвано или поручение завершено'),{statusCode:403});
   }
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
   const delegated=['approvals.decide','approvals.answer_question','approvals.deliver_task_answer','tasks.delete','tasks.cancel','tasks.close','workflow.move_task','workflow.approve_development','workflow.release_task','tasks.update_dependency','qa.retry'].includes(name);
   if(delegated&&(!delegateManagerAction||session.role!=='manager'))throw Error('Недоступно делегированное действие ПМ');
   const rawResult=delegated
    ?await delegateManagerAction!(session,name,args)
    :await executeAgentTool(db as Pool,session,name,args,startDocumentationWorkflow,
      async(projectId,actorId,path,commit)=>{
       const linked=(await db.query(`SELECT g.repository,g.default_branch,g.target_branch,c.secret_encrypted
        FROM project_git_repositories g LEFT JOIN connections c ON c.id=g.connection_id AND c.owner_id=$2
        WHERE g.project_id=$1`,[projectId,actorId])).rows[0];
       if(!linked)return {available:false,reason:'К проекту не подключён GitHub-репозиторий'};
       if(!linked.secret_encrypted||!deps.decryptToken)
        return {available:false,reason:'Для GitHub-репозитория нет доступного подключения с правом Contents: Read'};
       const token=deps.decryptToken(linked.secret_encrypted);
       return {available:true,...await inspectGitHubProjectSource(linked.repository,
        commit||linked.target_branch||linked.default_branch||'main',token,path)};
      },grantedTools);
   const result=session.role==='manager'?annotatePmToolResult(name,rawResult):rawResult;
   // A successful PM delegation is explicit authorization to wake the
   // project's specialists. Informational tools and chat leave Stop intact.
   if(session.role==='manager'&&(result as any)?.status!=='blocked'&&(result as any)?.ok!==false&&(result as any)?.recorded!==false&&new Set([
    'tasks.create','tasks.route_execution','tasks.retry_evidence','work.delegate','work.plan','work.review','work.grant','iterations.prepare_plan','iterations.launch',
    'workflow.approve_development','workflow.move_task','workflow.release_task',
    'qa.retry','documentation.import','documentation.prepare_spec',
    'documentation.rebuild','documentation.organize',
    'approvals.answer_question','approvals.deliver_task_answer','approvals.decide'
   ]).has(name))
    await db.query('UPDATE projects SET agents_running=true WHERE id=$1 AND deleted_at IS NULL',[session.project_id]);
   await db.query(
    'INSERT INTO agent_tool_events(id,session_id,project_id,tool,arguments,result,success,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
    [randomUUID(),session.id,session.project_id,name,JSON.stringify({...redactArgs(args),request_digest:digest}),JSON.stringify(session.read_only?{read:true}:result),key]);
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

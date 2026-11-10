import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {agentToolCatalog,readAgentSession,hashSecret} from './agent-tools.js';
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
 startDocumentationWorkflow:(jobId:string)=>Promise<void>
}){
 const {pool,access,requireAdmin,startDocumentationWorkflow}=deps;
 const authenticate=async(req:any,reply:any)=>{
  const session=await readAgentSession(pool,String(req.headers['x-agent-token']||''));
  if(!session){reply.code(403).send({error:'Сессия агента недоступна или истекла'});return null;}
  return session;
 };
 app.get('/internal/agent-tools/catalog',async(req:any,reply)=>{
  const session=await authenticate(req,reply);if(!session)return;
  return {tools:agentToolCatalog};
 });
 app.post('/internal/agent-tools/call',async(req:any,reply)=>{
  const session=await authenticate(req,reply);if(!session)return;
  const parsed=callSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'Неверные параметры вызова инструмента'});
  const {name,arguments:args}=parsed.data;
  if(!agentToolCatalog.some(tool=>tool.name===name))return reply.code(404).send({error:'Неизвестный инструмент'});
  const key=typeof args.idempotency_key==='string'&&args.idempotency_key.length>=8&&args.idempotency_key.length<=120?args.idempotency_key:null;
  const digest=hashSecret(JSON.stringify({name,args}));
  // A project-level advisory lock prevents a repeated, simultaneous tool request
  // from executing twice when Codex retries after a network timeout.
  const locker=key?await pool.connect():null;
  try{
   if(locker){
    await locker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[session.project_id+':'+name+':'+key]);
    const previous=await locker.query(
     'SELECT result,arguments FROM agent_tool_events WHERE project_id=$1 AND tool=$2 AND idempotency_key=$3 AND success=true LIMIT 1',
     [session.project_id,name,key]);
    if(previous.rowCount){
     const previousDigest=previous.rows[0].arguments?.request_digest;
     if(previousDigest!==digest)return reply.code(409).send({error:'Ключ идемпотентности уже используется с другими аргументами'});
     return {result:previous.rows[0].result,cached:true};
    }
   }
   const result=await executeAgentTool(pool,session,name,args,startDocumentationWorkflow);
   await pool.query(
    'INSERT INTO agent_tool_events(id,session_id,project_id,tool,arguments,result,success,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
    [randomUUID(),session.id,session.project_id,name,JSON.stringify({...redactArgs(args),request_digest:digest}),JSON.stringify(result),key]);
   return {result};
  }catch(error){
   const message=error instanceof Error?error.message:String(error);
   await pool.query(
    'INSERT INTO agent_tool_events(id,session_id,project_id,tool,arguments,result,success) VALUES($1,$2,$3,$4,$5,$6,false)',
    [randomUUID(),session.id,session.project_id,name,JSON.stringify({...redactArgs(args),request_digest:digest}),JSON.stringify({error:message.slice(0,400)})]).catch(()=>{});
   return reply.code(Math.min(599,Math.max(400,Number((error as any).statusCode)||400))).send({error:message.slice(0,650)});
  }finally{
   if(locker){await locker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[session.project_id+':'+name+':'+key]).catch(()=>{});locker.release();}
  }
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

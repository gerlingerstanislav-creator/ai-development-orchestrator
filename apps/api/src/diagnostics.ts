import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';

const uuid=z.string().uuid();
const sensitiveKey=/^(?:authorization|cookie|set-cookie|password|password_hash|token|access_token|refresh_token|secret|secret_encrypted|api_key|credentials|client_secret|runner_shared_secret|jwt_secret|credentials_key)$/i;

export function redactDiagnostic(value:unknown,depth=0):unknown {
 if(depth>9)return '[TRUNCATED]';
 if(typeof value==='string'){
  return value.slice(0,16000)
   .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[REDACTED]')
   .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g,'[REDACTED]')
   .replace(/((?:password|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*["']?)[^\s"',;&]+/gi,'$1[REDACTED]')
   .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@');
 }
 if(value===null||typeof value==='number'||typeof value==='boolean')return value;
 if(value instanceof Date)return value.toISOString();
 if(Array.isArray(value))return value.slice(0,1200).map(item=>redactDiagnostic(item,depth+1));
 if(typeof value==='object'){
  const result:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value).slice(0,120)){
   result[key]=sensitiveKey.test(key)?'[REDACTED]':redactDiagnostic(item,depth+1);
  }
  return result;
 }
 return String(value);
}

/** Only authenticated project members generate events. Never capture HTTP bodies or headers. */
export async function initDiagnosticSchema(pool:Pool){
 await pool.query(
  "CREATE TABLE IF NOT EXISTS diagnostic_events ("+
  "id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,"+
  "actor_id uuid REFERENCES users(id) ON DELETE SET NULL,request_id text NOT NULL,"+
  "severity text NOT NULL,event_type text NOT NULL,payload jsonb NOT NULL DEFAULT '{}'::jsonb,"+
  "created_at timestamptz NOT NULL DEFAULT now());"+
  "CREATE INDEX IF NOT EXISTS idx_diagnostic_events_project ON diagnostic_events(project_id,created_at DESC);"
 );
 await pool.query("DELETE FROM diagnostic_events WHERE created_at < now()-interval '14 days'");
}

function projectInfo(request:any){
 const id=request.params?.id;
 const actor=request.userId;
 return uuid.safeParse(id).success&&uuid.safeParse(actor).success?{id:String(id),actor:String(actor)}:null;
}
async function writeEvent(pool:Pool,request:any,severity:string,eventType:string,payload:unknown){
 const info=projectInfo(request);
 if(!info)return;
 try{
  await pool.query(
   "INSERT INTO diagnostic_events(id,project_id,actor_id,request_id,severity,event_type,payload) "+
   "SELECT $1,$2,$3,$4,$5,$6,$7::jsonb WHERE EXISTS ("+
   "SELECT 1 FROM memberships m JOIN projects p ON p.id=m.project_id "+
   "WHERE m.project_id=$2 AND m.user_id=$3 AND p.deleted_at IS NULL)",
   [randomUUID(),info.id,info.actor,String(request.id||''),severity,eventType,JSON.stringify(redactDiagnostic(payload))]
  );
 }catch(error){
  // Diagnostic failures must never break business operations or recursively log themselves.
  request.log?.warn({diagnosticWriteFailure:(error as Error).message},'Diagnostic event write failed');
 }
}

export function installDiagnosticHooks(app:FastifyInstance,pool:Pool){
 app.addHook('onRequest',async request=>{(request as any).diagnosticStart=Date.now();});
 app.addHook('onError',async(request,_reply,error)=>{
  (request as any).diagnosticException={
   name:error.name,message:error.message,stack:(error.stack||'').slice(0,6000)
  };
 });
 app.addHook('onSend',async(request,reply,payload)=>{
  if(reply.statusCode>=400&&typeof payload==='string'&&payload.length<9000){
   try{
    const body=JSON.parse(payload);
    if(body&&typeof body==='object'){
     (request as any).diagnosticResponseError={
      error:body.error||body.message||null,details:body.details||null
     };
    }
   }catch{ /* non-JSON response */ }
  }
  return payload;
 });
 app.addHook('onResponse',async(request,reply)=>{
  if(!request.url.startsWith('/api/projects/')||request.url.includes('/diagnostics/export'))return;
  const method=request.method.toUpperCase();
  const status=reply.statusCode;
  const duration=Date.now()-Number((request as any).diagnosticStart||Date.now());
  if(status<400&&method==='GET'&&duration<3000)return;
  await writeEvent(pool,request,status>=500?'error':status>=400?'warning':'info',
   'http_request',{
    method,route:request.routeOptions?.url||'unknown',status,duration_ms:duration,
    task_id:(request.params as any)?.taskId||null,process_id:(request.params as any)?.processId||null,
    exception:(request as any).diagnosticException||null,
    response_error:(request as any).diagnosticResponseError||null
   });
 });
}

type DiagnosticDeps={
 pool:Pool;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
};

export function registerDiagnosticRoutes(app:FastifyInstance,{pool,access}:DiagnosticDeps){
 app.get('/api/projects/:id/diagnostics/export',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const {hours,includeMessages}=z.object({
   hours:z.coerce.number().int().min(1).max(168).default(24),
   includeMessages:z.enum(['true','false']).default('false').transform(value=>value==='true')
  }).parse(req.query||{});

  // Capped, project-scoped queries; return oldest-to-newest for timeline reconstruction.
  const since="created_at >= now()-($2::int * interval '1 hour')";
  const rows=async(sql:string)=>(
   await pool.query(sql,[id,hours])
  ).rows.reverse().map(row=>redactDiagnostic(row));

  const body=includeMessages?'LEFT(body,12000) AS body':'NULL::text AS body';
  const summary=includeMessages?'LEFT(summary,12000) AS summary':'NULL::text AS summary';
  const detail=includeMessages?'LEFT(detail,12000) AS detail':'NULL::text AS detail';

  const [
   httpEvents,processEvents,developmentRuns,testingRuns,analysisRuns,requirementRuns,
   managerOrders,managerEvents,projectMessages,taskMessages,topics,taskEvents,
   peerQueue,pmDecisions
  ]=await Promise.all([
   rows("SELECT request_id,severity,event_type,payload,created_at FROM diagnostic_events WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 1200"),
   rows("SELECT process_id,task_id,process_kind,level,stage,detail,created_at FROM process_events WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 2000"),
   rows("SELECT r.id,r.task_id,t.display_number,r.status,r.model,r.message,r.branch,r.pr_url,r.cycle_id,r.runner_spec_version,r.created_at,r.completed_at FROM ai_task_runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 AND r.created_at >= now()-($2::int * interval '1 hour') ORDER BY r.created_at DESC LIMIT 400"),
   rows("SELECT id,task_id,status,message,verdict,report,attempt,created_at,completed_at FROM ai_test_runs WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 400"),
   rows("SELECT id,task_id,status,message,created_at,updated_at FROM agent_analysis_runs WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 400"),
   rows("SELECT id,task_id,status,message,created_at,completed_at FROM requirement_review_runs WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 400"),
   rows("SELECT id,status,topic_id,source_message_id,"+summary+",created_at,updated_at FROM project_pm_orders WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 400"),
   rows("SELECT e.id,e.order_id,e.kind,"+detail+",e.process_id,e.created_at FROM project_pm_order_events e JOIN project_pm_orders o ON o.id=e.order_id WHERE o.project_id=$1 AND e.created_at >= now()-($2::int * interval '1 hour') ORDER BY e.created_at DESC LIMIT 800"),
   rows("SELECT id,task_id,role,channel,status,reply_to,topic_id,pm_order_id,"+body+",created_at FROM assistant_messages WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 1200"),
   rows("SELECT id,task_id,role,status,reply_to,"+body+",created_at FROM manager_messages WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 1200"),
   rows("SELECT id,status,"+(includeMessages?'LEFT(title,500) AS title':'NULL::text AS title')+",created_at,closed_at FROM project_chat_topics WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 400"),
   rows("SELECT e.id,e.task_id,e.event,"+detail+",e.created_at FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.project_id=$1 AND e.created_at >= now()-($2::int * interval '1 hour') ORDER BY e.created_at DESC LIMIT 1200"),
   rows("SELECT note_id,task_id,role,status,error,updated_at FROM agent_peer_queue WHERE project_id=$1 AND updated_at >= now()-($2::int * interval '1 hour') ORDER BY updated_at DESC LIMIT 400"),
   rows("SELECT id,order_id,source_message_id,iteration_id,"+(includeMessages?'question,answer':'NULL::text AS question,NULL::text AS answer')+",created_at FROM project_pm_decisions WHERE project_id=$1 AND "+since+" ORDER BY created_at DESC LIMIT 400")
  ]);
  const project=(await pool.query("SELECT name FROM projects WHERE id=$1",[id])).rows[0];
  const sections={
   http_events:httpEvents,process_events:processEvents,development_runs:developmentRuns,
   testing_runs:testingRuns,analysis_runs:analysisRuns,requirement_review_runs:requirementRuns,
   pm_orders:managerOrders,pm_order_events:managerEvents,project_chat_messages:projectMessages,
   task_chat_messages:taskMessages,pm_topics:topics,task_events:taskEvents,
   agent_peer_queue:peerQueue,pm_decisions:pmDecisions
  };
  reply.header('Cache-Control','no-store');
  reply.header('X-Content-Type-Options','nosniff');
  return {
   format:'ai-development-orchestrator-diagnostics',version:1,
   generated_at:new Date().toISOString(),project:{id,name:project?.name||''},
   window_hours:hours,include_messages:includeMessages,
   notes:[
    'Only application/database events are included; raw Docker and Codex Runner stdout/stderr are not included.',
    'Each category is bounded. If a category reaches its limit, older entries may be omitted.',
    'Sensitive values are redacted on a best-effort basis; review the file before sharing.'
   ],
   counts:Object.fromEntries(Object.entries(sections).map(([key,items])=>[key,items.length])),
   sections
  };
 });
}

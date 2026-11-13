import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {redactDiagnostic} from '../../../diagnostics.js';

type Db=Pick<Pool,'query'>;
type Level='info'|'warning'|'error';
type Stage='dispatch_queued'|'dispatch_deferred'|'turn_started'|'runner_request'|'runner_response'|'turn_completed'|'retry_scheduled'|'turn_failed';

export function classifyPmFailure(error:unknown):{category:string;message:string;causeCode:string|null}{
 const err=error instanceof Error?error:new Error(String(error));
 const details=err as Error & {code?:unknown;statusCode?:unknown;cause?:unknown};
 const cause=details.cause&&typeof details.cause==='object'?details.cause as {code?:unknown;message?:unknown}:null;
 const rawCode=typeof cause?.code==='string'?cause.code:typeof details.code==='string'?details.code:null;
 const causeCode=['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT'].includes(rawCode||'')?rawCode:null;
 const text=String(err.message||'Unknown PM failure');
 const category=typeof details.statusCode==='number'?'http_'+details.statusCode
  :causeCode==='ECONNREFUSED'?'runner_refused'
  :causeCode==='ENOTFOUND'||causeCode==='EAI_AGAIN'?'runner_dns'
  :causeCode==='ECONNRESET'?'connection_reset'
  :/AbortError|timeout|timed out|истекло время|превышено время/i.test(text)?'timeout'
  :/\b429\b|исполнитель.*занят|очередь.*заполнена|несколько AI/i.test(text)?'capacity'
  :/\b503\b|service unavailable/i.test(text)?'unavailable'
  :/fetch failed/i.test(text)?'network'
  :'other';
 // Never persist arbitrary Runner messages: they can contain owner text or prompts.
 const safe=redactDiagnostic(category) as string;
 return {category,message:safe.slice(0,350),causeCode};
}

export async function recordPmInboxDiagnostic(db:Db,args:{
 projectId:string;messageId:string;orderId?:string|null;attempt?:number;stage:Stage;
 level?:Level;error?:unknown;elapsedMs?:number;statusCode?:number;sessionId?:string|null;
}):Promise<void>{
 const failure=args.error===undefined?null:classifyPmFailure(args.error);
 const detail=JSON.stringify({
  message_id:args.messageId,
  order_id:args.orderId??null,
  attempt:args.attempt??null,
  session_id:args.sessionId??null,
  elapsed_ms:args.elapsedMs??null,
  status_code:args.statusCode??null,
  category:failure?.category??null,
  error:failure?.message??null,
  cause_code:failure?.causeCode??null
 });
 await db.query(
  "INSERT INTO process_events(id,project_id,process_id,process_kind,level,stage,detail) VALUES($1,$2,$3,'pm_inbox',$4,$5,$6)",
  [randomUUID(),args.projectId,args.orderId||args.messageId,args.level??'info',args.stage,detail]);
}

/** Generates one warning per stuck state per 10 minutes; never reads conversation bodies. */
export async function scanStalledPmInbox(db:Db):Promise<number>{
 const sql=[
 "WITH scan_lock AS (SELECT pg_try_advisory_xact_lock(5262658,5456718) AS acquired), overdue AS (",
 " SELECT m.project_id,COALESCE(m.pm_order_id,m.id) AS process_id,",
 "  CASE WHEN m.status='processing' THEN 'stalled_processing' ELSE 'stalled_queued' END AS stage,",
 "  json_build_object('message_id',m.id,'order_id',m.pm_order_id,'status',m.status,",
 "   'attempt',m.pm_dispatch_attempt,'dispatched_at',m.pm_dispatched_at,",
 "   'next_dispatch_at',m.pm_next_dispatch_at,",
 "   'age_seconds',EXTRACT(EPOCH FROM now()-m.created_at)::int)::text AS detail",
 " FROM assistant_messages m JOIN projects p ON p.id=m.project_id AND p.deleted_at IS NULL",
 " WHERE m.role='user' AND m.channel IN ('project','pm-internal') AND",
 "  ((m.status='queued' AND m.created_at<now()-interval '2 minutes'",
 "    AND m.pm_next_dispatch_at<now()-interval '2 minutes')",
 "   OR (m.status='processing'",
 "    AND COALESCE(m.pm_dispatched_at,m.created_at)<now()-interval '7 minutes'))",
 " UNION ALL",
 " SELECT o.project_id,o.id AS process_id,'stalled_waiting_agents' AS stage,",
 "  json_build_object('order_id',o.id,'status',o.status,",
 "   'age_seconds',EXTRACT(EPOCH FROM now()-o.updated_at)::int)::text AS detail",
 " FROM project_pm_orders o JOIN projects p ON p.id=o.project_id AND p.deleted_at IS NULL",
 " WHERE o.status='waiting_agents' AND o.updated_at<now()-interval '40 minutes'",
 ")",
 "INSERT INTO process_events(id,project_id,process_id,process_kind,level,stage,detail)",
 "SELECT gen_random_uuid(),s.project_id,s.process_id,'pm_inbox','warning',s.stage,s.detail",
 "FROM overdue s CROSS JOIN scan_lock l",
 "WHERE l.acquired AND NOT EXISTS(",
 " SELECT 1 FROM process_events e WHERE e.project_id=s.project_id",
 "  AND e.process_id=s.process_id AND e.stage=s.stage",
 "  AND e.created_at>now()-interval '10 minutes')",
 "ORDER BY s.process_id LIMIT 30",
 "RETURNING id"
 ].join('\n');
 const rows=await db.query<{id:string}>(sql);
 return rows.rowCount??rows.rows.length;
}

import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {redactDiagnostic} from './diagnostics.js';

const sources=['http','process','development','testing','analysis','pm','pm_chat','task_chat','pm_events'] as const;
type Source=typeof sources[number];
const sourceSql:Record<Source,string>={
 http:"SELECT d.id,d.project_id,p.name AS project_name,d.created_at AS event_at,d.severity AS level,d.request_id,d.event_type,d.payload FROM diagnostic_events d JOIN projects p ON p.id=d.project_id WHERE p.deleted_at IS NULL AND (d.created_at,d.id)>($1::timestamptz,$2::uuid) ORDER BY d.created_at,d.id LIMIT $3",
 process:"SELECT e.id,e.project_id,p.name AS project_name,e.created_at AS event_at,e.level,e.process_id,e.task_id,e.process_kind,e.stage,e.detail FROM process_events e JOIN projects p ON p.id=e.project_id WHERE p.deleted_at IS NULL AND (e.created_at,e.id)>($1::timestamptz,$2::uuid) ORDER BY e.created_at,e.id LIMIT $3",
 development:"SELECT r.id,r.project_id,p.name AS project_name,coalesce(r.completed_at,r.created_at) AS event_at,CASE WHEN r.status='failed' THEN 'error' ELSE 'info' END AS level,r.task_id,r.status,r.message,r.pr_url,r.branch FROM ai_task_runs r JOIN projects p ON p.id=r.project_id WHERE p.deleted_at IS NULL AND (coalesce(r.completed_at,r.created_at),r.id)>($1::timestamptz,$2::uuid) ORDER BY event_at,r.id LIMIT $3",
 testing:"SELECT r.id,r.project_id,p.name AS project_name,coalesce(r.completed_at,r.created_at) AS event_at,CASE WHEN r.status='failed' OR r.verdict IN ('failed','blocked') THEN 'error' ELSE 'info' END AS level,r.task_id,r.status,r.verdict,r.message,r.report FROM ai_test_runs r JOIN projects p ON p.id=r.project_id WHERE p.deleted_at IS NULL AND (coalesce(r.completed_at,r.created_at),r.id)>($1::timestamptz,$2::uuid) ORDER BY event_at,r.id LIMIT $3",
 analysis:"SELECT r.id,r.project_id,p.name AS project_name,r.created_at AS event_at,CASE WHEN r.status='failed' THEN 'error' ELSE 'info' END AS level,r.task_id,r.status,r.message FROM agent_analysis_runs r JOIN projects p ON p.id=r.project_id WHERE p.deleted_at IS NULL AND (r.created_at,r.id)>($1::timestamptz,$2::uuid) ORDER BY r.created_at,r.id LIMIT $3",
 pm:"SELECT o.id,o.project_id,p.name AS project_name,o.updated_at AS event_at,CASE WHEN o.status='failed' THEN 'error' ELSE 'info' END AS level,o.status,o.summary,o.topic_id FROM project_pm_orders o JOIN projects p ON p.id=o.project_id WHERE p.deleted_at IS NULL AND (o.updated_at,o.id)>($1::timestamptz,$2::uuid) ORDER BY o.updated_at,o.id LIMIT $3",
 pm_chat:"SELECT m.id,m.project_id,p.name AS project_name,m.created_at AS event_at,'info'::text AS level,m.role,m.status,m.topic_id,m.pm_order_id,left(m.body,6000) AS body FROM assistant_messages m JOIN projects p ON p.id=m.project_id WHERE p.deleted_at IS NULL AND m.task_id IS NULL AND m.channel='project' AND (m.created_at,m.id)>($1::timestamptz,$2::uuid) ORDER BY m.created_at,m.id LIMIT $3",
 task_chat:"SELECT m.id,m.project_id,p.name AS project_name,m.created_at AS event_at,'info'::text AS level,m.role,m.status,m.task_id,left(m.body,6000) AS body FROM manager_messages m JOIN projects p ON p.id=m.project_id WHERE p.deleted_at IS NULL AND (m.created_at,m.id)>($1::timestamptz,$2::uuid) ORDER BY m.created_at,m.id LIMIT $3",
 pm_events:"SELECT e.id,o.project_id,p.name AS project_name,e.created_at AS event_at,'info'::text AS level,e.order_id,e.kind,e.process_id,left(e.detail,6000) AS detail FROM project_pm_order_events e JOIN project_pm_orders o ON o.id=e.order_id JOIN projects p ON p.id=o.project_id WHERE p.deleted_at IS NULL AND (e.created_at,e.id)>($1::timestamptz,$2::uuid) ORDER BY e.created_at,e.id LIMIT $3"
};

export async function initCloudDiagnosticsSchema(pool:Pool){
 await pool.query("CREATE TABLE IF NOT EXISTS service_diagnostics_settings(id int PRIMARY KEY CHECK(id=1),development_mode boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO service_diagnostics_settings(id) VALUES(1) ON CONFLICT DO NOTHING; CREATE TABLE IF NOT EXISTS diagnostic_cloud_cursors(source text PRIMARY KEY,last_at timestamptz NOT NULL,last_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());");
}
export async function developmentModeEnabled(pool:Pool){
 const row=await pool.query<{development_mode:boolean}>('SELECT development_mode FROM service_diagnostics_settings WHERE id=1');
 return row.rows[0]?.development_mode??true;
}
export async function setDevelopmentMode(pool:Pool,enabled:boolean){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const row=await client.query<{development_mode:boolean}>('SELECT development_mode FROM service_diagnostics_settings WHERE id=1 FOR UPDATE');
  if((row.rows[0]?.development_mode??true)!==enabled){
   // Skip logs produced while disabled; turning mode on never backfills them.
   for(const source of sources){
    await client.query("INSERT INTO diagnostic_cloud_cursors(source,last_at,last_id,updated_at) VALUES($1,clock_timestamp(),'ffffffff-ffff-ffff-ffff-ffffffffffff',now()) ON CONFLICT(source) DO UPDATE SET last_at=EXCLUDED.last_at,last_id=EXCLUDED.last_id,updated_at=now()",[source]);
   }
  }
  await client.query('UPDATE service_diagnostics_settings SET development_mode=$1,updated_at=now() WHERE id=1',[enabled]);
  await client.query('COMMIT');
  return {development_mode:enabled};
 }catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();}
}
export function registerCloudDiagnosticsSettings(app:FastifyInstance,{pool,requireAdmin}:{
 pool:Pool;requireAdmin:(req:any,reply:any)=>Promise<boolean>
}){
 app.get('/api/diagnostics/settings',async(req,reply)=>{
  if(!await requireAdmin(req,reply))return;
  return {development_mode:await developmentModeEnabled(pool)};
 });
 app.put('/api/diagnostics/settings',async(req,reply)=>{
  if(!await requireAdmin(req,reply))return;
  const {development_mode}=z.object({development_mode:z.boolean()}).strict().parse(req.body);
  return setDevelopmentMode(pool,development_mode);
 });
}
function cloudRow(source:Source,row:Record<string,any>){
 const {id,project_id,project_name,event_at,level,...details}=row;
 const cleaned=redactDiagnostic(details) as Record<string,unknown>;
 const serialized=JSON.stringify(cleaned);
 return {
  event_key:source+':'+String(id),
  project_id,
  project_name:String(project_name).slice(0,200),
  kind:source,
  level:level==='error'||level==='warning'?level:'info',
  occurred_at:event_at instanceof Date?event_at.toISOString():String(event_at),
  payload:serialized.length<=10000?cleaned:{truncated:true,preview:serialized.slice(0,9000)}
 };
}
export async function sendCloudBatch(rows:Record<string,unknown>[],url:string,apiKey:string,fetchFn:typeof fetch=fetch){
 const endpoint=url.replace(/\/+$/,'')+'/rest/v1/ado_diagnostic_events?on_conflict=event_key';
 const response=await fetchFn(endpoint,{
  method:'POST',
  headers:{apikey:apiKey,'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=minimal'},
  body:JSON.stringify(rows),signal:AbortSignal.timeout(12000)
 });
 if(!response.ok)throw Error('Cloud diagnostics HTTP '+response.status+': '+(await response.text()).slice(0,250));
}
export async function syncCloudDiagnosticsOnce(pool:Pool,opts:{url:string;apiKey:string;fetchFn?:typeof fetch}):Promise<number>{
 if(!opts.url||!opts.apiKey||!await developmentModeEnabled(pool))return 0;
 let sent=0;
 for(const source of sources){
  if(!await developmentModeEnabled(pool))break;
  const res=await pool.query<{last_at:Date;last_id:string}>('SELECT last_at,last_id FROM diagnostic_cloud_cursors WHERE source=$1',[source]);
  const cursor=res.rows[0]||{last_at:new Date(Date.now()-24*3600*1000),last_id:'00000000-0000-0000-0000-000000000000'};
  const data=await pool.query(sourceSql[source],[cursor.last_at,cursor.last_id,80]);
  // A concurrent toggle must prevent pending batches from being transmitted.
  if(!await developmentModeEnabled(pool))break;
  if(data.rows.length){
   const batch=data.rows.filter(row=>Date.parse(String(row.event_at))>=Date.now()-14*86400000).map(row=>cloudRow(source,row));
   if(batch.length){await sendCloudBatch(batch,opts.url,opts.apiKey,opts.fetchFn);sent+=batch.length;}
   const last=data.rows[data.rows.length-1];
   // Cursor compare-and-swap prevents overwriting a reset caused by a mode change.
   await pool.query("INSERT INTO diagnostic_cloud_cursors(source,last_at,last_id) VALUES($1,$2,$3) ON CONFLICT(source) DO UPDATE SET last_at=EXCLUDED.last_at,last_id=EXCLUDED.last_id,updated_at=now() WHERE diagnostic_cloud_cursors.last_at=$4 AND diagnostic_cloud_cursors.last_id=$5",
    [source,last.event_at,last.id,cursor.last_at,cursor.last_id]);
  }
 }
 return sent;
}
export function startCloudDiagnosticsSender(pool:Pool,opts:{url:string;apiKey:string;logger?:(message:string)=>void}){
 if(!opts.url||!opts.apiKey)return {enabled:false,stop:()=>{}};
 let busy=false,stopped=false;
 const tick=async()=>{
  if(stopped||busy)return;busy=true;
  try{await syncCloudDiagnosticsOnce(pool,opts);}
  catch(error){opts.logger?.('Cloud diagnostics sync failed: '+(error instanceof Error?error.message:String(error)));}
  finally{busy=false;}
 };
 void tick();
 const timer=setInterval(()=>{void tick();},30000);timer.unref();
 return {enabled:true,stop:()=>{stopped=true;clearInterval(timer);}};
}

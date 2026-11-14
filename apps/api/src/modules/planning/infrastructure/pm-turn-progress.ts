import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';

type Db=Pick<Pool,'query'>;
const uuid=z.string().uuid();
export type PmProgressEvent={
 id:string;message_id:string;attempt:number;kind:'status'|'summary'|'plan'|'tool'|'message';text:string;created_at:string;
};
const progressKinds=z.enum(['status','summary','plan','tool','message']);
const eventSchema=z.object({
 projectId:uuid,messageId:uuid,attempt:z.number().int().min(1).max(100),
 sequence:z.number().int().min(1).max(300),
 kind:progressKinds,text:z.string().trim().min(1).max(320)
}).strict();

export async function initPmTurnProgress(db:Db){
 await db.query(`CREATE TABLE IF NOT EXISTS pm_turn_progress (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL,
  message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  sequence integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('status','summary','plan','tool','message')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 320),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(message_id,attempt,sequence)
 );
 CREATE INDEX IF NOT EXISTS idx_pm_turn_progress_project_cursor ON pm_turn_progress(project_id,id);
 `);
}
/** A worker may only append sanitized, monotonically numbered UI events to
 * its own currently processing PM turn. Old retries cannot overwrite new ones.
 */
export async function appendPmTurnProgress(db:Db,request:unknown){
 const value=eventSchema.parse(request);
 const res=await db.query(`INSERT INTO pm_turn_progress(project_id,message_id,attempt,sequence,kind,text)
  SELECT m.project_id,m.id,$3,$4,$5,$6
  FROM assistant_messages m
  WHERE m.id=$1 AND m.project_id=$2 AND m.role='user'
   AND m.channel='project' AND m.status='processing'
   AND m.pm_dispatch_attempt=$3
  ON CONFLICT (message_id,attempt,sequence) DO NOTHING RETURNING id`,
  [value.messageId,value.projectId,value.attempt,value.sequence,value.kind,value.text]);
 return {accepted:!!res.rowCount};
}
export async function readPmTurnProgress(db:Db,projectId:string,after:number,limit=100){
 const result=await db.query<PmProgressEvent>(`SELECT id::text,message_id,attempt,kind,text,created_at
  FROM pm_turn_progress WHERE project_id=$1 AND id>$2
  ORDER BY id LIMIT $3`,[projectId,after,limit]);
 return result.rows;
}
function cursor(value:unknown){
 const parsed=Number(value??0);
 return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
}
function validRunnerSecret(provided:unknown,expected:string){
 const supplied=Buffer.from(typeof provided==='string'?provided:'');
 const secret=Buffer.from(expected);
 return secret.length>=32&&supplied.length===secret.length&&timingSafeEqual(supplied,secret);
}
export function registerPmProgressRoutes(app:FastifyInstance,options:{
 pool:Pool;runnerSecret:string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
}){
 const {pool,runnerSecret,access,requireAdmin}=options;
 app.post('/internal/pm-turn-progress',async(req:any,reply)=>{
  if(!validRunnerSecret(req.headers['x-runner-secret'],runnerSecret))
   return reply.code(403).send({error:'Недостаточно прав для записи событий ПМ'});
  const parsed=eventSchema.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'Некорректное событие ПМ'});
  const result=await appendPmTurnProgress(pool,parsed.data);
  return reply.code(result.accepted?201:202).send(result);
 });
 app.get('/api/projects/:id/manager/inbox/progress',async(req:any,reply)=>{
  const params=z.object({id:uuid}).safeParse(req.params);
  if(!params.success)return reply.code(400).send({error:'Некорректный проект'});
  if(!await access(req,reply,params.data.id)||!await requireAdmin(req,reply))return;
  const from=cursor(req.headers['last-event-id']??req.query?.after);
  if(from===null)return reply.code(400).send({error:'Некорректная позиция журнала'});
  if(!String(req.headers.accept||'').includes('text/event-stream'))
   return {events:await readPmTurnProgress(pool,params.data.id,from,150)};
  reply.hijack();
  const raw=reply.raw;
  raw.writeHead(200,{
   'Content-Type':'text/event-stream; charset=utf-8',
   'Cache-Control':'private, no-cache, no-transform',
   'Connection':'keep-alive','X-Accel-Buffering':'no',
   'X-Content-Type-Options':'nosniff'
  });
  raw.write(': connected\n\n');
  let since=from,busy=false,closed=false;
  const send=async()=>{
   if(closed||busy)return;
   busy=true;
   try{
    const rows=await readPmTurnProgress(pool,params.data.id,since,100);
    for(const row of rows){
     if(closed)break;
     since=Number(row.id);
     if(!raw.write('id: '+row.id+'\nevent: progress\ndata: '+JSON.stringify(row)+'\n\n')){
      closed=true;raw.end();break;
     }
    }
   }catch(error){
    app.log.warn({error,projectId:params.data.id},'PM progress stream read failed');
    closed=true;raw.end();
   }finally{busy=false;}
  };
  const pump=setInterval(()=>{void send();},350);
  const pulse=setInterval(()=>{if(!closed)raw.write(': ping\n\n');},15000);
  pump.unref?.();pulse.unref?.();
  const release=()=>{closed=true;clearInterval(pump);clearInterval(pulse);};
  raw.on('close',release);
  req.raw.on('aborted',release);
  void send();
 });
}

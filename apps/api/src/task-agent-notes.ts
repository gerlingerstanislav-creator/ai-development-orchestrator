import {PENDING_OWNER_QUESTION_SQL} from './task-question-gates.js';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

/** Operational notes are not approved requirements or permanent documentation. */
export async function initTaskAgentNotesSchema(pool:Pool){
 await pool.query([
  "CREATE TABLE IF NOT EXISTS task_agent_notes (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,author_stage text NOT NULL,author_name text NOT NULL,target_stage text NOT NULL DEFAULT 'all',kind text NOT NULL DEFAULT 'handoff',body text NOT NULL,source_kind text NOT NULL DEFAULT 'agent',source_key text NOT NULL,source_run_id uuid,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,source_key),CHECK(length(body)>0),CHECK(length(body)<=3000))",
  "CREATE INDEX IF NOT EXISTS idx_task_agent_notes_scope ON task_agent_notes(project_id,task_id,created_at DESC)",
  "ALTER TABLE task_agent_notes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'resolved'",
  "ALTER TABLE task_agent_notes ADD COLUMN IF NOT EXISTS answer text",
  "ALTER TABLE task_agent_notes ADD COLUMN IF NOT EXISTS answered_at timestamptz",
  "ALTER TABLE task_agent_notes ADD COLUMN IF NOT EXISTS answered_by uuid REFERENCES users(id) ON DELETE SET NULL",
  "ALTER TABLE task_agent_notes ADD COLUMN IF NOT EXISTS answer_author text",
  "ALTER TABLE task_agent_notes ADD COLUMN IF NOT EXISTS processing_at timestamptz",
  "ALTER TABLE task_agent_notes ADD COLUMN IF NOT EXISTS requires_customer boolean NOT NULL DEFAULT false"
 ].join(';\n')+';');
}
export type AgentNoteInput={
 projectId:string;taskId:string;authorStage:string;authorName:string;targetStage:string;
 body:string;sourceKey:string;sourceRunId?:string|null;actorId?:string|null;
 kind?:'handoff'|'observation'|'question'|'risk'|'resolution';sourceKind?:'agent'|'human'
};
export async function recordTaskAgentNote(pool:Pool,note:AgentNoteInput){
 const body=note.body.trim().slice(0,3000);
 if(!body||/^(none|нет|отсутствуют|нет замечаний)[.!]?$/i.test(body))return false;
 const result=await pool.query(
  "INSERT INTO task_agent_notes (id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,source_run_id,actor_id,status) SELECT $1,t.project_id,t.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $6='question' THEN 'open' ELSE 'resolved' END FROM tasks t WHERE t.id=$2 AND t.project_id=$12 ON CONFLICT(task_id,source_key) DO NOTHING",
  [randomUUID(),note.taskId,note.authorStage.slice(0,100),note.authorName.slice(0,140),note.targetStage.slice(0,100),
   note.kind||'handoff',body,note.sourceKind||'agent',note.sourceKey.slice(0,250),note.sourceRunId||null,note.actorId||null,note.projectId]
 );
 return (result.rowCount||0)>0;
}

export async function pendingAgentQuestions(pool:Pick<Pool,'query'>,projectId:string,taskId:string):Promise<number>{
 const r=await pool.query(`SELECT count(*)::int AS count FROM task_agent_notes n WHERE n.project_id=$1 AND n.task_id=$2 AND ${PENDING_OWNER_QUESTION_SQL}`,[projectId,taskId]);
 return r.rows[0].count;
}

/** Only messages from this task. Recent user replies are evidence, not instructions. */
export async function taskConversationEvidence(pool:Pick<Pool,'query'>,projectId:string,taskId:string){
 const result=await pool.query(`
  SELECT body FROM (
   (SELECT id,created_at,body FROM manager_messages
    WHERE project_id=$1 AND task_id=$2 AND role='user' AND status IN ('queued','processing','completed')
    ORDER BY created_at DESC,id DESC LIMIT 16)
   UNION ALL
   (SELECT id,created_at,body FROM assistant_messages
    WHERE project_id=$1 AND task_id=$2 AND role='user'
    ORDER BY created_at DESC,id DESC LIMIT 16)
  ) replies ORDER BY created_at DESC,id DESC LIMIT 16
 `,[projectId,taskId]);
 return [...new Set<string>(result.rows.map(row=>String(row.body).slice(0,1000)))].reverse().join('\n\n').slice(-5500);
}
/**
 * Accepting a question answer is not equivalent to approving changed behavior.
 * Only an inconclusive analytical review can be superseded automatically.
 * A material-change proposal must still receive an explicit human decision.
 */
export async function resolveAgentQuestionsForReview(client:PoolClient,projectId:string,taskId:string,version:number){
 const open=await client.query(`SELECT count(*)::int AS total FROM task_agent_notes n WHERE n.project_id=$1 AND n.task_id=$2 AND ${PENDING_OWNER_QUESTION_SQL}`,[projectId,taskId]);
 const remaining=Number(open.rows[0].total);
 if(remaining)return {remaining,requiresApproval:false};
 const review=await client.query("SELECT classification FROM task_requirement_reviews WHERE project_id=$1 AND task_id=$2 AND spec_version=$3 AND status='needs_approval' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[projectId,taskId,version]);
 if(review.rows[0]?.classification==='material_change')return {remaining:0,requiresApproval:true};
 if(review.rows[0]?.classification==='uncertain'){
  await client.query("UPDATE task_requirement_reviews SET status='superseded',resolved_at=now() WHERE project_id=$1 AND task_id=$2 AND spec_version=$3 AND status='needs_approval' AND classification='uncertain'",[projectId,taskId,version]);
 }
 return {remaining:0,requiresApproval:false};
}
/** Return bounded, addressed task comments as untrusted advisory context. */
export async function taskNotesContext(pool:Pool,projectId:string,taskId:string,targetStage:string|null,limit=18){
 const results=await pool.query(
  "SELECT author_stage,author_name,target_stage,kind,body,answer,status,created_at FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND ($3::text IS NULL OR target_stage=$3 OR target_stage='all' OR (author_stage=$3 AND status='answered')) ORDER BY created_at DESC,id DESC LIMIT $4",
  [projectId,taskId,targetStage,Math.min(30,Math.max(1,limit))]
 );
 return JSON.stringify(results.rows.reverse().map(r=>({author:r.author_name,stage:r.author_stage,kind:r.kind,target:r.target_stage,
  text:r.body,answer:r.answer,status:r.status,at:r.created_at}))).slice(0,8500);
}

export function registerTaskAgentNotesRoutes(app:FastifyInstance,deps:{
 pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;uid:(req:any)=>string;startRequirementsReview?:(projectId:string,taskId:string,version:number)=>Promise<unknown>;
 resumeAfterAnswer?:(input:{projectId:string;taskId:string;auth:string;cookie:string})=>Promise<{started:boolean;message:string}>
}){
 app.post('/api/projects/:id/tasks/:taskId/agent-notes',async(req:any,reply)=>{
  const {id,taskId}=z.object({id:z.string().uuid(),taskId:z.string().uuid()}).parse(req.params);
  if(!await deps.access(req,reply,id)||!await deps.requireAdmin(req,reply))return;
  const body=z.object({
   body:z.string().trim().min(3).max(3000),
   target_stage:z.enum(['all','analysis','development','testing','merge_queue','documentation']).default('all'),
   kind:z.enum(['handoff','observation','question','risk','resolution']).default('observation')
  }).parse(req.body);
  const task=await deps.pool.query('SELECT id FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
  if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  const actor=await deps.pool.query('SELECT email FROM users WHERE id=$1',[deps.uid(req)]);
  const inserted=await recordTaskAgentNote(deps.pool,{
   projectId:id,taskId,authorName:String(actor.rows[0]?.email||'Участник проекта'),authorStage:'human',targetStage:body.target_stage,
   body:body.body,kind:body.kind,sourceKind:'human',sourceKey:'human:'+randomUUID(),actorId:deps.uid(req)
  });
  return reply.code(201).send({ok:inserted});
 });
 app.post('/api/projects/:id/tasks/:taskId/agent-notes/:noteId/answer',async(req:any,reply)=>{
  const {id,taskId,noteId}=z.object({id:z.string().uuid(),taskId:z.string().uuid(),noteId:z.string().uuid()}).parse(req.params);
  if(!await deps.access(req,reply,id)||!await deps.requireAdmin(req,reply))return;
  const {answer}=z.object({answer:z.string().trim().min(3).max(3000)}).parse(req.body);
  const client=await deps.pool.connect();
  try{
   await client.query('BEGIN');
   const result=await client.query("UPDATE task_agent_notes SET status='answered',answer=$4,answered_at=now(),answered_by=$5 WHERE project_id=$1 AND task_id=$2 AND id=$3 AND kind='question' AND status='open' RETURNING id",
    [id,taskId,noteId,answer,deps.uid(req)]);
   if(!result.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'Вопрос уже закрыт или не относится к задаче'});}
   await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'agent_question_answered',$4)",
    [randomUUID(),taskId,deps.uid(req),'Ответ на вопрос агента: '+answer.slice(0,1600)]);
   const task=await client.query('SELECT stage,spec_version,spec_review_status,pr_url FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
   const state=task.rowCount
    ?await resolveAgentQuestionsForReview(client,id,taskId,task.rows[0].spec_version)
    :{remaining:0,requiresApproval:false};
   const unanswered=state.remaining;
   const mayReconcile=task.rowCount&&unanswered===0&&!state.requiresApproval&&task.rows[0].spec_review_status!=='rejected';
   if(mayReconcile){
    if(task.rows[0].stage==='analysis'){
     await client.query("UPDATE tasks SET analysis_state='new',updated_at=now() WHERE id=$1",[taskId]);
    }else if(!['backlog','documentation','done'].includes(task.rows[0].stage)){
     await client.query("UPDATE tasks SET spec_review_status='pending',spec_review_note='Получены ответы на вопросы; аналитик повторно сверяет ТЗ',updated_at=now() WHERE id=$1",[taskId]);
    }
   }
   await client.query('COMMIT');
   let review:unknown=null;
   if(mayReconcile&&!['backlog','analysis','documentation','done'].includes(task.rows[0].stage)){
    const current=task.rows[0];
    let resumed:{started:boolean;message:string}|undefined;
    if(current.stage==='testing'||current.stage==='development'&&current.pr_url){
     try{
      resumed=await deps.resumeAfterAnswer?.({projectId:id,taskId,auth:String(req.headers.authorization||''),cookie:String(req.headers.cookie||'')});
     }catch{/* The answer is committed. Fall back to a fresh requirements review. */}
    }
    review=resumed?.started?resumed:await deps.startRequirementsReview?.(id,taskId,current.spec_version)??resumed;
   }
   return {ok:true,pending_questions:unanswered,requires_approval:state.requiresApproval,requirements_review:review};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });

}

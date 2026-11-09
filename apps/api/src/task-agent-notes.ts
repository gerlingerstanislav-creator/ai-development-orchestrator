import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

/** Operational notes are not approved requirements or permanent documentation. */
export async function initTaskAgentNotesSchema(pool:Pool){
 await pool.query([
  "CREATE TABLE IF NOT EXISTS task_agent_notes (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,author_stage text NOT NULL,author_name text NOT NULL,target_stage text NOT NULL DEFAULT 'all',kind text NOT NULL DEFAULT 'handoff',body text NOT NULL,source_kind text NOT NULL DEFAULT 'agent',source_key text NOT NULL,source_run_id uuid,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,source_key),CHECK(length(body)>0),CHECK(length(body)<=3000))",
  "CREATE INDEX IF NOT EXISTS idx_task_agent_notes_scope ON task_agent_notes(project_id,task_id,created_at DESC)"
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
  "INSERT INTO task_agent_notes (id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,source_run_id,actor_id) SELECT $1,t.project_id,t.id,$3,$4,$5,$6,$7,$8,$9,$10,$11 FROM tasks t WHERE t.id=$2 AND t.project_id=$12 ON CONFLICT(task_id,source_key) DO NOTHING",
  [randomUUID(),note.taskId,note.authorStage.slice(0,100),note.authorName.slice(0,140),note.targetStage.slice(0,100),
   note.kind||'handoff',body,note.sourceKind||'agent',note.sourceKey.slice(0,250),note.sourceRunId||null,note.actorId||null,note.projectId]
 );
 return (result.rowCount||0)>0;
}

/** Return bounded, addressed task comments as untrusted advisory context. */
export async function taskNotesContext(pool:Pool,projectId:string,taskId:string,targetStage:string,limit=18){
 const results=await pool.query(
  "SELECT author_stage,author_name,target_stage,kind,body,created_at FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND (target_stage=$3 OR target_stage='all') ORDER BY created_at DESC,id DESC LIMIT $4",
  [projectId,taskId,targetStage,Math.min(30,Math.max(1,limit))]
 );
 return JSON.stringify(results.rows.reverse().map(r=>({author:r.author_name,stage:r.author_stage,kind:r.kind,target:r.target_stage,
  text:r.body,at:r.created_at}))).slice(0,8500);
}

export function registerTaskAgentNotesRoutes(app:FastifyInstance,deps:{
 pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;uid:(req:any)=>string
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
  const inserted=await recordTaskAgentNote(deps.pool,{
   projectId:id,taskId,authorName:'Участник проекта',authorStage:'human',targetStage:body.target_stage,
   body:body.body,kind:body.kind,sourceKind:'human',sourceKey:'human:'+randomUUID(),actorId:deps.uid(req)
  });
  return reply.code(201).send({ok:inserted});
 });
}

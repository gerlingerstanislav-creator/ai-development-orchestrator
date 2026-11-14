import type {Pool} from 'pg';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {agentMemoryContext} from './agent-memory.js';
import {normalizeTaskToolGrants} from './modules/agents/domain/tool-capabilities.js';
import {agentToolCatalog} from './modules/agents/domain/tool-catalog.js';
export {agentToolCatalog} from './modules/agents/domain/tool-catalog.js';

export const hashSecret=(text:string)=>createHash('sha256').update(text).digest('hex');
// Orders track successful mutations, not reads or routine agent telemetry.
// Catalog metadata keeps future tools classified without keyword heuristics.
const pmNonOrderTools=new Set(['pm.orders.update','processes.report','memory.record','instructions.propose','goals.link','goals.update','goals.complete']);
export function isProjectManagerOrderAction(name:string){
 const tool=agentToolCatalog.find(entry=>entry.name===name);
 return !!tool&&!tool.annotations.readOnlyHint&&!pmNonOrderTools.has(name);
}

export const readerRoles=['manager','analyst','business_analyst','analysis','development','testing','documentation','devops','architect'] as const;
export type AgentRole=typeof readerRoles[number];
export type AgentReaderScope={projectId:string;role:AgentRole;taskId?:string;processId?:string;actorId?:string};

const readerTools=new Set([
 'project.context','goals.list','goals.read','documents.search','documents.read','knowledge.search','knowledge.read','knowledge.sections','knowledge.section','knowledge.related','knowledge.context',
 'tasks.list','tasks.read','tasks.history','processes.list','blockers.list','project.source','work.list','work.artifacts','agents.capabilities','capabilities.list','capabilities.describe'
]);

const autonomousSpecialistRoles=new Set<AgentRole>(['analysis','development','testing','documentation','devops','architect']);
const specialistTools=new Set([...readerTools,'agents.consult','work.delegate','work.report','blockers.report','blockers.resolve','processes.report']);
const documentationTools=new Set([...readerTools,'work.delegate','work.report','documents.list','documents.create','documents.update','documents.delete','documents.changeset','documentation.complete','documentation.request_input']);
/** Business analysts own product knowledge, not the executable backlog. A handoff
 * requires an explicit authenticated user action outside the model tool catalog. */
const BA_DENIED=new Set(['documentation.complete','documentation.request_input','documentation.resume_spec','project.agents.start','tasks.delete','tasks.cancel','tasks.close','work.complete_task','tasks.request_owner_question_cleanup','questions.create','iterations.recommend_launch','iterations.launch','tasks.update_dependency','workflow.move_task']);
const PM_DENIED=new Set(['documentation.complete','documentation.request_input','documents.create','documents.update','documents.delete','documents.changeset','questions.create']);
const BA_DENIED_GOVERNANCE=new Set(['instructions.propose','instructions.reconcile']);
/** The MCP catalog is the authoritative schema; capability views are derived, never maintained separately. */
export function capabilitiesForRole(role:AgentRole,readOnly=false,category?:string,grants:readonly string[]=[]){
 return toolsForSession(role,readOnly,grants).filter(t=>!category||t.name.startsWith(category+'.')).map(t=>({
  name:t.name,category:t.name.split('.')[0],description:t.description,
  inputSchema:t.inputSchema,readOnly:t.annotations.readOnlyHint,
  effects:t.annotations.readOnlyHint?'read':'write',
  requiresConfirmation:['tasks.delete','tasks.cancel','tasks.close','workflow.approve_development','workflow.release_task','iterations.approve','iterations.launch'].includes(t.name)
 }));
}
export function toolsForRole(role:AgentRole,readOnly=false){
 if(readOnly)return agentToolCatalog.filter(tool=>readerTools.has(tool.name));
 if(role==='documentation')return agentToolCatalog.filter(tool=>documentationTools.has(tool.name));
 if(autonomousSpecialistRoles.has(role))
  return agentToolCatalog.filter(tool=>specialistTools.has(tool.name));
 return agentToolCatalog.filter(t=>role==='manager'?!PM_DENIED.has(t.name)&&t.name!=='documentation.request_reset':!BA_DENIED.has(t.name)&&!BA_DENIED_GOVERNANCE.has(t.name)&&!t.name.startsWith('discussions.')&&!t.name.startsWith('approvals.')&&!t.name.startsWith('workflow.')&&!t.name.startsWith('pm.')&&!t.name.startsWith('qa.'));
}
/** Effective tools, evaluated on every request from an active, task-bound assignment. */
export function toolsForSession(role:AgentRole,readOnly=false,grants:readonly string[]=[]){
 const baseline=toolsForRole(role,readOnly);
 if(readOnly||!grants.length)return baseline;
 const additional=new Set(normalizeTaskToolGrants(grants));
 return agentToolCatalog.filter(tool=>additional.has(tool.name)||baseline.includes(tool));
}
export async function readSessionToolGrants(pool:Pick<Pool,'query'>,session:AgentSession,lock=false):Promise<string[]>{
 if(session.read_only||!session.process_id||
    !autonomousSpecialistRoles.has(session.role))return [];
 // A session token alone is never sufficient: the assignment and its spec must
 // still be live in the same project and task, including after cancellation.
 let active;
 try{active=await pool.query(`SELECT a.granted_tools FROM agent_work_assignments a
  LEFT JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id AND t.spec_version=a.spec_version AND t.stage<>'done'
  LEFT JOIN project_pm_goals g ON g.id=a.goal_id AND g.project_id=a.project_id AND g.status<>'completed'
  JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL AND p.agents_running=true
  WHERE a.id=$1 AND a.project_id=$2 AND a.task_id IS NOT DISTINCT FROM $3::uuid AND a.role=$4
   AND a.status='running' AND (t.id IS NOT NULL OR g.id IS NOT NULL)
   LIMIT 1${lock?' FOR SHARE OF a':''}`,
  [session.process_id,session.project_id,session.task_id,session.role]);}
 catch(error){
  // Legacy isolated reader fixtures may not have run the v15 schema yet.
  // No table/column means no extra privileges; never infer a grant.
  if(['42P01','42703'].includes(String((error as {code?:string}).code||'')))return [];
  throw error;
 }
 return active.rowCount?normalizeTaskToolGrants(active.rows[0].granted_tools||[]):[];
}

export function toolAllowedForRole(role:AgentRole,name:string){
 return toolsForRole(role).some(t=>t.name===name);
}
export type AgentSession={id:string;project_id:string;actor_id:string;role:AgentRole;status:string;expires_at:Date;read_only?:boolean;task_id?:string|null;process_id?:string|null};

export async function initAgentToolsSchema(pool:Pick<Pool,'query'>){
 await pool.query([
 'CREATE TABLE IF NOT EXISTS agent_sessions(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,actor_id uuid NOT NULL REFERENCES users(id),role text NOT NULL,token_hash text NOT NULL UNIQUE,status text NOT NULL DEFAULT \'running\',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz)',
 'ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false',
 'ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id) ON DELETE CASCADE',
 'ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS process_id uuid',
 'CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id,created_at DESC)',
 'CREATE TABLE IF NOT EXISTS agent_tool_events(id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,tool text NOT NULL,arguments jsonb NOT NULL DEFAULT \'{}\'::jsonb,result jsonb,success boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),idempotency_key text)',
 'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_idempotency ON agent_tool_events(project_id,tool,idempotency_key) WHERE idempotency_key IS NOT NULL AND success',
 'CREATE INDEX IF NOT EXISTS idx_agent_tool_events_session ON agent_tool_events(session_id,created_at)',
 'CREATE TABLE IF NOT EXISTS agent_memory(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,role text NOT NULL,kind text NOT NULL,body text NOT NULL,evidence text NOT NULL DEFAULT \'\',status text NOT NULL DEFAULT \'recorded\',created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz)',
 'CREATE INDEX IF NOT EXISTS idx_agent_memory_project ON agent_memory(project_id,created_at DESC)',
 'CREATE TABLE IF NOT EXISTS agent_blockers(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,process_id uuid,role text NOT NULL,kind text NOT NULL CHECK(kind IN (\'requirements\',\'tool\',\'ci\',\'qa\',\'github\',\'dependency\',\'environment\',\'code\',\'other\')),summary text NOT NULL,evidence text NOT NULL,resolution_hint text NOT NULL DEFAULT \'\',status text NOT NULL DEFAULT \'open\' CHECK(status IN (\'open\',\'resolved\')),resolution_evidence text NOT NULL DEFAULT \'\',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())',
 'CREATE INDEX IF NOT EXISTS idx_agent_blockers_task ON agent_blockers(project_id,task_id,status,created_at DESC)'
 ].join(';\n')+';');
}
export async function createAgentSession(pool:Pick<Pool,'query'>,projectId:string,actorId:string,role:AgentRole,sourceMessageId?:string){
 const secret=randomBytes(32).toString('hex'),id=randomUUID();
 await pool.query("INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,expires_at,process_id) VALUES($1,$2,$3,$4,$5,now()+interval '40 minutes',$6)",
  [id,projectId,actorId,role,hashSecret(secret),sourceMessageId||null]);
 return {id,secret};
}
export async function createAgentReaderSession(pool:Pick<Pool,'query'>,scope:AgentReaderScope){
 const {projectId,role,taskId,processId,actorId}=scope;
 // Only documentation-write sessions need the documentation job table.
 // Task-only/reader tests and migrations may run without that table.
 const docJob=role==='documentation'&&!!processId;
 const docGuard=docJob?(taskId
  ?` AND EXISTS (SELECT 1 FROM agent_work_assignments a WHERE a.id=$4 AND a.project_id=p.id AND a.task_id=$3 AND a.role='documentation' AND a.status='running')`
  :` AND (EXISTS (SELECT 1 FROM document_import_jobs j WHERE j.id=$4 AND j.project_id=p.id AND j.actor_id=COALESCE($2::uuid,p.owner_id) AND j.status='running')
   OR EXISTS (SELECT 1 FROM agent_work_assignments a JOIN project_pm_goals g ON g.id=a.goal_id AND g.project_id=a.project_id
    WHERE a.id=$4 AND a.project_id=p.id AND a.task_id IS NULL AND a.role='documentation'
     AND a.status='running' AND g.status<>'completed'))`):'';
 const result=await pool.query(`SELECT COALESCE($2::uuid,p.owner_id) AS actor_id FROM projects p
  WHERE p.id=$1 AND p.deleted_at IS NULL
   AND ($2::uuid IS NULL OR p.owner_id=$2 OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=$2))
   AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.id=$3))`+docGuard,
 docJob?[projectId,actorId??null,taskId??null,processId]:[projectId,actorId??null,taskId??null]);
 if(!result.rowCount)return null;
 const secret=randomBytes(32).toString('hex'),id=randomUUID();
 await pool.query(`INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,expires_at,read_only,task_id,process_id)
  VALUES($1,$2,$3,$4,$5,now()+interval '130 minutes',$8,$6,$7)`,
 [id,projectId,result.rows[0].actor_id,role,hashSecret(secret),taskId??null,processId??null,role==='documentation'?!processId:!autonomousSpecialistRoles.has(role)||!processId]);
 return {id,secret};
}
export async function finishAgentSession(pool:Pick<Pool,'query'>,id:string){
 await pool.query("UPDATE agent_sessions SET status='completed',finished_at=now() WHERE id=$1 AND status='running'",[id]);
}
export async function readAgentSession(pool:Pick<Pool,'query'>,secret:string):Promise<AgentSession|null>{
 if(!/^[0-9a-f]{64}$/.test(secret))return null;
 const r=await pool.query("SELECT id,project_id,actor_id,role,status,expires_at,read_only,task_id,process_id FROM agent_sessions WHERE token_hash=$1 AND status='running' AND expires_at>now()",[hashSecret(secret)]);
 return r.rows[0]||null;
}
export async function agentSessionEffects(pool:Pick<Pool,'query'>,id:string){
 const rows=(await pool.query('SELECT tool,result,success,created_at FROM agent_tool_events WHERE session_id=$1 ORDER BY created_at,id',[id])).rows;
 const value=(name:string,key:string)=>rows.filter(r=>r.success&&r.tool===name).map(r=>r.result?.[key]).filter(Boolean).at(-1)||null;
 return {events:rows,created_document_id:value('documents.create','id'),created_task_id:value('tasks.create','id'),
  owner_question_cleanup_requested:value('tasks.request_owner_question_cleanup','requires_user_confirmation')===true,
  documentation_reset_requested:value('documentation.request_reset','requires_user_confirmation')===true,
  import_job_id:value('documentation.import','import_job_id')||value('documentation.rebuild','import_job_id')||value('documentation.organize','import_job_id')};
}
export async function agentLearnedContext(pool:Pick<Pool,'query'>,projectId:string,role:AgentRole){
 return agentMemoryContext(pool,projectId,role);
}

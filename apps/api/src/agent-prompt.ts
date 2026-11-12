import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {assembleAgentPrompt} from './prompt-assembler.mjs';

export type AgentPromptParts={
 role:string;
 objective:string;
 tools?:string;
 instructions?:string;
 scope?:string;
 context?:string;
 continuation?:string;
 output?:string;
 budget?:number;
};

/**
 * Only one owner per section. Caller fields are not new top-level system
 * policies: editable role instructions belong to identity; task text to
 * objective; previous messages and task notes are data, never authority.
 * Runner adds runtime facts and execution protocol to the SAME envelope,
 * instead of concatenating a second set of instructions.
 */
export function agentPromptZones(input:AgentPromptParts){
 const identity=[
  input.role.trim(),
  input.instructions?.trim()?'Профиль специалиста и дополнительные инструкции роли:\n'+input.instructions.trim():''
 ].filter(Boolean).join('\n');
 return {
  identity,
  objective:input.objective.trim(),
  scope:String(input.scope||'').slice(0,900),
  tools:String(input.tools||'').slice(0,800),
  protocol:String(input.continuation||'').slice(0,1200),
  output:[
   input.output?.trim()||'Предъяви доказательства достижения цели и оставшиеся блокеры.',
   'Если пишешь человеку: 1–3 понятных предложения. Если задан строгий машинный формат, соблюдай его; подробные доказательства помещай в отчёт.'
  ].join('\n'),
  context:String(input.context||'').slice(0,3500),
  budget:input.budget||24000
 };
}

/** Shared compiler for PM, analysts, development, QA, architect and DevOps. */
export function composeAgentPrompt(input:AgentPromptParts):string{
 return assembleAgentPrompt(agentPromptZones(input));
}

/** Logs are intentionally independent of any model call; logging failure must not block execution. */
export async function initAgentPromptAudit(pool:Pool){
 await pool.query("CREATE TABLE IF NOT EXISTS agent_prompt_audit ("+
  "id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,"+
  "process_id uuid NOT NULL,role text NOT NULL,operation text NOT NULL,"+
  "prompt text NOT NULL,original_chars integer NOT NULL,truncated boolean NOT NULL DEFAULT false,"+
  "created_at timestamptz NOT NULL DEFAULT now())");
 await pool.query('CREATE INDEX IF NOT EXISTS agent_prompt_audit_process ON agent_prompt_audit(project_id,process_id,created_at DESC)');
}

export function redactAgentPrompt(prompt:string):string{
 return prompt
  .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{12,}\b/g,'[REDACTED_GITHUB_TOKEN]')
  .replace(/\b(?:sk-|sb_secret_)[A-Za-z0-9_-]{16,}\b/g,'[REDACTED_KEY]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,'Bearer [REDACTED]')
  .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g,'$1[REDACTED]@')
  .replace(/((?:password|passwd|client_secret|access_token|refresh_token|api_key|session_token|runner_shared_secret)\s*["']?\s*[:=]\s*["']?)[^\s,"']{6,}/gi,'$1[REDACTED]');
}

export async function recordAgentPrompt(pool:Pool,args:{
 projectId:string;processId:string;role:string;operation:string;prompt:string;
}):Promise<void>{
 const safe=redactAgentPrompt(args.prompt);
 await pool.query('INSERT INTO agent_prompt_audit(id,project_id,process_id,role,operation,prompt,original_chars,truncated) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
  [randomUUID(),args.projectId,args.processId,args.role.slice(0,60),args.operation.slice(0,100),safe.slice(0,64000),args.prompt.length,safe.length>64000]);
}

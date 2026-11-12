import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';

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

const taskCommunication=[
 'Если оставляешь комментарий в карточке задачи или отвечаешь пользователю в чате, по умолчанию пиши простым языком и по делу. Обычно достаточно 1–3 предложений.',
 'Скажи, что произошло, как это влияет на задачу и нужен ли следующий шаг. Укажи важные ограничения, даже если ответ короткий.',
 'Когда пишешь человеку, используй компактный Markdown: отдельные абзацы по смыслу, короткие заголовки для нескольких тем, маркированные или нумерованные списки для перечислений. Не отправляй пользователю сырые JSON-объекты, UUID кейсов и служебные дампы. Не делай длинную простыню без абзацев.',
 'Если пользователь явно просит детали, раскрой именно их по доступным фактам: при необходимости назови проверки, причины, команды или ссылки. Полные результаты сохраняй в предназначенных для этого отчётах и полях, соблюдая схему ответа. Если вызов требует строгий JSON/схему для машины, JSON используй только там, не в человеческом сообщении.'
].join(' ');

/** One bounded context envelope for every AI role. Current work always wins over optional history. */
export function composeAgentPrompt(input:AgentPromptParts):string{
 const max=Math.min(24000,Math.max(4000,input.budget??24000));
 const part=(title:string,body:string|undefined,limit:number)=>body?.trim()
  ?title+':\n'+body.trim().slice(0,limit):'';
 const required=[
  part('Роль',input.role,1000),
  'Текущая задача:\n'+input.objective.trim(),
  part('Доступные инструменты',input.tools,1400),
  part('Общение с пользователем',taskCommunication,1400)
 ].filter(Boolean).join('\n\n');
 if(!input.objective.trim()||required.length>max)throw new Error('Текущая задача не помещается в контекст агента');
 let result=required;
 // Optional sections have independent caps. They can never displace the task.
 for(const section of [
  part('Обязательные инструкции роли',input.instructions,5500),
  part('Область работы',input.scope,1800),
  part('Текущее продолжение',input.continuation,1700),
  part('Ожидаемый результат',input.output,2600),
  part('Связанный контекст',input.context,3800)
 ]){
  if(!section)continue;
  const remaining=max-result.length-2;
  if(remaining<100)break;
  result+='\n\n'+section.slice(0,remaining);
 }
 return result;
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

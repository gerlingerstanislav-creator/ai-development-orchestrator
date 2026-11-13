/** Runner HTTP request contracts. Pure validation only: no secrets, I/O,
 * queue access, or Codex calls. These predicates are the authoritative schema
 * for /agent, /assistant and /jobs; retain current client-facing errors.
 */
const allowedModels=new Set(['gpt-6-luna','gpt-6-sol','gpt-6.1-sol']);
const allowedReasoning=new Set(['low','medium']);
// Git ref and repository components may include dots in names, but never as entire
// path segments: ../ and ./ can escape the intended GitHub repository/branch scope.
const hasTraversalSegments=value=>value.split('/').some(segment=>segment==='.'||segment==='..');

export function validAgentRequest(data){
 return typeof data.prompt==='string'&&data.prompt.length>=1&&data.prompt.length<=24000&&
  allowedModels.has(data.model)&&allowedReasoning.has(data.reasoning)&&
  typeof data.session_token==='string'&&/^[a-f0-9]{64}$/.test(data.session_token);
}

export function assistantRequestError(data){
 if(typeof data.prompt!=='string'||data.prompt.length<1||data.prompt.length>24000||
    !allowedModels.has(data.model)||!allowedReasoning.has(data.reasoning))
  return typeof data.prompt==='string'&&data.prompt.length>24000
   ?'AI-запрос слишком большой: '+data.prompt.length+' символов при лимите 24000'
   :'Некорректные параметры AI-запроса';
 return null;
}

export function runnerJobRequestError(job){
 if(job.kind&&!['resolve-conflict','test','review','ci'].includes(job.kind))
  return 'Недопустимый тип задания';
 if(typeof job.id!=='string'||! /^[a-f0-9-]{36}$/.test(job.id) ||
  typeof job.taskId!=='string'|| !/^[a-f0-9-]{36}$/.test(job.taskId) ||
  typeof job.repository!=='string'|| !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(job.repository)||hasTraversalSegments(job.repository) ||
  (['ci','review'].includes(job.kind)&&(!/^[a-f0-9]{40}$/i.test(job.expectedCommit)||job.baseCommit!==undefined&&!/^[a-f0-9]{40}$/i.test(job.baseCommit)))||
  (job.branch!==undefined&&(typeof job.branch!=='string'||!/^[a-zA-Z0-9_.\/-]+$/.test(job.branch)||job.branch.startsWith('-')||hasTraversalSegments(job.branch)))||
  typeof job.baseBranch!=='string'|| !/^[a-zA-Z0-9_.\/-]+$/.test(job.baseBranch)||hasTraversalSegments(job.baseBranch) ||
  !allowedModels.has(job.model)||!allowedReasoning.has(job.reasoning)||
  !Number.isInteger(job.maxRuntimeSeconds)||job.maxRuntimeSeconds<90||job.maxRuntimeSeconds>7200||
  typeof job.token!=='string'||job.token.length<20||
  (job.roleCapacity!==undefined&&(!Number.isInteger(job.roleCapacity)||job.roleCapacity<1||job.roleCapacity>10))||
   typeof job.title!=='string'||job.title.length>300||typeof job.description!=='string')
  return 'Некорректные параметры задачи';
 return null;
}

import {createPrEvidenceReader} from './modules/integrations/github/infrastructure/pr-evidence.js';
import {decryptConnectionSecret} from './modules/integrations/connections/secret-cipher.js';
import {createQaPlanActivity} from './modules/quality/application/prepare-qa-plan.js';
import {createTaskStageAnalysisActivity} from './modules/execution/application/task-stage-analysis.js';
import {updateCurrentSpecification} from './requirements.js';
import {createRunnerRecovery,runnerUnavailable} from './modules/execution/application/runner-recovery.js';
import {readProjectAgentAvailability,ProjectAgentAvailabilityError,type ProjectAgentScope} from './modules/execution/project-agent-availability.js';
import {createRunnerHttpClient} from './infrastructure/runner-http-client.js';
import {type AgentReaderScope} from './agent-tools.js';
import {composeAgentPrompt,agentPromptZones,recordAgentPrompt} from './agent-prompt.js';
import {PM_GOAL_POLICY} from './pm-goal-policy.js';
import {createAgentSession,finishAgentSession} from './agent-tools.js';
import {readChatImages,type RunnerImage} from './chat-images.js';
import {workflowResponsibility} from './workflow-responsibilities.js';
import {runnerAssistantPrompt} from './runner-assistant-prompt.js';
import {heartbeat} from '@temporalio/activity';
import {createAssistantService} from './assistant.js';
import {executeProjectManagerInbox,failProjectManagerInbox,readProjectManagerWatchResume,type ProjectManagerWatch} from './project-manager-inbox.js';
import {runIterationPlanning} from './project-iterations.js';
import {performAutomaticDeployment,failAutomaticDeployment as markDeploymentFailed} from './deployment-automation.js';
import {runQualityGates} from './quality-gates.js';
import {deploymentDecision} from './deployment-stage.js';
import pg from 'pg';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {createMergeService} from './merge-service.js';
import {createMergeBatchActivities} from './modules/integrations/github/application/merge-batch-activities.js';
import {ApplicationFailure} from '@temporalio/common';
import {prepareQaDocumentation,readQaPlan} from './qa-plan.js';
import {reconcileTaskRequirements,requirementState} from './requirements.js';
import {releaseTaskOrchestration} from './task-orchestration.js';
import {recordTaskAgentNote,pendingAgentQuestions} from './task-agent-notes.js';
import {readTaskWorkBrief} from './task-work-brief.js';
import {managerSnapshot,syncManagerInbox} from './project-manager.js';
import {resolveAgentMention,AGENT_MENTION_HINT} from './agent-mentions.js';
import {recordAgentActivity} from './task-agent-activity.js';
import {markPeerWorkResult} from './agent-peer-queue.js';
import {createPeerQuestionResolution} from './modules/agents/application/peer-question-resolution.js';
import {finalizeWorkAttempt} from './modules/agents/infrastructure/work-assignments.js';
import {evaluateQaRun} from './modules/quality/domain/qa-verdict.js';
import {browserEvidenceAssessment,validEvidenceSha} from './task-evidence.js';
import {finishTaskEvidenceRun} from './task-evidence-queue.js';
import {buildKnowledgeContext,type KnowledgeStage} from './knowledge-workflow.js';
import {agentMemoryContext,conversationInstructions,recordAgentLearning,resolveRoleAiSettings,roleCapacity} from './project-team.js';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
/** Durable pause gate. Temporal workflows sleep without occupying a worker
 * slot until this project's operators or PM explicitly resume the team. */
export async function projectAgentsRunning(scope:ProjectAgentScope):Promise<boolean>{
 try {
  return await readProjectAgentAvailability(pool,scope);
 }catch(error){
  // Preserve non-retryable Temporal failures for deleted/unknown projects.
  if(error instanceof ProjectAgentAvailabilityError)
   throw ApplicationFailure.nonRetryable(error.message);
  throw error;
 }
}

const codexUrl=process.env.CODEX_RUNNER_URL||'http://codex:4300';
const runnerKey=process.env.RUNNER_SHARED_SECRET||'';

function decrypt(packed:string):string{
 const key=Buffer.from(process.env.CREDENTIALS_KEY||'','hex');
 if(key.length!==32)throw Error('CREDENTIALS_KEY must contain 32 bytes');
 return decryptConnectionSecret(packed,key);
}
// Keep the existing caller-facing shape until activities adopt typed job DTOs.
const runnerRequest=createRunnerHttpClient({baseUrl:codexUrl,secret:runnerKey});
function runner(path:string,method:'GET'|'POST'='GET',body?:unknown):Promise<any>{
 return runnerRequest(path,method,body);
}
const {trackRunnerWait,failRunnerRun}=createRunnerRecovery(pool,event);
async function event(projectId:string,processId:string,kind:string,stage:string,detail:string,level='info'){
 await pool.query('INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [randomUUID(),projectId,processId,kind,stage,detail.slice(0,2200),level]);
}
type TaskRef={projectId:string;taskId:string;runId:string;attempt?:number;recovery?:boolean};
async function jobSettings(projectId:string,taskId:string){
 const [task,repo,settings,rules,workflow]=await Promise.all([
  pool.query('SELECT * FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]),
  pool.query("SELECT g.repository,g.default_branch,g.target_branch,c.secret_encrypted FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.provider='github_token'",[projectId]),
  pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]),
  pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 15',[projectId]),
  pool.query("SELECT stage,agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage IN ('development','testing')",[projectId])
 ]);
 if(!task.rowCount||!repo.rowCount||!settings.rowCount||!settings.rows[0].enabled)
  throw ApplicationFailure.nonRetryable('Задача, подключение GitHub или настройки AI недоступны');
 const t=task.rows[0],g=repo.rows[0],ai=settings.rows[0];
 const agentSettings=await Promise.all(workflow.rows.map(async row=>({...row,agent_instructions:String(row.agent_instructions||'')+'\n\nНакопленный опыт и утверждённые дополнения:\n'+await agentMemoryContext(pool,projectId,row.stage,String(t.title||'')+' '+String(t.description||'')+' '+String(g.repository||''))})));
  return {task:t,repo:g,ai,token:decrypt(g.secret_encrypted),rules:rules.rows.map(x=>x.body).join('\n').slice(0,1800),agentSettings};
}
async function dispatch(job:any,beforeStart?:()=>Promise<boolean>){
 try{
  const current=await runner('/jobs/'+job.id);
  if(current.status!=='interrupted')return true;
  // The journal owns recovery, including the recorded GitHub checkpoint.
  beforeStart=undefined;
 }catch(e){
  if((e as any).statusCode!==404)throw e;
 }
 if(beforeStart&&!await beforeStart())return false;
 try{await runner('/jobs','POST',job);}
 catch(e){if((e as any).statusCode!==409)throw e;}
 return true;
}

function formatWorkflowKnowledge(ctx:Awaited<ReturnType<typeof buildKnowledgeContext>>){
 const modules=ctx.instructions.modules.map(x=>x.title+': '+x.body).join('\n\n');
 const documents=ctx.documents.map(x=>'Источник '+x.id+' ('+x.version+'): '+x.title+'\n'+(x.excerpt||x.summary)).join('\n\n');
 return {modules,documents};
}
async function stageContext(projectId:string,taskId:string,stage:KnowledgeStage,processId?:string){
 return buildKnowledgeContext(pool,{projectId,taskId,stage,processId,budgetChars:1800,includeBodies:false});
}
async function taskHandoffContext(projectId:string,taskId:string,stage:string){
 const responsibility=workflowResponsibility(stage);
 const assignment=responsibility?'Этап '+stage+'. Ожидаемый результат: '+responsibility.result+'\n':'';
 return assignment+await readTaskWorkBrief(pool,projectId,taskId,3700);
}

async function assistantCompletion(prompt:string,projectId:string,taskId:string,operation:string,processId?:string):Promise<string>{
 const setup=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]);
 const ai=setup.rows[0];if(!ai?.enabled)throw ApplicationFailure.nonRetryable('AI выключен в настройках проекта');
 const stage:KnowledgeStage=operation.includes('qa')||operation.includes('test')?'testing':operation.includes('documentation')?'documentation':'analysis';
 const knowledge=formatWorkflowKnowledge(await stageContext(projectId,taskId,stage));
 const composed=composeAgentPrompt({
  role:stage==='analysis'?'Системный аналитик':stage==='testing'?'QA-инженер':'Аналитик документации',
  objective:prompt,
  instructions:(await agentMemoryContext(pool,projectId,stage)).slice(0,1400),
  tools:'Поиск и чтение проектных знаний, задачи и процесса; MCP agents.consult, blockers.list/report/resolve для доказанных технических блокеров. Итог в запрошенном структурированном формате.',
  scope:'Проект '+projectId+', задача '+taskId,
  context:knowledge.documents.slice(0,1300)+'\n'+knowledge.modules.slice(0,850)
 });
 await recordAgentPrompt(pool,{projectId,processId:processId||taskId,role:stage,operation,prompt:composed}).catch(()=>{});
 return askRunnerAssistant(composed,projectId,taskId,operation,await resolveRoleAiSettings(pool,projectId,stage,ai),110000,[],{role:stage,processId});
}
async function askTaskManagerAgent(prompt:string,projectId:string,taskId:string,messageId:string,actorId:string,
 ai:{model:string;reasoning:string},images:RunnerImage[]):Promise<string>{
 const session=await createAgentSession(pool,projectId,actorId,'manager',messageId);
 try{
  await recordAgentPrompt(pool,{projectId,processId:messageId,role:'manager',operation:'task_manager',prompt}).catch(()=>{});
  const response=await fetch(codexUrl+'/agent',{
   method:'POST',headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({prompt,model:ai.model,reasoning:ai.reasoning,session_token:session.secret,
    agent_role:'manager',project_id:projectId,role_capacity:1,images}),
   signal:AbortSignal.timeout(255000)
  });
  const data=await response.json().catch(()=>({})) as any;
  if(!response.ok||typeof data.message!=='string'||!data.message.trim())
   throw Error(String(data.error||'Менеджер не вернул результат инструмента').slice(0,700));
  if(data.usage){
   const usage=data.usage;
   await pool.query('INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [randomUUID(),projectId,taskId,messageId,'task_manager',ai.model,
     Number(usage.input_tokens)||0,Number(usage.cached_input_tokens)||0,Number(usage.output_tokens)||0]).catch(()=>{});
  }
  return data.message;
 }finally{await finishAgentSession(pool,session.id).catch(()=>{});}
}
async function askRunnerAssistant(prompt:string,projectId:string,taskId:string|null,operation:string,ai:{model:string;reasoning:string},timeoutMs=110000,images:RunnerImage[]=[],reader?:Omit<AgentReaderScope,'projectId'|'taskId'>):Promise<string>{
 const response=await fetch(codexUrl+'/assistant',{method:'POST',
  headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
  body:JSON.stringify({prompt:runnerAssistantPrompt(prompt),model:ai.model,reasoning:ai.reasoning,images,context:reader?{...reader,projectId,taskId:taskId??undefined}:undefined}),
  signal:AbortSignal.timeout(timeoutMs)});
 const data=await response.json().catch(()=>({})) as any;
 if(!response.ok||typeof data.message!=='string')throw Error(String(data.error||'Codex не вернул результат').slice(0,500));
 if(data.usage){
  const u=data.usage;
  const src=randomUUID();
  await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
   [randomUUID(),projectId,taskId,src,operation,ai.model,Number(u.input_tokens)||0,Number(u.cached_input_tokens)||0,Number(u.output_tokens)||0]);
 }
 return data.message;
}
/** Preserve the Temporal Activity export and workflow contract across refactors. */
export const runTaskStageAnalysis=createTaskStageAnalysisActivity<PoolClient>({
 pool,updateSpecification:updateCurrentSpecification,taskHandoffContext,assistantCompletion,event
});

export async function prepareIterationPlanDraft(runId:string){
 await runIterationPlanning(pool,runId,async(prompt,projectId,role)=>{
  const ai=(await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId])).rows[0];
  if(!ai?.enabled)throw ApplicationFailure.nonRetryable('AI выключен в настройках проекта');
  await recordAgentPrompt(pool,{projectId,processId:runId,role:role||'analysis',operation:'iteration_planning',prompt}).catch(()=>{});
  return askRunnerAssistant(prompt,projectId,null,'iteration_planning',await resolveRoleAiSettings(pool,projectId,role||'analysis',ai),210000,[],{role:role||'analysis',processId:runId});
 });
}
export async function failIterationPlanDraft(runId:string,message:string){
 const result=await pool.query(`UPDATE iteration_planning_runs r SET status='failed',message=$2,updated_at=now()
  FROM project_iterations i WHERE r.id=$1 AND r.iteration_id=i.id AND r.status IN ('queued','running')
  RETURNING i.project_id`,[runId,message.slice(0,700)]);
 if(result.rowCount)await event(result.rows[0].project_id,runId,'analysis','failed',message,'error');
}
const prEvidence=createPrEvidenceReader(pool,decrypt);

export async function reconcileRequirements(args:{projectId:string;taskId:string;runId:string;mode:'handoff'|'edit'}):Promise<'current'|'pending'|'needs_approval'|'rejected'>{
 const {projectId,taskId,runId,mode}=args;
 const version=await pool.query('SELECT spec_version FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]);
 if(!version.rowCount)throw Error('Задача не найдена');
 try{
  const evidence=await prEvidence(projectId,taskId);
  const cached=evidence.commitSha&&(await pool.query(
   "SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2 AND spec_review_status='current' AND spec_reviewed_version=spec_version AND spec_reviewed_commit=$3",
   [taskId,projectId,evidence.commitSha])).rowCount;
  await pool.query(`INSERT INTO requirement_review_runs(id,project_id,task_id,spec_version,status,message,completed_at)
   VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5='completed' THEN now() END)
   ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,message=EXCLUDED.message,spec_version=EXCLUDED.spec_version,completed_at=EXCLUDED.completed_at`,
  [runId,projectId,taskId,version.rows[0].spec_version,cached?'completed':'running',cached?'Использована сверка для текущих ТЗ и коммита':'Аналитик сверяет изменения']);
  if(cached)return 'current';
  await event(projectId,runId,'analysis','review_started',mode==='handoff'?'Сверка реализации с утверждённым ТЗ перед тестированием':'Анализ изменения требований');
  const notes=await taskHandoffContext(projectId,taskId,'analysis');
  const result=await reconcileTaskRequirements(pool,{projectId,taskId,commitSha:evidence.commitSha,prEvidence:evidence.patch,developerSummary:evidence.summary,taskContext:notes},prompt=>assistantCompletion(prompt,projectId,taskId,'requirements_review',runId));
  const latest=await pool.query('SELECT summary,questions FROM task_requirement_reviews WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1',[projectId,taskId]);
  const hasQuestions=Array.isArray(latest.rows[0]?.questions)&&latest.rows[0].questions.length>0;
  const noteBody=(hasQuestions?latest.rows[0].questions.join('\n')+'\n':'')+String(latest.rows[0]?.summary||'').trim();
  const needsAnswer=result==='needs_approval'&&hasQuestions;
  if(noteBody)await recordTaskAgentNote(pool,{projectId,taskId,authorStage:'analysis',authorName:'AI-аналитик',targetStage:needsAnswer?'analysis':result==='needs_approval'?'all':'testing',kind:needsAnswer?'question':'handoff',body:noteBody,sourceKey:'analyst:'+runId+':'+result,sourceRunId:runId});
  const message=result==='current'?'Требования актуальны':result==='needs_approval'?'Обнаружено изменение поведения — требуется решение пользователя':result==='rejected'?'Изменение требований отклонено':'Требования изменились во время анализа';
  await pool.query("UPDATE requirement_review_runs SET status='completed',message=$2,completed_at=now() WHERE id=$1",[runId,message]);
  await event(projectId,runId,'analysis',result,message,result==='needs_approval'?'warning':'info');
  return result;
 }catch(e){
  const message=e instanceof Error?e.message:String(e);
  await pool.query("UPDATE requirement_review_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,message.slice(0,2000)]);
  await event(projectId,runId,'analysis','failed',message,'error');
  throw e;
 }
}
export async function finishTaskOrchestration(args:{projectId:string;taskId:string;ownerId:string}):Promise<void>{
 await releaseTaskOrchestration(pool,args.projectId,args.taskId,args.ownerId);
}
export async function checkRequirementStatus(args:{projectId:string;taskId:string}):Promise<'current'|'pending'|'needs_approval'|'rejected'>{
 return requirementState(pool,args.projectId,args.taskId);
}
export async function scheduleRequirementFix(args:{projectId:string;taskId:string;cycleId:string;attempt:number}):Promise<string>{
 const {projectId,taskId,cycleId,attempt}=args;
 await pool.query("UPDATE tasks SET stage='development',updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,projectId]);
 const found=await pool.query('SELECT id FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2',[cycleId,attempt]);
 if(found.rowCount)return found.rows[0].id;
 const original=await pool.query('SELECT triggered_by,model FROM ai_task_runs WHERE id=$1 AND project_id=$2',[cycleId,projectId]);
 if(!original.rowCount)throw Error('Исходная разработка не найдена');
 const id=randomUUID();
 await pool.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status,cycle_id,cycle_attempt) VALUES($1,$2,$3,$4,$5,'queued',$6,$7) ON CONFLICT(cycle_id,cycle_attempt) DO NOTHING",
  [id,projectId,taskId,original.rows[0].triggered_by,original.rows[0].model,cycleId,attempt]);
 return (await pool.query('SELECT id FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2',[cycleId,attempt])).rows[0].id;
}
export async function noteReviewFailure(args:{projectId:string;taskId:string;runId:string;message:string}){
 const message=args.message.slice(0,1900);
 await pool.query("UPDATE requirement_review_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1 AND project_id=$3",[args.runId,message,args.projectId]);
 await event(args.projectId,args.runId,'analysis','failed',message,'error');
}

/** Keep the existing Temporal Activity name and signature for in-flight workflows. */
export const prepareQaPlan=createQaPlanActivity({
 pool,
 failNonRetryable:message=>ApplicationFailure.nonRetryable(message),
 event,
 recordActivity:(projectId,taskIds,runId,kind,status,message)=>recordAgentActivity(pool,projectId,taskIds,runId,kind,status,message),
 pendingQuestions:async(projectId,taskId)=>(await pendingAgentQuestions(pool,projectId,taskId))>0,
 prEvidence,
 loadKnowledge:async(projectId,taskId,runId)=>formatWorkflowKnowledge(await stageContext(projectId,taskId,'testing',runId)),
 taskHandoffContext,
 prepareDocumentation:(args,ask)=>prepareQaDocumentation(pool,args,ask),
 recordPrompt:entry=>recordAgentPrompt(pool,entry),
 askQaAgent:async(prompt,projectId,taskId,ai,runId)=>askRunnerAssistant(prompt,projectId,taskId,'qa_plan',
  await resolveRoleAiSettings(pool,projectId,'testing',ai),105000,[],{role:'testing',processId:runId}),
 recordNote:entry=>recordTaskAgentNote(pool,entry)
});

async function finishExistingTaskBranch(args:TaskRef,git:{repository:string;baseBranch:string;token:string;title:string},actorId:string):Promise<boolean>{
 const {projectId,taskId,runId}=args;
 const {repository,baseBranch,token,title}=git;
 const branch=taskId;
 const apiBase='https://api.github.com/repos/'+repository;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const gh=async(endpoint:string,options:RequestInit={})=>{
  const response=await fetch(apiBase+endpoint,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>({})) as any;
  return {response,data};
 };
 // A task's branch might not yet have been created. No changes means normal Codex development.
 const branchResult=await gh('/branches/'+encodeURIComponent(branch));
 if(branchResult.response.status===404)return false;
 if(!branchResult.response.ok)throw Object.assign(new Error('Не удалось проверить ветку задачи в GitHub: HTTP '+branchResult.response.status),{statusCode:502});
 const comparison=await gh('/compare/'+encodeURIComponent(baseBranch)+'...'+encodeURIComponent(branch));
 if(!comparison.response.ok)throw Object.assign(new Error('Не удалось сравнить ветки: GitHub HTTP '+comparison.response.status),{statusCode:502});
 if(!(Number(comparison.data.ahead_by)>0))return false;
 // Source code has already been pushed. Don't charge Codex again for the same work.
 const existing=await gh('/pulls?state=open&head='+encodeURIComponent(repository.split('/')[0]+':'+branch)+'&per_page=100');
 if(!existing.response.ok)throw Object.assign(new Error(existing.response.status===403
  ?'GitHub HTTP 403: у подключённого токена нет доступа к Pull Requests. В GitHub выдай ему разрешение Pull requests: Read and write и сохрани подключение заново.'
  :'Не удалось прочитать Pull Requests: GitHub HTTP '+existing.response.status),{statusCode:existing.response.status===403?409:502});
 const open=(Array.isArray(existing.data)?existing.data:[]) as any[];
 let pr=open.find(item=>item.base?.ref===baseBranch);
 // A PR on this task branch may target an older base. Repair its target
 // rather than attempting a duplicate PR (GitHub 422).
 if(!pr&&open.length){
  const changed=await gh('/pulls/'+open[0].number,{method:'PATCH',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({base:baseBranch})});
  if(!changed.response.ok)throw Object.assign(new Error('Не удалось обновить базовую ветку PR #'+open[0].number+
   ': HTTP '+changed.response.status+' '+String(changed.data.message||'')),{statusCode:409});
  pr=changed.data;
 }
 if(!pr){
  const closed=await gh('/pulls?state=closed&head='+encodeURIComponent(repository.split('/')[0]+':'+branch)+'&per_page=100');
  if(!closed.response.ok)throw Object.assign(new Error('Не удалось проверить закрытые PR: HTTP '+closed.response.status),{statusCode:502});
  const recoverable=(Array.isArray(closed.data)?closed.data:[]).find((item:any)=>!item.merged_at&&item.base?.ref===baseBranch);
  if(recoverable){
   const reopened=await gh('/pulls/'+recoverable.number,{method:'PATCH',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({state:'open'})});
   if(!reopened.response.ok)throw Object.assign(new Error('Не удалось переоткрыть PR #'+recoverable.number+
    ': HTTP '+reopened.response.status+' '+String(reopened.data.message||'')),{statusCode:409});
   pr=reopened.data;
  }
 }
 if(!pr){
  const created=await gh('/pulls',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({title:'AI: '+title.slice(0,180),body:'Изменения по задаче '+taskId+'\n\nПодготовлено AI Development Orchestrator. Проверь изменения перед слиянием.',head:branch,base:baseBranch,draft:false})});
  if(!created.response.ok)throw Object.assign(new Error(created.response.status===403
   ?'GitHub HTTP 403: создание PR запрещено. Нужны Pull requests: Read and write в разрешениях токена.'
   :'Не удалось создать PR: GitHub HTTP '+created.response.status+' '+String(created.data.message||'').slice(0,180)),{statusCode:409});
  pr=created.data;
 }
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const saved=await db.query(`UPDATE ai_task_runs SET pr_url=$2,branch=$3,status='completed',
   message='PR восстановлен из готовых изменений без повторного запуска Codex',completed_at=now()
   WHERE id=$1 AND status IN ('queued','running') RETURNING id`,[runId,pr.html_url,branch]);
  if(saved.rowCount){
   await db.query("UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$5,updated_at=now() WHERE id=$1 AND project_id=$6",
    [taskId,branch,pr.html_url,pr.number,baseBranch,projectId]);
   await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'pr_created',$4)",
    [randomUUID(),taskId,actorId,'PR восстановлен из готовых изменений: '+pr.html_url]);
  }
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
 return true;
}

export async function startDevelopment(args:TaskRef){
 const {projectId,taskId,runId,attempt=0}=args;
 const {task,repo,ai,token,rules,agentSettings}=await jobSettings(projectId,taskId);
 if(await pendingAgentQuestions(pool,projectId,taskId))throw ApplicationFailure.nonRetryable('У задачи есть вопросы агентов, на которые ещё не ответили');
 const record=await pool.query(`SELECT r.status,r.triggered_by,r.runner_spec_version,q.spec_version AS approved_spec
  FROM ai_task_runs r LEFT JOIN iteration_execution_queue q ON q.run_id=r.id WHERE r.id=$1 AND r.project_id=$2`,[runId,projectId]);
 if(!record.rowCount)throw ApplicationFailure.nonRetryable('Запуск разработки отсутствует');
 if(record.rows[0].status==='cancelled')throw ApplicationFailure.nonRetryable('Разработка отменена пользователем');
 if(['completed','failed'].includes(record.rows[0].status))return;
 const original=record.rows[0].runner_spec_version??record.rows[0].approved_spec;
 if(original!=null&&original!==task.spec_version)
  throw ApplicationFailure.nonRetryable('Версия ТЗ изменилась после запуска');
 const pinned=await pool.query(`UPDATE ai_task_runs SET runner_spec_version=COALESCE(runner_spec_version,$2)
  WHERE id=$1 AND status IN ('queued','running') AND COALESCE(runner_spec_version,$2)=$2 RETURNING id`,[runId,task.spec_version]);
 if(!pinned.rowCount)throw ApplicationFailure.nonRetryable('Попытка разработки изменилась или отменена');
 const baseBranch=task.pr_base_branch||repo.target_branch||repo.default_branch;
 // Branch identity belongs to the TASK, not to the Codex attempt or cycle.
 // A resumed QA rework must continue the same task-owned branch.
 const linkedBranch=String(task.git_branch||'');
 if(linkedBranch&&linkedBranch!==taskId&&linkedBranch!==baseBranch&&task.implementation_kind!=='already_implemented')
  throw ApplicationFailure.nonRetryable('Задача уже привязана к другой рабочей ветке: '+linkedBranch+'. Автоматически менять её нельзя.');
 await pool.query("UPDATE tasks SET git_branch=$3 WHERE id=$1 AND project_id=$2 AND (git_branch IS NULL OR git_branch=$3 OR git_branch=$4 OR implementation_kind='already_implemented')",
  [taskId,projectId,taskId,baseBranch]);
 await pool.query("UPDATE ai_task_runs SET branch=$2 WHERE id=$1 AND status IN ('queued','running')",[runId,taskId]);
 const feedback=String(task.test_feedback||'').slice(0,3800);
 // A stale project-document review is advisory. Only live owner questions and
 // task analysis gates block the initial development; rework may proceed on PR.
 const beforeStart=!args.recovery&&!attempt&&record.rows[0].status==='queued'&&record.rows[0].approved_spec!=null?async()=>{
  if(!feedback&&await finishExistingTaskBranch(args,{repository:repo.repository,baseBranch,token,title:task.title},record.rows[0].triggered_by))return false;
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'};
  const base='https://api.github.com/repos/'+repo.repository;
  const branch=await fetch(base+'/branches/'+encodeURIComponent(baseBranch),{headers,signal:AbortSignal.timeout(12000)});
  if(branch.status===404)throw ApplicationFailure.nonRetryable('Ветка '+baseBranch+' не найдена в GitHub');
  if(!branch.ok)throw Error('Не удалось проверить базовую ветку: GitHub HTTP '+branch.status);
  const pulls=await fetch(base+'/pulls?state=open&per_page=1',{headers,signal:AbortSignal.timeout(12000)});
  if(pulls.status===403)throw ApplicationFailure.nonRetryable('GitHub запрещает доступ к PR. Проверьте право Pull requests: Read and write.');
  if(!pulls.ok)throw Error('Не удалось проверить доступ к PR: GitHub HTTP '+pulls.status);
  return true;
 }:undefined;
 const description=String(task.description||'').slice(0,10500)+(feedback?'\n\nОБЯЗАТЕЛЬНЫЕ ИСПРАВЛЕНИЯ ПО РЕЗУЛЬТАТАМ ПРОВЕРКИ:\n'+feedback:'');
 const knowledge=formatWorkflowKnowledge(await stageContext(projectId,taskId,'development',runId));
 const developerAi=await resolveRoleAiSettings(pool,projectId,'development',ai);
 const agentInstructions=(agentSettings.find((s:any)=>s.stage==='development')?.agent_instructions||'')+'\n'+knowledge.modules;
 const agentPromptParts={
  role:String(agentSettings.find((s:any)=>s.stage==='development')?.agent_name||'AI-разработчик'),
  objective:task.title+'\n'+description,
  tools:'Локальная рабочая копия GitHub, терминал, редактирование и проверка файлов, а также адресные MCP: tasks.read, knowledge.search/read, processes.list, agents.consult, blockers.list/report/resolve. Git commit/push/PR выполняет только Runner.',
  instructions:agentInstructions,
  scope:'Репозиторий '+repo.repository+', базовая ветка '+baseBranch+'; задача '+taskId,
  context:'Продолжение задачи и новые комментарии:\n'+(await taskHandoffContext(projectId,taskId,'development')).slice(0,2400)+'\nПравила: '+rules.slice(0,500)+'\nДокументация: '+knowledge.documents.slice(0,650),
  output:'Разработка соответствует критериям, существующий PR переиспользован или готовая реализация подтверждена на текущем SHA. Независимая проверка — следующий этап.'
 };
 const agentPrompt=composeAgentPrompt(agentPromptParts);
 const job={id:runId,taskId,projectId,actorId:record.rows[0].triggered_by,roleCapacity:await roleCapacity(pool,projectId,'development'),repository:repo.repository,baseBranch,token,
  model:developerAi.model,reasoning:developerAi.reasoning,maxRuntimeSeconds:1800,
  title:task.title,description,reworkFeedback:feedback,agentPrompt,agentPromptZones:agentPromptZones(agentPromptParts),projectRules:'',relatedTasks:[],knowledgeContext:'',handoffContext:'',agentName:'',agentInstructions:''};
 if(!await dispatch(job,beforeStart))return;
 await pool.query("UPDATE ai_task_runs SET status='running',message=$2 WHERE id=$1 AND status='queued'",
  [runId,attempt?'Исправление дефектов после тестирования':'Разработка через Temporal']);
 await event(projectId,runId,'development','started',attempt?'Повторная разработка после дефектов':'Запуск разработки через Temporal');
}
export async function checkDevelopment(args:TaskRef):Promise<{status:string;message:string}>{
 const {projectId,taskId,runId}=args;
 const run=await pool.query('SELECT status,message,model FROM ai_task_runs WHERE id=$1 AND project_id=$2',[runId,projectId]);
 if(!run.rowCount)throw ApplicationFailure.nonRetryable('Запуск разработки не найден');
 if(run.rows[0].status==='cancelled')return {status:'failed',message:'Прервано пользователем'};
 if(['completed','failed'].includes(run.rows[0].status))return {status:run.rows[0].status,message:run.rows[0].message};
 let remote:any;
 try{remote=await runner('/jobs/'+runId);}
 catch(e){
  if((e as {statusCode?:number}).statusCode!==404)return trackRunnerWait('development',projectId,runId,e);
  // Legacy jobs have no journal. Reuse a verifiable existing PR/branch when possible.
  const {task,repo,token}=await jobSettings(projectId,taskId);
  const actor=(await pool.query('SELECT triggered_by FROM ai_task_runs WHERE id=$1',[runId])).rows[0]?.triggered_by;
  if(!task.test_feedback&&actor&&await finishExistingTaskBranch(args,{
   repository:repo.repository,baseBranch:task.pr_base_branch||repo.target_branch||repo.default_branch,token,title:task.title
  },actor))return {status:'completed',message:'PR восстановлен из GitHub'};
  return failRunnerRun('development',projectId,runId,'У запуска нет сохранённого состояния. Проверьте ветку перед новым запуском.');
 }
 if(remote.status==='cancelled')return failRunnerRun('development',projectId,runId,'Исполнитель подтвердил остановку разработки');
 if(remote.status==='interrupted'){
  try{await startDevelopment({...args,recovery:true});}
  catch(error){
   if(error instanceof ApplicationFailure&&error.nonRetryable)return failRunnerRun('development',projectId,runId,error.message);
   return trackRunnerWait('development',projectId,runId,error);
  }
  return trackRunnerWait('development',projectId,runId,undefined,remote.message);
 }
 const status=String(remote.status||'running'),message=String(remote.message||'').slice(0,3000);
 if(!['completed','failed'].includes(status)&&message!==run.rows[0].message){
  await pool.query("UPDATE ai_task_runs SET status=$2,message=$3 WHERE id=$1 AND status IN ('queued','running')",[runId,status,message]);
  await event(projectId,runId,'development',status,message);
 }
 if(status==='completed'||status==='failed'){
  const reusedBase=remote.completionKind==='already_implemented';
  if(status==='completed'&&!remote.prUrl&&!reusedBase){
   const msg='Разработка завершилась без PR и без проверяемого доказательства существующей реализации';
   await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,msg]);
   return {status:'failed',message:msg};
  }
  const noChangeReview=status==='completed'&&!reusedBase?remote.reworkReview:null;
  if(noChangeReview){
   const sha=String(noChangeReview.commit||'');
   if(!/^[a-f0-9]{40}$/i.test(sha)||String(noChangeReview.summary||'').trim().length<40||
    !Array.isArray(noChangeReview.files)||!noChangeReview.files.length||
    !Array.isArray(noChangeReview.reasons)||!noChangeReview.reasons.length||!remote.prUrl)
    return failRunnerRun('development',projectId,runId,'Разработчик не объяснил, почему по замечаниям QA нет необходимости менять код');
  }
  if(status==='completed'&&reusedBase){
   const proof=remote.implementationEvidence,sha=String(remote.verifiedCommit||'');
   if(!/^[a-f0-9]{40}$/i.test(sha)||proof?.commit!==sha||!Array.isArray(proof?.files)||!proof.files.length||!Array.isArray(proof?.criteria)||!proof.criteria.length){
    return failRunnerRun('development',projectId,runId,'Нет проверяемого обоснования уже выполненной реализации');
   }
   const {repo,token,task}=await jobSettings(projectId,taskId);
   const base=task.pr_base_branch||repo.target_branch||repo.default_branch;
   const response=await fetch('https://api.github.com/repos/'+repo.repository+'/branches/'+encodeURIComponent(base),{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
    signal:AbortSignal.timeout(20000)
   });
   if(!response.ok)throw Error('Не удалось подтвердить базовую ветку для проверки существующего кода: GitHub HTTP '+response.status);
   const data=await response.json() as {commit?:{sha?:string}};
   if(data.commit?.sha!==sha)
    return failRunnerRun('development',projectId,runId,'Целевая ветка изменилась после анализа кода; требуется повторная проверка');
  }
  if(remote.usage){
   const u=remote.usage;
   await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,'development',$5,$6,$7,$8) ON CONFLICT(source_id) DO NOTHING",
    [randomUUID(),projectId,taskId,runId,run.rows[0].model,Number(u.input_tokens)||0,Number(u.cached_input_tokens)||0,Number(u.output_tokens)||0]);
  }
  if(status==='completed'){
    await recordAgentLearning(pool,{projectId,role:'development',runId,body:remote.learningSuggestion,evidence:'Запуск разработки '+runId+'; '+String(remote.prUrl||'')});
   if(String(remote.handoffNote||'').trim())await recordTaskAgentNote(pool,{
    projectId,taskId,authorStage:'development',authorName:'AI-разработчик',
    targetStage:noChangeReview?'testing':'all',kind:noChangeReview?'resolution':'handoff',
    body:String(remote.handoffNote),sourceKey:'developer:'+runId,sourceRunId:runId
   });
  }
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const saved=await db.query(`UPDATE ai_task_runs SET status=$2,message=$3,branch=$4,pr_url=$5,completed_at=now(),
     result_kind=$6,result_commit=$7
    WHERE id=$1 AND status IN ('queued','running') RETURNING id`,
   [runId,status,message,remote.branch||null,remote.prUrl||null,
    noChangeReview?'no_changes_needed':reusedBase?'already_implemented':status==='completed'?'code_changed':null,
    noChangeReview?.commit||remote.verifiedCommit||null]);
   if(!saved.rowCount){
    await db.query('ROLLBACK');
    return {status:'failed',message:'Попытка уже завершена или отменена'};
   }
   if(status==='completed'&&reusedBase){
    await db.query("UPDATE tasks SET stage='testing',implementation_kind='already_implemented',implementation_commit=$2,implementation_evidence=$3::jsonb,git_branch=$4,pr_url=NULL,pr_number=NULL,updated_at=now() WHERE id=$1 AND project_id=$5",
     [taskId,remote.verifiedCommit,JSON.stringify(remote.implementationEvidence),remote.branch,projectId]);
    await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'already_implemented',$4)",
     [randomUUID(),taskId,null,'Разработчик предъявил существующую реализацию на SHA '+remote.verifiedCommit+'; ожидается независимый QA']);
   }else if(status==='completed'){
    const match=/\/pull\/(\d+)$/.exec(String(remote.prUrl));
    await db.query("INSERT INTO knowledge_artifact_links(id,project_id,document_id,artifact_kind,artifact_ref,relation) SELECT gen_random_uuid(),$1,l.document_id,'pr',$3,'implemented_by' FROM knowledge_task_links l WHERE l.project_id=$1 AND l.task_id=$2 ON CONFLICT DO NOTHING",
     [projectId,taskId,String(remote.prUrl)]);
    await db.query("UPDATE tasks SET stage='testing',implementation_kind='pr',implementation_commit=NULL,implementation_evidence=NULL,git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$5,updated_at=now() WHERE id=$1 AND project_id=$6",
     [taskId,remote.branch||taskId,remote.prUrl,match?Number(match[1]):null,remote.baseBranch||null,projectId]);
    await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,NULL,'pr_created',$3)",
     [randomUUID(),taskId,'Рабочая ветка '+(remote.branch||taskId)+' · PR: '+String(remote.prUrl||'')]);
    if(noChangeReview)await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,NULL,'developer_no_changes',$3)",
     [randomUUID(),taskId,('Разработчик не менял код и вернул задачу на QA для повторной проверки на SHA '+noChangeReview.commit+
      '. Комментарий: '+noChangeReview.summary+'; обоснование: '+noChangeReview.reasons.join('; ')+
      '; файлы: '+noChangeReview.files.join(', ')+'; PR: '+String(remote.prUrl)).slice(0,2800)]);

   }
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  await event(projectId,runId,'development',status==='completed'?'testing':status,message,status==='failed'?'error':'info');
 }
 return {status,message};
}
/** A deterministic workflow branch chooses which quality contract applies. */
export async function developmentVerificationSource(input:{projectId:string;taskId:string}):Promise<'pr'|'already_implemented'>{
 const task=await pool.query("SELECT implementation_kind,implementation_commit,stage FROM tasks WHERE project_id=$1 AND id=$2",[input.projectId,input.taskId]);
 if(!task.rowCount||task.rows[0].stage!=='testing')throw ApplicationFailure.nonRetryable('Разработка ещё не передала задачу в QA');
 if(task.rows[0].implementation_kind==='already_implemented'&&/^[a-f0-9]{40}$/i.test(String(task.rows[0].implementation_commit||'')))return 'already_implemented';
 return 'pr';
}
export async function startTesting(args:{projectId:string;taskId:string;cycleId:string;attempt:number;recovery?:boolean;simplified?:boolean;singlePass?:boolean}):Promise<string>{
 const {projectId,taskId,cycleId,attempt}=args;
 const {task,repo,ai,token,rules,agentSettings}=await jobSettings(projectId,taskId);
 if(!args.simplified&&await pendingAgentQuestions(pool,projectId,taskId))throw ApplicationFailure.nonRetryable('У задачи есть вопросы, на которые необходимо ответить перед тестированием');
 const evidence=task.execution_mode==='browser_evidence'&&task.implementation_kind==='artifact';
 const reusedBase=task.implementation_kind==='already_implemented'&&!!task.implementation_commit;
 if(evidence&&!validEvidenceSha(task.evidence_source_sha))throw ApplicationFailure.nonRetryable('Нет закреплённого SHA для получения артефактов');
 if(!reusedBase&&!evidence&&(!task.pr_url||!task.git_branch))throw ApplicationFailure.nonRetryable('Нет PR или ветки для тестирования');
 const existing=await pool.query('SELECT id,status FROM ai_test_runs WHERE cycle_id=$1 AND attempt=$2',[cycleId,attempt]);
 if(!existing.rowCount){
  const storedPlan=await readQaPlan(pool,projectId,taskId);
  // Single-pass QA designs and verifies cases directly from the current approved task.
  // Do not reuse previously generated plans that may contain invented visual constraints.
  const testPlan=!args.singlePass&&storedPlan?.cases.length&&storedPlan.spec_version===task.spec_version?storedPlan:null;
  if(!args.singlePass&&!testPlan)throw ApplicationFailure.nonRetryable('QA-план устарел относительно актуальной версии ТЗ');
  if(!args.simplified){
   const stale=await pool.query("SELECT count(*)::int AS total FROM qa_plan_cases pc JOIN qa_test_cases c ON c.id=pc.case_id JOIN qa_test_plans p ON p.id=pc.plan_id WHERE p.project_id=$1 AND p.task_id=$2 AND c.status<>'active'",[projectId,taskId]);
   if(stale.rows[0].total>0)throw ApplicationFailure.nonRetryable('Тест-кейсы требуют ручного пересмотра');
  }
  const snapshot={...(testPlan??{cases:[]}),...(args.simplified?{simplified:true}:{}),...(args.singlePass?{singlePass:true,adHoc:!testPlan}:{})};
  let commit=task.spec_reviewed_commit;
  if(args.singlePass||reusedBase||evidence){
   const branch=task.pr_base_branch||repo.target_branch||repo.default_branch;
   const url=evidence?'/commits/'+encodeURIComponent(task.evidence_source_sha):reusedBase?'/branches/'+encodeURIComponent(branch):'/pulls/'+task.pr_number;
   const response=await fetch('https://api.github.com/repos/'+repo.repository+url,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
    signal:AbortSignal.timeout(20000)
   });
   if(!response.ok)throw Error('GitHub не подтвердил исходный код перед QA: HTTP '+response.status);
   const source=await response.json() as any;
   if(evidence){
    commit=String(source.sha||'');
    if(!validEvidenceSha(commit)||commit!==task.evidence_source_sha)
     throw ApplicationFailure.nonRetryable('Исходный SHA не подтверждён GitHub. Нельзя делать скриншоты другого состояния.');
   }else if(reusedBase){
    commit=String(source.commit?.sha||'');
    if(!/^[0-9a-f]{40}$/i.test(commit)||commit!==task.implementation_commit)
     throw ApplicationFailure.nonRetryable('Целевая ветка изменилась после подтверждения реализации; требуется повторный анализ');
   }else{
    if(source.state!=='open'||source.head?.ref!==task.git_branch||!/^[0-9a-f]{40}$/i.test(String(source.head?.sha||'')))
     throw ApplicationFailure.nonRetryable('Не удалось подтвердить открытый PR для QA');
    commit=source.head.sha;
   }
  }else if(task.spec_review_status!=='current'||task.spec_reviewed_version!==task.spec_version){
   throw ApplicationFailure.nonRetryable('ТЗ изменилось: требуется повторная сверка аналитиком');
  }
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   if(args.singlePass||reusedBase){
    const pinned=evidence
     ?await client.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note='' WHERE id=$1 AND project_id=$2 AND stage='testing' AND spec_version=$4 AND execution_mode='browser_evidence' AND implementation_kind='artifact' AND evidence_source_sha=$3",
      [taskId,projectId,commit,task.spec_version])
     :reusedBase
     ?await client.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note='' WHERE id=$1 AND project_id=$2 AND stage='testing' AND spec_version=$4 AND implementation_kind='already_implemented' AND implementation_commit=$3",
      [taskId,projectId,commit,task.spec_version])
     :await client.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note='' WHERE id=$1 AND project_id=$2 AND stage='testing' AND spec_version=$4 AND git_branch=$5 AND pr_number=$6",
      [taskId,projectId,commit,task.spec_version,task.git_branch,task.pr_number]);
    if(!pinned.rowCount)throw ApplicationFailure.nonRetryable('ТЗ или PR изменились перед запуском QA');
    task.spec_reviewed_commit=commit;
   }
   await client.query("INSERT INTO ai_test_runs(id,project_id,task_id,cycle_id,attempt,status,message,qa_spec_version,qa_plan_snapshot,runner_commit_sha) VALUES($1,$2,$3,$4,$5,'queued','Ожидает запуска проверки',$6,$7,$8) ON CONFLICT(cycle_id,attempt) DO NOTHING",
    [randomUUID(),projectId,taskId,cycleId,attempt,task.spec_version,JSON.stringify(snapshot),commit||null]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 const record=(await pool.query('SELECT id,status,qa_spec_version,qa_plan_snapshot,runner_commit_sha FROM ai_test_runs WHERE cycle_id=$1 AND attempt=$2',[cycleId,attempt])).rows[0];
 const id=record.id;
 if(record.status==='cancelled')throw ApplicationFailure.nonRetryable('Тестирование отменено пользователем');
 if(['completed','failed'].includes(record.status)||!args.recovery&&record.status==='running')return id;
 if(record.qa_spec_version!==task.spec_version||!record.qa_plan_snapshot||!record.runner_commit_sha||record.runner_commit_sha!==task.spec_reviewed_commit)
  throw ApplicationFailure.nonRetryable('QA-прогон нельзя запустить для изменившейся версии ТЗ или PR');
 const knowledge=formatWorkflowKnowledge(await stageContext(projectId,taskId,'testing',id));
 const qaPromptParts={
  role:String(agentSettings.find((s:any)=>s.stage==='testing')?.agent_name||'AI-тестировщик'),
  objective:'Независимо проверь задачу: '+task.title+'\n'+String(task.description||'').slice(0,6500),
  tools:'Изолированная копия репозитория, команды npm/pytest/API, локальный HTTP-сервер и разрешённые MCP-инструменты.',
  instructions:(agentSettings.find((s:any)=>s.stage==='testing')?.agent_instructions||'')+'\n'+knowledge.modules+
   (evidence?'\nЗАДАЧА ПО ПОЛУЧЕНИЮ АРТЕФАКТОВ: не изменяй код, не создавай PR. Запусти именно зафиксированный SHA. Через browser-client.mjs сделай настоящие viewport 1440x900 и 390x844, каждый раз вызови screenshot. Проверь фактический интерфейс и доступные сценарии через browser asserts. Укажи подтверждённый URL/локальный путь и источник среды в отчёте. Не подменяй внешний production URL локальной страницей; если пользователь требует продакшен, а доступен только изолированный локальный браузер, выстави blocked и сообщи нужный доступ. Сохранение скриншотов обязательно, текстовый отчёт не является заменой.':'') ,
  scope:'Репозиторий '+repo.repository+', задача '+taskId+', проверяемый commit '+String(task.spec_reviewed_commit||'')+
   (evidence?'; режим: только фактические артефакты браузера, PR и изменение кода запрещены':
    reusedBase?'; режим: уже реализовано в базовой ветке, PR отсутствует, проверяй существующее поведение по ТЗ':''),
  context:'История, новая обратная связь, предыдущие QA:\n'+(await taskHandoffContext(projectId,taskId,'testing')).slice(0,2400)+'\nПравила: '+rules.slice(0,500)+'\nДокументация: '+knowledge.documents.slice(0,650),
  output:'Полный независимый отчёт QA по утверждённым критериям, с реальными доказательствами, дефектами и непроверенными сценариями.'
 };
 const qaPrompt=composeAgentPrompt(qaPromptParts);
 await dispatch({id,kind:'test',taskId,projectId,roleCapacity:await roleCapacity(pool,projectId,'testing'),repository:repo.repository,baseBranch:task.pr_base_branch||repo.target_branch||repo.default_branch,
  token,model:(await resolveRoleAiSettings(pool,projectId,'testing',ai)).model,reasoning:ai.reasoning,maxRuntimeSeconds:900,
  title:task.title,description:task.description,agentPrompt:qaPrompt,agentPromptZones:agentPromptZones(qaPromptParts),projectRules:'',testPlan:record.qa_plan_snapshot,
  expectedCommit:record.runner_commit_sha,checkoutCommit:evidence?task.evidence_source_sha:undefined,branch:reusedBase||evidence?task.pr_base_branch||repo.target_branch||repo.default_branch:task.git_branch,knowledgeContext:'',handoffContext:'',agentName:'',agentInstructions:''});
 await pool.query("UPDATE ai_test_runs SET status='running',message='AI-тестировщик проверяет изменения' WHERE id=$1 AND status IN ('queued','running')",[id]);
 await event(projectId,id,'testing','started','Тестирование в отдельной рабочей копии репозитория');
 return id;
}
export async function checkTesting(args:{projectId:string;taskId:string;testId:string}):Promise<{status:string;message:string;verdict?:string}>{
 const {projectId,testId}=args;
 const row=await pool.query('SELECT status,message,task_id,cycle_id,attempt,qa_spec_version,qa_plan_snapshot FROM ai_test_runs WHERE id=$1 AND project_id=$2',[testId,projectId]);
 if(!row.rowCount)throw ApplicationFailure.nonRetryable('Запуск тестирования не найден');
 if(row.rows[0].status==='cancelled')return {status:'failed',message:'Прервано пользователем'};
 if(['completed','failed'].includes(row.rows[0].status)){
  const old=await pool.query('SELECT verdict FROM ai_test_runs WHERE id=$1',[testId]);
  return {status:row.rows[0].status,message:row.rows[0].message,verdict:old.rows[0]?.verdict};
 }
 let remote;
 try{remote=await runner('/jobs/'+testId);}
 catch(error){
  if((error as {statusCode?:number}).statusCode!==404)return trackRunnerWait('testing',projectId,testId,error);
  remote={status:'interrupted'};
 }
 if(remote.status==='cancelled')return failRunnerRun('testing',projectId,testId,'Исполнитель подтвердил остановку тестирования');
 if(remote.status==='interrupted'){
  const test=row.rows[0];
  if(!test.cycle_id)return failRunnerRun('testing',projectId,testId,'У старого QA-прогона отсутствует идентификатор цикла');
  try{await startTesting({projectId,taskId:test.task_id,cycleId:test.cycle_id,attempt:test.attempt,recovery:true,simplified:test.qa_plan_snapshot?.simplified===true});}
  catch(error){
   if(error instanceof ApplicationFailure&&error.nonRetryable)return failRunnerRun('testing',projectId,testId,error.message);
   return trackRunnerWait('testing',projectId,testId,error);
  }
  return trackRunnerWait('testing',projectId,testId,undefined,remote.message);
 }
 const status=String(remote.status||'running'),message=String(remote.message||'').slice(0,2500);
 if(status==='completed'||status==='failed'){
   if(status==='completed')await recordAgentLearning(pool,{projectId,role:'testing',runId:testId,body:remote.learningSuggestion,evidence:'QA-прогон '+testId+'; вердикт '+String(remote.verdict||'')});
  const snapshot=row.rows[0].qa_plan_snapshot;
  const singlePass=snapshot?.singlePass===true;
  if(singlePass&&status==='completed'&&remote.executionVerified!==true)
   return failRunnerRun('testing',projectId,testId,'Runner не подтвердил исполнение проверок. Обновите Codex Runner и повторите QA.');
  const currentSpec=await pool.query('SELECT spec_version,spec_review_status,spec_reviewed_version,spec_reviewed_commit,execution_mode,evidence_source_sha FROM tasks WHERE id=$1 AND project_id=$2',[row.rows[0].task_id,projectId]);
  const assessed=evaluateQaRun({
   snapshot,remote,status,message,qaSpecVersion:row.rows[0].qa_spec_version,currentSpec
  });
  const {adHoc,cases,checked,outcome,report}=assessed;
  let verdict=assessed.verdict;
  if(currentSpec.rows[0]?.execution_mode==='browser_evidence'&&verdict==='passed'){
   const proof=browserEvidenceAssessment(report,String(currentSpec.rows[0].evidence_source_sha||''));
   if(!proof.passed){
    verdict='blocked';
    report.summary=String(report.summary||'').slice(0,1200)+' · Артефакты не подтверждены: '+proof.reason;
   }
  }
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const locked=await client.query("SELECT id FROM ai_test_runs WHERE id=$1 AND status IN ('queued','running') FOR UPDATE",[testId]);
   if(!locked.rowCount){
    await client.query('ROLLBACK');
    return {status:'failed',message:'QA-прогон уже завершён или отменён'};
   }
   for(const check of adHoc?[]:checked){
    await client.query('INSERT INTO qa_case_results(id,project_id,test_run_id,case_id,result,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(test_run_id,case_id) DO UPDATE SET result=EXCLUDED.result,evidence=EXCLUDED.evidence',
     [randomUUID(),projectId,testId,check.case_id,check.result,check.evidence]);
   }
   await client.query('UPDATE ai_test_runs SET status=$2,message=$3,verdict=$4,report=$5,qa_plan_snapshot=COALESCE($6,qa_plan_snapshot),completed_at=now() WHERE id=$1',
    [testId,status,outcome,verdict,JSON.stringify(report),adHoc?JSON.stringify({...snapshot,cases}):null]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  if(String(remote.handoffNote||'').trim())await recordTaskAgentNote(pool,{projectId,taskId:row.rows[0].task_id,authorStage:'testing',authorName:'AI-тестировщик',targetStage:verdict==='failed'?'development':'all',kind:verdict==='failed'?'risk':'handoff',body:String(remote.handoffNote),sourceKey:'tester:'+testId,sourceRunId:testId});
  await event(projectId,testId,'testing',verdict,String(report.summary||'Тестирование завершено').slice(0,1400)+' · Результаты всех тест-кейсов доступны в отчёте QA в чате задачи.',verdict==='passed'?'info':verdict==='failed'?'error':'warning');
  return {status,message:outcome,verdict};
 }
 if(message!==row.rows[0].message){
  await pool.query("UPDATE ai_test_runs SET status=$2,message=$3 WHERE id=$1 AND status IN ('queued','running')",[testId,status,message]);
  await event(projectId,testId,'testing','progress',message);
 }
 return {status,message};
}
/** Tool limitations are not defects; retain the tested code for human review. */
export async function noteBlockedTests(args:{projectId:string;taskId:string;testId:string;simplified?:boolean}):Promise<void>{
 const {projectId,taskId,testId}=args;
 const test=await pool.query('SELECT status,verdict,report,qa_plan_snapshot FROM ai_test_runs WHERE id=$1 AND project_id=$2 AND task_id=$3',[testId,projectId,taskId]);
 if(!test.rowCount||test.rows[0].status!=='completed'||test.rows[0].verdict!=='blocked')
  throw ApplicationFailure.nonRetryable('Нельзя согласовать не завершённый или не заблокированный QA-прогон');
 const cases=Array.isArray(test.rows[0].report?.caseResults)?test.rows[0].report.caseResults:[];
 const missing=cases.filter((c:any)=>['blocked','not_run'].includes(c.result));
 const planned=Array.isArray(test.rows[0].qa_plan_snapshot?.cases)?test.rows[0].qa_plan_snapshot.cases:[];
 const names=new Map<string,string>(planned.map((c:{id:string;title:string})=>[c.id,c.title]));
 const ran=cases.filter((c:any)=>['passed','failed'].includes(c.result)).length;
 const reasons:Record<string,string>={tool_unavailable:'нет нужного инструмента',environment_unavailable:'нет подходящей среды',manual_only:'нужна ручная проверка'};
 const summary=String(test.rows[0].report?.summary||'').slice(0,450);
 const stale=test.rows[0].report?.staleSpecification===true?' Во время проверки изменилось ТЗ или PR. Нужна повторная проверка.':'';
 const msg=('Проверено '+ran+' из '+planned.length+'. Не удалось проверить '+missing.length+'. '+
  missing.slice(0,3).map((c:any)=>(names.get(c.case_id)||'Сценарий')+' — '+(reasons[c.reason]||'результат не подтверждён')).join('; ')+
  (missing.length>3?' и ещё '+(missing.length-3)+'.':'')+(summary?' '+summary:'')+stale).slice(0,1200);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const updated=await client.query("UPDATE tasks SET stage=$4,test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing' AND test_feedback IS DISTINCT FROM $3 RETURNING id",
   [taskId,projectId,msg,'testing']);
  if(updated.rowCount){
   await client.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',[randomUUID(),taskId,'qa_tools_unavailable',msg]);
   await client.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level) VALUES($1,$2,$3,'testing',$4,$5,'warning')",
    [randomUUID(),projectId,testId,'awaiting_manual_qa_decision',msg]);
  }
  await client.query('COMMIT');
  if(!updated.rowCount)return;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 if(!args.simplified)await syncManagerInbox(pool,projectId,taskId);
}
export async function approveTestedTask(args:{projectId:string;taskId:string;testId:string;simplified?:boolean}){
 if(!args.simplified&&await pendingAgentQuestions(pool,args.projectId,args.taskId))throw ApplicationFailure.nonRetryable('QA нашёл открытый вопрос. Ответь до перехода к слиянию');
 const {projectId,taskId,testId}=args;
 const verified=await pool.query(`SELECT t.implementation_kind,t.implementation_commit,t.execution_mode,t.evidence_source_sha,r.report
  FROM ai_test_runs r JOIN tasks t ON t.id=r.task_id
  WHERE r.id=$1 AND r.project_id=$2 AND r.task_id=$3 AND r.status='completed'
   AND r.verdict='passed' AND r.report->>'commit' IS NOT NULL
   AND r.qa_spec_version=t.spec_version`,[testId,projectId,taskId]);
 if(!verified.rowCount)throw ApplicationFailure.nonRetryable('Нет успешного независимого QA для текущей версии требований');
 const result=verified.rows[0];
 if(result.execution_mode==='browser_evidence'&&result.implementation_kind==='artifact'){
  const proof=browserEvidenceAssessment(result.report,result.evidence_source_sha);
  if(!proof.passed)throw ApplicationFailure.nonRetryable('Отсутствуют подлинные артефакты: '+proof.reason);
  const updated=await pool.query(`UPDATE tasks SET stage='done',test_feedback='',updated_at=now()
   WHERE id=$1 AND project_id=$2 AND stage='testing'
    AND execution_mode='browser_evidence' AND implementation_kind='artifact'
    AND evidence_source_sha=$3 AND spec_version=$4 RETURNING id`,
   [taskId,projectId,result.evidence_source_sha,result.report.spec_version]);
  if(!updated.rowCount)throw ApplicationFailure.nonRetryable('Задача или исходный SHA изменились после проверки');
  await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'evidence_verified',$3)",
   [randomUUID(),taskId,'Фактические desktop/mobile скриншоты получены и проверены на SHA '+result.evidence_source_sha+'. PR, merge и деплой пропущены как неприменимые.']);
  await event(projectId,testId,'testing','evidence_verified','Сохранены и проверены реальные артефакты без изменения кода');
  return;
 }
 if(result.implementation_kind==='already_implemented'){
  const sha=String(result.implementation_commit||'');
  const report=result.report||{};
  if(!/^[a-f0-9]{40}$/i.test(sha)||report.commit!==sha||report.executionVerified!==true||
   !Array.isArray(report.caseResults)||!report.caseResults.length||report.caseResults.some((c:any)=>c.result!=='passed'))
   throw ApplicationFailure.nonRetryable('Нужен полностью подтверждённый QA существующей реализации на закреплённом SHA');
  const {repo,token,task}=await jobSettings(projectId,taskId);
  const base=task.pr_base_branch||repo.target_branch||repo.default_branch;
  const response=await fetch('https://api.github.com/repos/'+repo.repository+'/branches/'+encodeURIComponent(base),{
   headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(20000)
  });
  if(!response.ok)throw Error('Не удалось перепроверить SHA целевой ветки после QA: GitHub HTTP '+response.status);
  const current=await response.json() as {commit?:{sha?:string}};
  if(current.commit?.sha!==sha)throw ApplicationFailure.nonRetryable('Целевая ветка изменилась во время QA: требуется повторная проверка');
  const client=await pool.connect();
  let decision:{stage:'documentation'|'deployment';status:'skipped'|'pending';reason:string};
  try{
   await client.query('BEGIN');
   const project=await client.query('SELECT owner_id FROM projects WHERE id=$1',[projectId]);
   const mode=await client.query('SELECT mode FROM project_deployment_settings WHERE project_id=$1',[projectId]);
   decision=deploymentDecision(mode.rows[0]?.mode||'skip');
   const updated=await client.query("UPDATE tasks SET stage=$4,test_feedback='',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing' AND implementation_kind='already_implemented' AND implementation_commit=$3 RETURNING id",
    [taskId,projectId,sha,decision.stage]);
   if(!updated.rowCount)throw ApplicationFailure.nonRetryable('Задача изменилась после QA');
   await client.query(`INSERT INTO task_deployment_records(task_id,project_id,status,reason,merge_sha,actor_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id) DO UPDATE SET status=EXCLUDED.status,
    reason=EXCLUDED.reason,merge_sha=EXCLUDED.merge_sha,actor_id=EXCLUDED.actor_id,updated_at=now()`,
    [taskId,projectId,decision.status,decision.reason,sha,project.rows[0]?.owner_id||null]);
   await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'existing_implementation_verified',$3)",
    [randomUUID(),taskId,'QA подтвердил, что требуемый код уже есть в базовой ветке на SHA '+sha+'. Новый PR не нужен.']);
   await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)",
    [randomUUID(),taskId,decision.status==='skipped'?'deployment_skipped':'deployment_pending',decision.reason]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await event(projectId,testId,'testing','already_implemented_verified','QA подтвердил исходную реализацию на '+sha+'. Дальнейший этап: '+decision!.stage);
  return;
 }
 await pool.query("UPDATE tasks SET stage='merge_queue',test_feedback='',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing'",
  [taskId,projectId]);
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),taskId,'tests_passed','Проверки завершены, PR готов к слиянию']);
 await event(projectId,testId,'testing','approved','Тесты пройдены. PR отправлен в очередь слияния');
}
export async function rejectTestedTask(args:{projectId:string;taskId:string;cycleId:string;testId:string;attempt:number;allowFix:boolean}):Promise<string|null>{
 const {projectId,taskId,cycleId,testId,attempt,allowFix}=args;
 const test=await pool.query('SELECT report FROM ai_test_runs WHERE id=$1',[testId]);
 const report=test.rows[0]?.report||{};
 const feedback=JSON.stringify(report).slice(0,10000);
 const lastDeveloper=await pool.query(
  "SELECT result_kind,result_commit FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2 AND project_id=$3 AND task_id=$4 ORDER BY created_at DESC LIMIT 1",
  [cycleId,attempt,projectId,taskId]);
 const unchanged=lastDeveloper.rows[0];
 if(unchanged?.result_kind==='no_changes_needed'&&unchanged.result_commit&&unchanged.result_commit===report.commit){
  // The developer has explicitly disputed the prior QA feedback without
  // changing this SHA. Another identical automatic developer cycle will not
  // resolve the contradiction: keep QA's failed verdict and ask PM to decide
  // whether tests, requirements or implementation need attention.
  const detail=('QA нашёл дефекты после подтверждения разработчиком отсутствия необходимых правок на SHA '+
   report.commit+'. Повторная автоматическая разработка остановлена; ПМ должен разобрать расхождение с QA. '+feedback).slice(0,2400);
  await pool.query("UPDATE tasks SET stage='testing',test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2",
   [taskId,projectId,detail]);
  await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'qa_dev_disagreement',$3)",
   [randomUUID(),taskId,detail]);
  await event(projectId,testId,'testing','needs_attention',detail,'warning');
  return null;
 }
 await pool.query("UPDATE tasks SET stage='development',test_feedback=$3,test_attempts=$4,updated_at=now() WHERE id=$1 AND project_id=$2",
  [taskId,projectId,feedback,attempt+1]);
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),taskId,'tests_failed',('Тестировщик вернул в разработку: '+feedback).slice(0,2400)]);
 await event(projectId,testId,'testing',allowFix?'retry_development':'needs_attention',
  allowFix?'Дефекты переданы разработчику. Автоматическое исправление '+(attempt+1):'Лимит автоматических исправлений исчерпан',allowFix?'warning':'error');
 if(!allowFix)return null;
 const old=await pool.query('SELECT id FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2',[cycleId,attempt+1]);
 if(old.rowCount)return old.rows[0].id;
 const settings=await pool.query('SELECT model FROM project_ai_settings WHERE project_id=$1',[projectId]);
 const initial=await pool.query('SELECT triggered_by FROM ai_task_runs WHERE id=$1',[cycleId]);
 const id=randomUUID();
 await pool.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status,cycle_id,cycle_attempt) VALUES($1,$2,$3,$4,$5,'queued',$6,$7) ON CONFLICT(cycle_id,cycle_attempt) DO NOTHING",
  [id,projectId,taskId,initial.rows[0].triggered_by,(await resolveRoleAiSettings(pool,projectId,'development',{...settings.rows[0],reasoning:'low'})).model,cycleId,attempt+1]);
 const saved=await pool.query('SELECT id FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2',[cycleId,attempt+1]);
 return saved.rows[0].id;
}
/** A failed analyst or QA preparation must not force fresh development of already finished code. */
export async function noteHandoffFailure(args:{projectId:string;taskId:string;runId:string;message:string;stage:string;qaRun?:{cycleId:string;attempt:number}}){
 const message=args.message.slice(0,2200);
 if(args.qaRun)await pool.query("UPDATE ai_test_runs SET status='failed',message=$5,completed_at=now() WHERE project_id=$1 AND task_id=$2 AND cycle_id=$3 AND attempt=$4 AND status='queued'",
  [args.projectId,args.taskId,args.qaRun.cycleId,args.qaRun.attempt,message]);
 await pool.query("UPDATE tasks SET test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing'",
 [args.taskId,args.projectId,message]);
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),args.taskId,'handoff_blocked',(args.stage+': '+message).slice(0,2200)]);
 await event(args.projectId,args.runId,args.stage.startsWith('qa_')||args.stage==='testing'?'testing':'analysis',args.stage,message,'error');
}
export async function noteCycleFailure(args:{projectId:string;taskId:string;message:string;stage:string}){
 if(args.stage==='development'){
  const failed=await pool.query(`UPDATE ai_task_runs SET status='failed',message=$3,completed_at=now()
   WHERE project_id=$1 AND task_id=$2 AND status='queued'
    AND cycle_id=(SELECT owner_id FROM task_orchestration_owners WHERE task_id=$2 AND state='active')
   RETURNING id`,[args.projectId,args.taskId,args.message.slice(0,3000)]);
  for(const run of failed.rows)await event(args.projectId,run.id,'development','failed',args.message,'error');
 }
 await pool.query("UPDATE tasks SET stage='development',test_feedback=CASE WHEN $3 LIKE 'Разработка не запущена:%' THEN test_feedback ELSE $3 END,updated_at=now() WHERE id=$1 AND project_id=$2 AND stage IN ('development','testing')",
  [args.taskId,args.projectId,args.message.slice(0,3000)]);
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),args.taskId,'pipeline_failed',(args.stage+': '+args.message).slice(0,2400)]);
}

/**
 * Only the Manager speaks to the customer. The model gets a bounded summary,
 * not full source trees, PR patches or the entire conversation. The existing
 * Codex CLI runs through the configured subscription; no paid API is required.
 */
export async function completeManagerMessage(args:{projectId:string;taskId:string;messageId:string;continuation?:string;handled?:boolean}):Promise<void>{
 const {projectId,taskId,messageId}=args;
 const msg=await pool.query(
  "SELECT id,role,body,status,reply_to,actor_id FROM manager_messages WHERE id=$1 AND project_id=$2 AND task_id=$3",
  [messageId,projectId,taskId]);
 if(!msg.rowCount||msg.rows[0].role!=='user')return;
 if(msg.rows[0].status==='completed'||msg.rows[0].status==='cancelled')return;
 const acquired=await pool.query("UPDATE manager_messages SET status='processing',updated_at=now() WHERE id=$1 AND status IN ('queued','processing','failed') RETURNING id",[messageId]);
 if(!acquired.rowCount)return;
 try{
  let answer=args.continuation||'';
  if(!args.handled){
   const snapshot=await managerSnapshot(pool,projectId,taskId);
   if(!snapshot)throw Error('Задача не найдена');
   const images=await readChatImages(pool,projectId,messageId,'manager');
   const settings=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]);
   if(!settings.rows[0]?.enabled)throw Error('AI отключён в настройках проекта');
   const rules=(await pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at DESC LIMIT 12',[projectId])).rows.map(x=>x.body).join('\n').slice(0,3000);
   const history=snapshot.messages.filter(m=>!['failed','cancelled'].includes(m.status)&&m.id!==messageId).slice(-16).map(m=>({role:m.role,content:String(m.body).slice(0,1200),images:m.images?.map((image:{name:string})=>image.name)}));
   const pending=snapshot.requests.filter(x=>x.status==='open').map(x=>({kind:x.kind,id:x.id,request:managerRequestSummary(x)}));
   const latest=snapshot.latestTest;
   const agentNotes=snapshot.internalNotes.slice(0,12).reverse().map(n=>({
    author:n.author_name,recipient:n.target_stage,kind:n.kind,
    note:String(n.body).slice(0,420),status:n.status
   }));
   const qaDetails=latest?JSON.stringify(latest.report??{}).slice(0,2100):'';
   const detailContext=[
    'Последний отчёт QA: '+qaDetails,
    'Недавние комментарии агентов: '+JSON.stringify(agentNotes).slice(0,1100),
    'Недавний диалог: '+JSON.stringify(history.slice(-4)).slice(0,450)
   ].join('\n');
   const replyTarget=snapshot.messages.find(m=>m.id===msg.rows[0].reply_to);
   const prompt=composeAgentPrompt({
    role:'Менеджер проекта в чате конкретной задачи',
    objective:String(msg.rows[0].body||'Изучи приложенные изображения').slice(0,4000),
    tools:'Открывай capabilities.list/describe для поиска разрешённых операций; tasks.read/history и processes.list — для фактов. При постоянных указаниях владельца управляй инструкциями через instructions.reconcile/propose с source_message_id. Не обходи QA, CI, слияние или согласования.',
    instructions:[PM_GOAL_POLICY,(await conversationInstructions(pool,projectId,'manager')).slice(0,1600),
     (await agentMemoryContext(pool,projectId,'manager',String(snapshot.task.title||'')+' '+String(snapshot.task.description||''))).slice(0,1600)].filter(Boolean).join('\n\n'),
    scope:JSON.stringify({task_id:taskId,source_message_id:messageId,title:snapshot.task.title,stage:snapshot.task.stage,description:String(snapshot.task.description||'').slice(0,1700),pr_url:snapshot.task.pr_url}),
    context:JSON.stringify({pending_requests:pending.slice(0,4),latest_qa:latest?{status:latest.status,verdict:latest.verdict}:null,images:images.map(image=>image.name)}).slice(0,500)+'\n'+detailContext,
    continuation:replyTarget?'Ответ на сообщение: '+String(replyTarget.body).slice(0,1000):'',
    output:'Отвечай по-русски с Markdown-абзацами и списками. Новые комментарии и ответы владельца анализируй относительно уже сделанной работы: если они влияют на неё, используй workflow.move_task для адресной доработки без повторной реализации; при сбое QA — qa.retry. Если задача ожидает требований, не заставляй владельца повторять уже данный ответ: используй tools для передачи сохранённого сообщения. При просьбе продвинуть задачу вызывай инструмент, сообщай подтверждённый результат или точную причину блокировки. QA blocked не равно passed. Очередь выкладки ещё не означает успешный деплой.'
   });
   const mentionedAgent=await resolveAgentMention(pool,projectId,String(msg.rows[0].body));
   const directPrompt=mentionedAgent?composeAgentPrompt({
    role:mentionedAgent.name+' — специалист этапа '+mentionedAgent.stage,
    objective:mentionedAgent.message||'Изучи приложенные изображения',
    tools:'Это ответ в чате задачи. Не утверждай о запуске кода или тестов без доказательств.',
    instructions:mentionedAgent.instructions.slice(0,2600),
    scope:JSON.stringify({task_id:taskId,title:snapshot.task.title,stage:snapshot.task.stage,description:String(snapshot.task.description||'').slice(0,2200)}),
    context:detailContext,
    continuation:replyTarget?'Ответ на сообщение: '+String(replyTarget.body).slice(0,800):'',
    output:'После ответа отдельной строкой добавь LEARNING_SUGGESTION: <подтверждённый урок> либо none.'
   }):prompt;
    const roleConfig=await resolveRoleAiSettings(pool,projectId,mentionedAgent?.stage||'manager',settings.rows[0]);
    const rawReply=String(mentionedAgent
     ?await askRunnerAssistant(directPrompt,projectId,taskId,'direct_'+mentionedAgent.stage,roleConfig,110000,images,{role:mentionedAgent.stage,processId:messageId,actorId:msg.rows[0].actor_id??undefined})
     :await askTaskManagerAgent(directPrompt,projectId,taskId,messageId,String(msg.rows[0].actor_id),roleConfig,images)).trim();
    const suggestion=mentionedAgent?rawReply.match(/LEARNING_SUGGESTION:\s*([^\n\r]{1,1600})/i)?.[1]?.trim():undefined;
    if(mentionedAgent)await recordAgentLearning(pool,{projectId,role:mentionedAgent.stage,runId:messageId,body:suggestion,evidence:'Прямой диалог в задаче '+taskId});
    const generated=rawReply.replace(/^LEARNING_SUGGESTION:.*$/gmi,'').trim();
   answer=mentionedAgent?'@'+mentionedAgent.alias+' · '+generated:[args.continuation,generated].filter(Boolean).join('\n\n');
  }
  answer=answer.slice(0,10000);
  if(!answer)throw Error('Менеджер проекта не сформировал ответ');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const done=await client.query("UPDATE manager_messages SET status='completed',updated_at=now() WHERE id=$1 AND status='processing' RETURNING id",[messageId]);
   if(done.rowCount)await client.query("INSERT INTO manager_messages(id,project_id,task_id,role,body,reply_to) VALUES($1,$2,$3,'manager',$4,$5)",[randomUUID(),projectId,taskId,answer,messageId]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }catch(error){
  await pool.query("UPDATE manager_messages SET status='failed',updated_at=now() WHERE id=$1 AND status IN ('queued','processing')",[messageId]);
  await event(projectId,messageId,'analysis','failed','Менеджер проекта не ответил: '+String(error).slice(0,300),'error');
  throw error;
 }
}
async function managerContinuation(args:{projectId:string;taskId:string;messageId:string},analysisActions:boolean):Promise<{message:string;handled:boolean}>{
 const apiUrl=process.env.ORCHESTRATOR_API_URL||'http://api:3001';
 let message:string;
 let handled=false;
 try{
  const response=await fetch(apiUrl+'/internal/manager/continue',{
   method:'POST',
   headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:JSON.stringify({...args,analysisActions}),
   signal:AbortSignal.timeout(220000)
  });
  const result=await response.json() as {message?:string;error?:string;handled?:boolean};
  handled=result.handled===true;
  message=response.ok?String(result.message||''):'Автоматическое продолжение пока невозможно. '+String(result.error||'API HTTP '+response.status);
 }catch{
  message='API недоступен. Проверь состояние задачи в Центре процессов.';
 }
 if(message)await event(args.projectId,args.messageId,'analysis','manager_continuation',message);
 return {message,handled};
}

export async function continueManagedTask(args:{projectId:string;taskId:string;messageId:string}):Promise<string>{
 return (await managerContinuation(args,false)).message;
}
export async function handleManagerTurn(args:{projectId:string;taskId:string;messageId:string}):Promise<{message:string;handled:boolean}>{
 return managerContinuation(args,true);
}

function managerRequestSummary(request:any){
 if(request.kind==='qa_visual'){
  const a=request.payload?.assessment;
  return {passed:a?.passed,total:a?.total,unverified:a?.unverified?.map((v:any)=>({title:v.title,evidence:v.evidence})).slice(0,12)};
 }
 return {summary:String(request.payload?.summary||request.payload?.question||'').slice(0,1000)};
}

/** Stable Temporal Activity export, delegated to the peer-question service. */
export const resolvePeerQuestions=createPeerQuestionResolution({
 pool,prEvidence,askRunnerAssistant,event
});


/** Generic task-scoped assignment execution: tools, not model prose, confirm effects. */
export async function delegatedWorkScope(assignmentId:string):Promise<{projectId:string}>{
 const r=await pool.query('SELECT project_id FROM agent_work_assignments WHERE id=$1',[assignmentId]);
 if(!r.rowCount)throw ApplicationFailure.nonRetryable('Поручение не найдено');
 return {projectId:r.rows[0].project_id};
}
export async function runDelegatedWork(assignmentId:string):Promise<void>{
 const r=await pool.query(`SELECT a.*,t.title,t.description AS task_description,t.stage,
  t.spec_version AS current_spec,p.agents_running
  FROM agent_work_assignments a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
  JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL
  WHERE a.id=$1 AND a.status='running'`,[assignmentId]);
 if(!r.rowCount)return;
 const item=r.rows[0];
 if(!item.agents_running||item.stage==='done'||item.spec_version!==item.current_spec){
  await finalizeWorkAttempt(pool,assignmentId,'Поручение потеряло актуальность или агенты проекта остановлены');
  return;
 }
 const config=(await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[item.project_id])).rows[0];
 if(!config?.enabled){
  await finalizeWorkAttempt(pool,assignmentId,'AI отключён в проекте');
  return;
 }
 const roleSettings=await resolveRoleAiSettings(pool,item.project_id,item.role,config);
 const instruction=await pool.query(`SELECT agent_instructions FROM workflow_stages
   WHERE project_id=$1 AND stage=$2
   UNION ALL SELECT agent_instructions FROM project_specialist_agents
   WHERE project_id=$1 AND role=$2 LIMIT 1`,[item.project_id,item.role]);
 const prompt=composeAgentPrompt({
  role:'Исполнитель поручения: '+item.role,
  objective:item.objective,
  scope:'Проект '+item.project_id+'; задача '+item.task_id+'; поручение '+assignmentId,
  tools:'Используй MCP capabilities.list/describe, agents.capabilities, tasks.read/history, project.source, agents.consult, work.delegate и реальные доступные инструменты. Никаких вымышленных скриншотов, тестов, PR и деплоя.',
  instructions:String(instruction.rows[0]?.agent_instructions||''),
  continuation:[
   'Критерии приёмки: '+item.acceptance,
   'Дополнительные права именно этого поручения: '+JSON.stringify(item.granted_tools||[])+'. Они не гарантируют наличие внешней среды; проверяй результат инструментом.',
   'ТЗ и задача: '+item.title+'; '+String(item.task_description).slice(0,5000),
   'Ищи доступные инструменты и зависимости по смыслу результата, не по названию задачи.',
   'Если недостаёт безопасного инструмента, отчитайся work.report(status=blocked) и назови точное имя из agents.capabilities: ПМ может выдать право через work.grant, не создавая новую задачу.',
   'Если нужны действия другого специалиста, используй work.delegate и сообщи о зависимости через work.report(status=blocked); не выдавай ожидание за завершение.',
   'После реальных действий зафиксируй результат и конкретные ссылки/ID/артефакты инструментом work.report(status=submitted,evidence=...).',
   'Если фактические доказательства отсутствуют, вызови work.report(status=blocked) с причиной и необходимыми условиями.',
   'Только успешное применение work.report является статусом поручения. Простой текст ответа не завершает поручение.'
  ].join('\\n'),
  output:'Кратко объясни выполненные действия и фактические результаты; обязательно вызови work.report через MCP. Не утверждай успех без подтверждения инструмента.'
 });
 await recordAgentPrompt(pool,{projectId:item.project_id,processId:assignmentId,role:item.role,operation:'delegated_work',prompt}).catch(()=>{});
 try{
  const output=await askRunnerAssistant(prompt,item.project_id,item.task_id,'delegated_work',roleSettings,195000,[],
   {role:item.role,processId:assignmentId});
  // A message is not evidence of execution; only the scoped work.report tool moves status.
  await finalizeWorkAttempt(pool,assignmentId,'Агент завершил сессию без подтверждённого результата через work.report. '+String(output).slice(0,850));
 }catch(error){
  await finalizeWorkAttempt(pool,assignmentId,'Сбой исполнителя: '+String(error).slice(0,1200));
 }
}
export async function failDelegatedWork(assignmentId:string,message:string){
 await finalizeWorkAttempt(pool,assignmentId,'Ошибка Temporal: '+message);
}

export async function runPeerQuestionWork(noteId:string):Promise<void>{
 const q=await pool.query("SELECT project_id,task_id FROM agent_peer_queue WHERE note_id=$1 AND status='running'",[noteId]);
 if(!q.rowCount)return;
 try{
  await resolvePeerQuestions({projectId:q.rows[0].project_id,taskId:q.rows[0].task_id,noteId});
  await markPeerWorkResult(pool,noteId,null);
 }catch(error){await markPeerWorkResult(pool,noteId,String(error));throw error;}
}
export async function failPeerQuestionWork(noteId:string,message:string):Promise<void>{
 await markPeerWorkResult(pool,noteId,message);
}

export async function runProjectSpecification(jobId:string):Promise<void>{
 const service=createAssistantService({pool,codexUrl,runnerKey,decryptToken:decrypt});
 const timer=setInterval(()=>heartbeat(),10000);
 try{
  heartbeat();
  await service.runDocumentationJob(jobId);
 }finally{clearInterval(timer);}
}

export async function failProjectSpecification(jobId:string):Promise<void>{
 const result=await pool.query("UPDATE document_import_jobs SET status='failed',message='Процесс аналитика прерван. Повтори запрос в чате.',updated_at=now() WHERE id=$1 AND status='running' RETURNING project_id",[jobId]);
 if(result.rowCount)await event(result.rows[0].project_id,jobId,'document_import','failed','Процесс аналитика прерван','error');
}

export async function finishEvidenceTask(args:{
 projectId:string;taskId:string;runId:string;status:'completed'|'blocked'|'failed';message:string
 }){
 return finishTaskEvidenceRun(pool,args);
}
export async function runSelfHostedQualityGates(args:{projectId:string;taskId:string;runId:string}){
 const timer=setInterval(()=>heartbeat(),12000);
 try{
  heartbeat();
  return await runQualityGates(pool,args,decrypt,codexUrl,runnerKey,()=>heartbeat());
 }finally{clearInterval(timer);}
}
/** Rework only findings from the failing SHA, preserving PR, history and prior completed work. */
export async function scheduleQualityFix(args:{projectId:string;taskId:string;cycleId:string;attempt:number;message:string}){
 const message=args.message.slice(0,9500);
 await pool.query("UPDATE tasks SET stage='development',test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2",
  [args.taskId,args.projectId,'Замечания CI / архитектора по текущему PR:\n'+message]);
 await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'quality_review_failed',$3)",
  [randomUUID(),args.taskId,message.slice(0,2200)]);
 await event(args.projectId,args.cycleId,'architecture_review','retry_development',message,'warning');
 return scheduleRequirementFix(args);
}
export async function runAutomaticDeployment(runId:string){
 const interval=setInterval(()=>heartbeat(),10000);
 try{heartbeat();await performAutomaticDeployment(pool,runId,decrypt);}finally{clearInterval(interval);}
}
export async function failAutomaticDeployment(runId:string,message:string){await markDeploymentFailed(pool,runId,message);}

/** Each durable PM message is an independently scheduled Temporal activity. */
export async function runProjectManagerInbox(projectId:string,messageId:string,attempt?:number):Promise<ProjectManagerWatch[]>{
 try{return await executeProjectManagerInbox(pool,projectId,messageId,codexUrl,runnerKey,attempt);}
 catch(error){
  if((error as {nonRetryable?:boolean})?.nonRetryable)throw ApplicationFailure.nonRetryable((error as Error).message);
  throw error;
 }
}
export async function markProjectManagerInboxFailed(projectId:string,messageId:string,attempt:number){
 await failProjectManagerInbox(pool,projectId,messageId,attempt);
}
export async function readProjectManagerWatch(watch:ProjectManagerWatch):Promise<{status:'pending'|'completed';messageId?:string}>{
 return readProjectManagerWatchResume(pool,watch);
}

const {mergeTaskPr}=createMergeService(pool,decrypt);
/** Preserve all existing Temporal Activity names and return contracts. */
export const {pendingMergeTasks,tryMergeBatchTask,pollMergeConflict,recordMergeBatchResult,completeMergeBatch}=
 createMergeBatchActivities({pool,decrypt,runner,dispatch,mergeTaskPr});

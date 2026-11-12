import {preserveAcceptanceCriteria} from './acceptance-criteria.js';
import {type AgentReaderScope} from './agent-tools.js';
import {composeAgentPrompt,recordAgentPrompt} from './agent-prompt.js';
import {createAgentSession,finishAgentSession} from './agent-tools.js';
import {readChatImages,type RunnerImage} from './chat-images.js';
import {workflowResponsibility} from './workflow-responsibilities.js';
import {runnerAssistantPrompt} from './runner-assistant-prompt.js';
import {heartbeat} from '@temporalio/activity';
import {createAssistantService} from './assistant.js';
import {executeProjectManagerInbox,failProjectManagerInbox,readProjectManagerWatchResume,type ProjectManagerWatch} from './project-manager-inbox.js';
import {runIterationPlanning} from './project-iterations.js';
import {performAutomaticDeployment,failAutomaticDeployment as markDeploymentFailed} from './deployment-automation.js';
import pg from 'pg';
import {randomUUID,createDecipheriv,createHash} from 'node:crypto';
import {createMergeService} from './merge-service.js';
import {finishMergeBatch,loadMergeBatch,saveMergeResult,setMergeProgress,type MergeResult} from './merge-batch.js';
import {ApplicationFailure} from '@temporalio/common';
import {prepareQaDocumentation,readQaPlan} from './qa-plan.js';
import {reconcileTaskRequirements,requirementState} from './requirements.js';
import {releaseTaskOrchestration} from './task-orchestration.js';
import {recordTaskAgentNote,taskNotesContext,taskConversationEvidence,pendingAgentQuestions,resolveAgentQuestionsForReview} from './task-agent-notes.js';
import {readTaskWorkBrief} from './task-work-brief.js';
import {managerSnapshot,syncManagerInbox} from './project-manager.js';
import {resolveAgentMention,AGENT_MENTION_HINT} from './agent-mentions.js';
import {recordAgentActivity} from './task-agent-activity.js';
import {markPeerWorkResult} from './agent-peer-queue.js';
import {updateCurrentSpecification} from './requirements.js';
import {z} from 'zod';
import {checkedWithActualCapabilities} from './qa-evidence.js';
import {buildKnowledgeContext,type KnowledgeStage} from './knowledge-workflow.js';
import {agentMemoryContext,conversationInstructions,recordAgentLearning,resolveRoleAiSettings,roleCapacity} from './project-team.js';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const codexUrl=process.env.CODEX_RUNNER_URL||'http://codex:4300';
const runnerKey=process.env.RUNNER_SHARED_SECRET||'';

function decrypt(packed:string):string{
 const key=Buffer.from(process.env.CREDENTIALS_KEY||'','hex');
 if(key.length!==32)throw Error('CREDENTIALS_KEY must contain 32 bytes');
 const bytes=Buffer.from(packed,'base64');
 const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 d.setAuthTag(bytes.subarray(12,28));
 return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');
}
async function runner(path:string,method:'GET'|'POST'='GET',body?:unknown):Promise<any>{
 const response=await fetch(codexUrl+path,{method,headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
  body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const data=await response.json().catch(()=>({})) as any;
 if(!response.ok){
  const error=Object.assign(new Error(String(data.error||'Codex runner error')),{statusCode:response.status});
  throw error;
 }
 return data;
}
function runnerUnavailable(error:unknown){
 const status=(error as {statusCode?:number})?.statusCode;
 if(status&&status<500)throw error;
 return {status:'running' as const,message:'Ожидается восстановление связи с Codex Runner'};
}
async function trackRunnerWait(kind:'development'|'testing',projectId:string,id:string,error?:unknown,recoveryDetail?:string){
 const status=(error as {statusCode?:number})?.statusCode;
 if(status&&status<500)return failRunnerRun(kind,projectId,id,(error as Error).message);
 const message=error?'Ожидается восстановление связи с Codex Runner':
  recoveryDetail?recoveryDetail.slice(0,1200):'Восстанавливается задание в Codex Runner';
 const table=kind==='development'?'ai_task_runs':'ai_test_runs';
 const change=await pool.query(`UPDATE ${table} SET message=$2
  WHERE id=$1 AND status IN ('queued','running') AND message IS DISTINCT FROM $2 RETURNING id`,[id,message]);
 if(change.rowCount)await event(projectId,id,kind,'runner_recovery',message);
 return {status:'running',message};
}
async function failRunnerRun(kind:'development'|'testing',projectId:string,id:string,message:string){
 const table=kind==='development'?'ai_task_runs':'ai_test_runs';
 await pool.query(`UPDATE ${table} SET status='failed',message=$2,completed_at=now() WHERE id=$1 AND status IN ('queued','running')`,[id,message]);
 await event(projectId,id,kind,'failed',message,'error');
 return {status:'failed',message};
}
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
 const agentSettings=await Promise.all(workflow.rows.map(async row=>({...row,agent_instructions:String(row.agent_instructions||'')+'\n\nНакопленный опыт и утверждённые дополнения:\n'+await agentMemoryContext(pool,projectId,row.stage)})));
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
  tools:'Поиск и чтение проектных знаний; итог верни в запрошенном структурированном формате.',
  scope:'Проект '+projectId+', задача '+taskId,
  context:knowledge.documents.slice(0,1300)+'\n'+knowledge.modules.slice(0,850)
 });
 await recordAgentPrompt(pool,{projectId,processId:processId||taskId,role:stage,operation,prompt:composed}).catch(()=>{});
 return askRunnerAssistant(composed,projectId,taskId,operation,await resolveRoleAiSettings(pool,projectId,stage,ai),110000,[],{role:stage,processId});
}
async function askTaskManagerAgent(prompt:string,projectId:string,taskId:string,messageId:string,actorId:string,
 ai:{model:string;reasoning:string},images:RunnerImage[]):Promise<string>{
 const session=await createAgentSession(pool,projectId,actorId,'manager');
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
const taskAnalysisResult=z.object({
 outcome:z.enum(['ready','needs_input']),
 summary:z.string().trim().min(8).max(1500),
 refined_description:z.string().trim().min(20).max(16000),
 questions:z.array(z.string().trim().min(5).max(650)).max(8).default([]),
 documentation_notes:z.array(z.string().trim().min(5).max(1000)).max(5).default([])
}).strict();
function parseTaskAnalysisResult(text:string){
 const cleaned=text.trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
 const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');
 if(start<0||end<start)throw Error('Аналитик не вернул структурированный результат');
 return taskAnalysisResult.parse(JSON.parse(cleaned.slice(start,end+1)));
}
/** A worker-owned task is analyzed once until it reaches an explicit result.
 * The analyst can hand off an approved specification without PM micromanagement.
 */
export async function runTaskStageAnalysis(runId:string):Promise<void>{
 const run=(await pool.query("SELECT id,project_id,task_id,spec_version,status FROM agent_analysis_runs WHERE id=$1",[runId])).rows[0];
 if(!run||['completed','waiting','failed','cancelled'].includes(run.status))return;
 const active=await pool.query("UPDATE agent_analysis_runs SET status='running',updated_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING id",[runId]);
 if(!active.rowCount)return;
 const {project_id:projectId,task_id:taskId}=run;
 try{
  const [record,history,ownerEvidence]=await Promise.all([
   pool.query("SELECT id,project_id,title,description,stage,analysis_state,clarification_questions,spec_review_status,spec_version,iteration_work_kind FROM tasks WHERE project_id=$1 AND id=$2",[projectId,taskId]),
   taskHandoffContext(projectId,taskId,'analysis'),
   pool.query(`SELECT kind,body,answer,answer_author FROM task_agent_notes
    WHERE project_id=$1 AND task_id=$2 AND
     ((kind='resolution' AND source_key LIKE 'owner-answer:%') OR
      (kind='question' AND status='answered' AND answer IS NOT NULL))
    ORDER BY created_at DESC LIMIT 10`,[projectId,taskId])
  ]);
  const task=record.rows[0];
  if(!task||task.stage!=='analysis'||task.spec_version!==run.spec_version||task.analysis_state!=='processing'){
   await pool.query("UPDATE agent_analysis_runs SET status='completed',message='Состояние задачи изменилось, старая работа пропущена',updated_at=now() WHERE id=$1",[runId]);
   return;
  }
  const instructions=(await pool.query("SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage='analysis'",[projectId])).rows[0];
  const prompt=[
   'Ты системный аналитик проекта. Задача находится в колонке «Анализ», и ты обязан закончить работу над ней.',
   'Уточни содержание именно задачи, используя документацию как справочный контекст. Не редактируй страницы проектного ТЗ, не ставь завершение документации условием разработки. Не придумывай продуктовые решения вместо владельца.',
   'Если обнаружено противоречие со старым ТЗ, укажи его в documentation_notes как неблокирующее замечание для будущего обновления документации. Продолжай работу по ясной задаче и решениям владельца. Вопрос задавай только когда без ответа невозможно однозначно определить реализацию.',
   'Если описание достаточно для разработки, верни outcome="ready", уточнённые требования и критерии именно этой задачи в refined_description, затем коротко передай её разработчику. Сохраняй все действующие критерии приёмки из постановки; не повторяй одинаковые критерии.',
   'Если без решения владельца реализация неоднозначна, верни outcome="needs_input" и действительно блокирующие вопросы. Каждый вопрос сформулируй кратко и простыми словами. Полное уточнение задачи сохрани в refined_description, а в summary объясни результат в 1–3 предложениях.',
   'Не создавай новый функционал за пределами согласованного объёма. Если outcome="ready", questions должен быть пустым. Если needs_input, вопросы обязательны.',
   'Ответь ТОЛЬКО JSON: {"outcome":"ready|needs_input","summary":"...","refined_description":"...","questions":["..."],"documentation_notes":["неблокирующее расхождение или рекомендация"]}.',
   'Инструкции агента: '+String(instructions?.agent_instructions||'').slice(0,6000),
   'Задача: '+task.title+'\n'+task.description,
   'Последние сообщения и выполненная работа (новые вводные приоритетнее старых): '+history.slice(0,3100),
   'ПОДТВЕРЖДЁННЫЕ ОТВЕТЫ ВЛАДЕЛЬЦА ИЗ КАРТОЧКИ (используй их в первую очередь; не спрашивай повторно): '+JSON.stringify(ownerEvidence.rows.reverse().map((r:{kind:string;body:string;answer:string|null;answer_author:string|null})=>({question:r.kind==='question'?r.body:null,answer:r.answer||r.body,source:r.answer_author||'Владелец'}))).slice(0,3200),
   'Если сохранённый ответ относится к ранее заданному вопросу, проверь, достаточно ли его для выполнения. При полноте ответов верни ready; при реальной неоднозначности задай только недостающий вопрос.'
  ].join('\n\n');
  const output=parseTaskAnalysisResult(await assistantCompletion(prompt,projectId,taskId,'task_analysis',runId));
  if(output.outcome==='ready'&&output.questions.length)throw Error('Аналитик завершил задачу с неразрешёнными вопросами');
  if(output.outcome==='needs_input'&&!output.questions.length)throw Error('Аналитик запросил уточнение без вопроса');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const stillActive=await client.query("SELECT status FROM agent_analysis_runs WHERE id=$1 FOR UPDATE",[runId]);
   const latest=(await client.query("SELECT * FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE",[projectId,taskId])).rows[0];
   if(stillActive.rows[0]?.status==='cancelled'||!latest||latest.stage!=='analysis'||latest.analysis_state!=='processing'||(latest.title!==task.title||latest.description!==task.description)){
    await client.query("UPDATE agent_analysis_runs SET status='completed',message='Задача изменилась до сохранения результата',updated_at=now() WHERE id=$1 AND status<>'cancelled'",[runId]);
    await client.query('COMMIT');return;
   }
   if(output.outcome==='ready'){
    await updateCurrentSpecification(client,projectId,taskId,latest.title,preserveAcceptanceCriteria(latest.description,output.refined_description));
    const questions=await client.query("SELECT 1 FROM task_agent_notes WHERE task_id=$1 AND kind='question' AND status IN ('open','processing') LIMIT 1",[taskId]);
    if(questions.rowCount||latest.clarification_questions?.length){
     await client.query("UPDATE tasks SET analysis_state='waiting_questions',updated_at=now() WHERE id=$1",[taskId]);
    }else{
     await client.query("UPDATE tasks SET analysis_state='ready_for_development',updated_at=now() WHERE id=$1",[taskId]);
     await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_completed',$3)",[randomUUID(),taskId,output.summary]);
    }
    await client.query("INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status) VALUES($1,$2,$3,'analysis',$4,'development','handoff',$5,'agent',$6,'resolved') ON CONFLICT(task_id,source_key) DO NOTHING",
     [randomUUID(),projectId,taskId,instructions?.agent_name||'Системный аналитик',output.summary,'task-analysis:'+runId]);
   }else{
    await client.query("UPDATE tasks SET analysis_state='waiting_questions',updated_at=now() WHERE id=$1",[taskId]);
    for(let index=0;index<output.questions.length;index++){
     await client.query("INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status,requires_customer) VALUES($1,$2,$3,'analysis',$4,'all','question',$5,'agent',$6,'open',true) ON CONFLICT(task_id,source_key) DO NOTHING",
      [randomUUID(),projectId,taskId,instructions?.agent_name||'Системный аналитик',output.questions[index],'task-analysis:'+runId+':question:'+index]);
    }
    await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_blocked',$3)",[randomUUID(),taskId,'Аналитик запросил решения: '+output.questions.join('; ').slice(0,1200)]);
   }
   for(const [index,note] of output.documentation_notes.entries()){
    await client.query("INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,status) VALUES($1,$2,$3,'analysis',$4,'documentation','observation',$5,'agent',$6,'resolved') ON CONFLICT(task_id,source_key) DO NOTHING",
     [randomUUID(),projectId,taskId,instructions?.agent_name||'Системный аналитик',note,'task-analysis:'+runId+':doc-note:'+index]);
   }
   await client.query("UPDATE agent_analysis_runs SET status=$2,message=$3,updated_at=now() WHERE id=$1",[runId,output.outcome==='ready'?'completed':'waiting',output.summary]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await event(projectId,runId,'analysis',output.outcome==='ready'?'completed':'waiting',output.summary);
 }catch(error){
  const message=String(error).slice(0,650);
  await pool.query("UPDATE agent_analysis_runs SET status='failed',message=$2,updated_at=now() WHERE id=$1 AND status IN ('queued','running')",[runId,message]);
  await pool.query("UPDATE tasks SET analysis_state='failed',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='analysis' AND analysis_state='processing' AND spec_version=$3 AND EXISTS(SELECT 1 FROM agent_analysis_runs WHERE id=$4 AND status='failed')",[taskId,projectId,run.spec_version,runId]);
  await event(projectId,runId,'analysis','failed',message,'error');
 }
}

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
async function prEvidence(projectId:string,taskId:string):Promise<{commitSha:string;patch:string;summary:string}>{
 const task=await pool.query('SELECT pr_number,git_branch FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]);
 if(!task.rowCount)throw Error('Задача не найдена');
 if(!task.rows[0].pr_number)return {commitSha:'',patch:'PR ещё не создан',summary:''};
 const gh=await pool.query("SELECT g.repository,c.secret_encrypted FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.provider='github_token'",[projectId]);
 if(!gh.rowCount)throw Error('GitHub-подключение для анализа PR не найдено');
 const repository=gh.rows[0].repository,token=decrypt(gh.rows[0].secret_encrypted);
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const base='https://api.github.com/repos/'+repository+'/pulls/'+task.rows[0].pr_number;
 const [prResponse,filesResponse]=await Promise.all([
  fetch(base,{headers,signal:AbortSignal.timeout(20000)}),
  fetch(base+'/files?per_page=65',{headers,signal:AbortSignal.timeout(20000)})
 ]);
 if(!prResponse.ok||!filesResponse.ok)throw Error('Не удалось прочитать актуальные изменения PR в GitHub для сверки требований');
 const pr=await prResponse.json() as any,files=await filesResponse.json() as any[];
 if(!Array.isArray(files))throw Error('Некорректный ответ GitHub о файлах PR');
 const patch=files.map(file=>file.filename+' ('+file.status+')\n'+String(file.patch||'[diff недоступен]').slice(0,3800)).join('\n\n').slice(0,16500);
 return {commitSha:String(pr.head?.sha||''),patch:patch||'Нет текстовых изменений',summary:String(pr.body||'').slice(0,2000)};
}

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

export async function prepareQaPlan(args:{projectId:string;taskId:string;runId:string;simplified?:boolean}):Promise<number>{
 const {projectId,taskId,runId}=args;
 const settings=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]);
 const ai=settings.rows[0];
 if(!ai?.enabled)throw ApplicationFailure.nonRetryable('AI отключён для проекта');
 await pool.query("UPDATE requirement_review_runs SET status='running',message='QA-агент формирует тест-кейсы',completed_at=NULL WHERE id=$1 AND project_id=$2",[runId,projectId]);
 await event(projectId,runId,'testing','test_design_started','AI-тестировщик формирует тесты по актуализированному ТЗ перед проверкой PR');
 await recordAgentActivity(pool,projectId,[taskId],runId,'qa_design','running','Тестировщик готовит сценарии проверки.');
 try{
  if(!args.simplified&&await pendingAgentQuestions(pool,projectId,taskId))throw new Error('Нельзя готовить тестирование: вопросы участников процесса остались без ответа');
  const evidence=await prEvidence(projectId,taskId);
  if(!evidence.commitSha)throw new Error('Нет коммита PR для тестирования');
  if(args.simplified){
   await pool.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note='' WHERE id=$1 AND project_id=$2 AND stage='testing'",[taskId,projectId,evidence.commitSha]);
  }else{
   const current=await pool.query("SELECT spec_reviewed_commit,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2",[taskId,projectId]);
   if(current.rows[0]?.spec_review_status!=='current'||current.rows[0].spec_reviewed_commit!==evidence.commitSha)
    throw new Error('Код PR изменился после сверки аналитиком. Требуется повторная проверка требований.');
  }
  const qaKnowledge=formatWorkflowKnowledge(await stageContext(projectId,taskId,'testing',runId));
  const handoff=await taskHandoffContext(projectId,taskId,'testing');
  const count=await prepareQaDocumentation(pool,{...args,implementationEvidence:evidence.patch},async(prompt)=>{
   const taskContext='\n\nПеред вопросом о требованиях проверь ответы в задаче. Переписка не подтверждает прохождение теста.\n'+handoff;
   const bounded=composeAgentPrompt({
    role:'QA-инженер — проектирование проверок',
    objective:prompt,
    tools:'Только составление тест-кейсов; выполнение тестов позже выполняет Codex в изолированном runner.',
    context:taskContext.slice(0,2300)+'\n'+qaKnowledge.documents.slice(0,700),
    instructions:qaKnowledge.modules.slice(0,900)
   });
   await recordAgentPrompt(pool,{projectId,processId:runId,role:'testing',operation:'qa_plan',prompt:bounded}).catch(()=>{});
   return askRunnerAssistant(bounded,projectId,taskId,'qa_plan',
    await resolveRoleAiSettings(pool,projectId,'testing',ai),105000,[],{role:'testing',processId:runId});
  });
  // Derived links attach the actual current QA plan to the requirements governing the task.
  await pool.query("INSERT INTO knowledge_artifact_links(id,project_id,document_id,artifact_kind,artifact_ref,relation) SELECT gen_random_uuid(),$1,l.document_id,'qa_case',pc.case_id::text,'tested_by' FROM knowledge_task_links l JOIN qa_test_plans p ON p.project_id=l.project_id AND p.task_id=l.task_id JOIN qa_plan_cases pc ON pc.plan_id=p.id WHERE l.project_id=$1 AND l.task_id=$2 AND l.relation IN ('requires','implements','tests') ON CONFLICT DO NOTHING",[projectId,taskId]);
  await pool.query("UPDATE requirement_review_runs SET status='completed',message=$2,completed_at=now() WHERE id=$1 AND project_id=$3",[runId,'QA-документация подготовлена: '+count+' проверок',projectId]);
  await recordTaskAgentNote(pool,{projectId,taskId,authorStage:'testing',authorName:'AI-тестировщик',targetStage:'all',kind:'observation',body:'Подготовлен план тестирования по актуальному ТЗ: '+count+' проверок. Фактические результаты будут записаны после выполнения, это не подтверждение прохождения тестов.',sourceKey:'test-plan:'+runId,sourceRunId:runId});
  await event(projectId,runId,'testing','test_design_ready','QA-документация подготовлена: '+count+' проверок');
  await recordAgentActivity(pool,projectId,[taskId],runId,'qa_design','completed','Подготовлено проверок: '+count+'.');
  return count;
 }catch(e){
  await pool.query("UPDATE requirement_review_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1 AND project_id=$3",[runId,String(e).slice(0,1800),projectId]);
  await event(projectId,runId,'testing','test_design_failed',String(e).slice(0,1900),'error');
  await recordAgentActivity(pool,projectId,[taskId],runId,'qa_design','failed',String(e));
  throw e;
 }
}

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
 const previous=(Array.isArray(existing.data)?existing.data:[]).find((pr:any)=>pr.base?.ref===baseBranch);
 let pr=previous;
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
 const feedback=String(task.test_feedback||'').slice(0,3800);
 if(task.spec_review_status==='pending'||task.spec_review_status==='needs_approval')throw ApplicationFailure.nonRetryable('Требования ожидают проверки аналитиком или согласования');
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
 const agentPrompt=composeAgentPrompt({
  role:String(agentSettings.find((s:any)=>s.stage==='development')?.agent_name||'AI-разработчик'),
  objective:task.title+'\n'+description,
  tools:'Локальная рабочая копия GitHub, терминал и файловые операции. Сначала изучи код. За commit, push и PR отвечает оркестратор.',
  instructions:agentInstructions,
  scope:'Репозиторий '+repo.repository+', базовая ветка '+baseBranch+'; задача '+taskId,
  context:'Продолжение задачи и новые комментарии:\n'+(await taskHandoffContext(projectId,taskId,'development')).slice(0,2400)+'\nПравила: '+rules.slice(0,500)+'\nДокументация: '+knowledge.documents.slice(0,650),
  output:'При первом запуске реализуй задачу. При возврате используй существующую ветку, PR, результаты тестов и все новые комментарии; исправь только недоделанное или изменившиеся требования. Не создавай ту же функциональность с нуля. Передай краткое HANDOFF_NOTE и LEARNING_SUGGESTION.'
 });
 const job={id:runId,taskId,projectId,actorId:record.rows[0].triggered_by,roleCapacity:await roleCapacity(pool,projectId,'development'),repository:repo.repository,baseBranch,token,
  model:developerAi.model,reasoning:developerAi.reasoning,maxRuntimeSeconds:1800,
  title:task.title,description,agentPrompt,projectRules:'',relatedTasks:[],knowledgeContext:'',handoffContext:'',agentName:'',agentInstructions:''};
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
  if(status==='completed'&&!remote.prUrl){
   const msg='Разработка завершилась без PR; передавать в тестирование нечего';
   await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,msg]);
   return {status:'failed',message:msg};
  }
  if(remote.usage){
   const u=remote.usage;
   await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,'development',$5,$6,$7,$8) ON CONFLICT(source_id) DO NOTHING",
    [randomUUID(),projectId,taskId,runId,run.rows[0].model,Number(u.input_tokens)||0,Number(u.cached_input_tokens)||0,Number(u.output_tokens)||0]);
  }
  if(status==='completed'){
    await recordAgentLearning(pool,{projectId,role:'development',runId,body:remote.learningSuggestion,evidence:'Запуск разработки '+runId+'; '+String(remote.prUrl||'')});
   if(String(remote.handoffNote||'').trim())await recordTaskAgentNote(pool,{projectId,taskId,authorStage:'development',authorName:'AI-разработчик',targetStage:'all',kind:'handoff',body:String(remote.handoffNote),sourceKey:'developer:'+runId,sourceRunId:runId});
  }
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const saved=await db.query(`UPDATE ai_task_runs SET status=$2,message=$3,branch=$4,pr_url=$5,completed_at=now()
    WHERE id=$1 AND status IN ('queued','running') RETURNING id`,
   [runId,status,message,remote.branch||null,remote.prUrl||null]);
   if(!saved.rowCount){
    await db.query('ROLLBACK');
    return {status:'failed',message:'Попытка уже завершена или отменена'};
   }
   if(status==='completed'){
    const match=/\/pull\/(\d+)$/.exec(String(remote.prUrl));
    await db.query("INSERT INTO knowledge_artifact_links(id,project_id,document_id,artifact_kind,artifact_ref,relation) SELECT gen_random_uuid(),$1,l.document_id,'pr',$3,'implemented_by' FROM knowledge_task_links l WHERE l.project_id=$1 AND l.task_id=$2 ON CONFLICT DO NOTHING",
     [projectId,taskId,String(remote.prUrl)]);
    await db.query("UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$5,updated_at=now() WHERE id=$1 AND project_id=$6",
     [taskId,remote.branch||taskId,remote.prUrl,match?Number(match[1]):null,remote.baseBranch||null,projectId]);
   }
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  await event(projectId,runId,'development',status==='completed'?'testing':status,message,status==='failed'?'error':'info');
 }
 return {status,message};
}
export async function startTesting(args:{projectId:string;taskId:string;cycleId:string;attempt:number;recovery?:boolean;simplified?:boolean;singlePass?:boolean}):Promise<string>{
 const {projectId,taskId,cycleId,attempt}=args;
 const {task,repo,ai,token,rules,agentSettings}=await jobSettings(projectId,taskId);
 if(!args.simplified&&await pendingAgentQuestions(pool,projectId,taskId))throw ApplicationFailure.nonRetryable('У задачи есть вопросы, на которые необходимо ответить перед тестированием');
 if(!task.pr_url||!task.git_branch)throw ApplicationFailure.nonRetryable('Нет PR или ветки для тестирования');
 const existing=await pool.query('SELECT id,status FROM ai_test_runs WHERE cycle_id=$1 AND attempt=$2',[cycleId,attempt]);
 if(!existing.rowCount){
  const storedPlan=await readQaPlan(pool,projectId,taskId);
  const testPlan=storedPlan?.cases.length&&storedPlan.spec_version===task.spec_version?storedPlan:null;
  if(!args.singlePass&&!testPlan)throw ApplicationFailure.nonRetryable('QA-план устарел относительно актуальной версии ТЗ');
  if(!args.simplified){
   const stale=await pool.query("SELECT count(*)::int AS total FROM qa_plan_cases pc JOIN qa_test_cases c ON c.id=pc.case_id JOIN qa_test_plans p ON p.id=pc.plan_id WHERE p.project_id=$1 AND p.task_id=$2 AND c.status<>'active'",[projectId,taskId]);
   if(stale.rows[0].total>0)throw ApplicationFailure.nonRetryable('Тест-кейсы требуют ручного пересмотра');
  }
  const snapshot={...(testPlan??{cases:[]}),...(args.simplified?{simplified:true}:{}),...(args.singlePass?{singlePass:true,adHoc:!testPlan}:{})};
  let commit=task.spec_reviewed_commit;
  if(args.singlePass){
   const pr=await fetch('https://api.github.com/repos/'+repo.repository+'/pulls/'+task.pr_number,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
    signal:AbortSignal.timeout(20000)
   });
   if(!pr.ok)throw Error('Не удалось прочитать PR перед QA: GitHub HTTP '+pr.status);
   const head=await pr.json() as any;
   if(head.state!=='open'||head.head?.ref!==task.git_branch||!/^[0-9a-f]{40}$/i.test(String(head.head?.sha||'')))
    throw ApplicationFailure.nonRetryable('Не удалось подтвердить открытую ветку PR для QA');
   commit=head.head.sha;
  }else if(task.spec_review_status!=='current'||task.spec_reviewed_version!==task.spec_version){
   throw ApplicationFailure.nonRetryable('ТЗ изменилось: требуется повторная сверка аналитиком');
  }
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   if(args.singlePass){
    const pinned=await client.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note='' WHERE id=$1 AND project_id=$2 AND stage='testing' AND spec_version=$4 AND git_branch=$5 AND pr_number=$6",
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
 const qaPrompt=composeAgentPrompt({
  role:String(agentSettings.find((s:any)=>s.stage==='testing')?.agent_name||'AI-тестировщик'),
  objective:'Независимо проверь задачу: '+task.title+'\n'+String(task.description||'').slice(0,6500),
  tools:'Изолированная копия репозитория, команды npm/pytest/API и локальный HTTP-сервер. Если браузера нет, визуальные проверки помечай blocked, не выдумывай результаты.',
  instructions:(agentSettings.find((s:any)=>s.stage==='testing')?.agent_instructions||'')+'\n'+knowledge.modules,
  scope:'Репозиторий '+repo.repository+', задача '+taskId+', проверяемый commit '+String(task.spec_reviewed_commit||''),
  context:'История, новая обратная связь, предыдущие QA:\n'+(await taskHandoffContext(projectId,taskId,'testing')).slice(0,2400)+'\nПравила: '+rules.slice(0,500)+'\nДокументация: '+knowledge.documents.slice(0,650),
  output:'Сначала изучи результаты предыдущего QA и новые комментарии. Повторно проверь только необходимые затронутые кейсы, но не признавай устаревшие результаты действительными для другого commit SHA. Невыполненные проверки всегда blocked/not_run, не passed.'
 });
 await dispatch({id,kind:'test',taskId,projectId,roleCapacity:await roleCapacity(pool,projectId,'testing'),repository:repo.repository,baseBranch:task.pr_base_branch||repo.target_branch||repo.default_branch,
  token,model:(await resolveRoleAiSettings(pool,projectId,'testing',ai)).model,reasoning:ai.reasoning,maxRuntimeSeconds:900,
  title:task.title,description:task.description,agentPrompt:qaPrompt,projectRules:'',testPlan:record.qa_plan_snapshot,
  expectedCommit:record.runner_commit_sha,branch:task.git_branch,knowledgeContext:'',handoffContext:'',agentName:'',agentInstructions:''});
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
  const adHoc=snapshot?.singlePass===true&&snapshot.adHoc===true;
  const expected=adHoc?z.array(z.object({id:z.string().regex(/^qa-[1-9][0-9]?$/),title:z.string().trim().min(3).max(240)})).max(30).safeParse(remote.cases??[]):null;
  const cases:Array<{id:string;title?:string}>=adHoc
   ? [...new Map((expected?.success?expected.data:[]).map(item=>[item.id,item])).values()]
   : Array.isArray(snapshot?.cases)?snapshot.cases:[];
  const provided=Array.isArray(remote.caseResults)?remote.caseResults:[];
  const providedMap=new Map<string,{result:string;evidence:string;reason:string}>();
  for(const item of provided){
   if(typeof item?.case_id==='string'&&typeof item?.result==='string'&&['passed','failed','blocked','not_run'].includes(item.result)){
    const evidence=String(item.evidence||'').slice(0,3000).trim();
    const reason=String(item.reason||'unknown').slice(0,60);
    providedMap.set(item.case_id,{result:item.result==='passed'&&evidence.length<10?'blocked':item.result,evidence,reason});
   }
  }
  const supplied=cases.map(c=>{
   const candidate=providedMap.get(c.id);
   return {case_id:c.id,result:candidate?.result||'not_run',reason:candidate?.reason||'unknown',evidence:candidate?.evidence||'Нет подтверждённого результата'};
  });
  const {cases:checked,visualToolGap}=checkedWithActualCapabilities(cases,supplied,String(remote.capabilities||''));
  let verdict=status==='failed'?'blocked':String(remote.verdict||'blocked');
  const currentSpec=await pool.query('SELECT spec_version,spec_review_status,spec_reviewed_version,spec_reviewed_commit FROM tasks WHERE id=$1 AND project_id=$2',[row.rows[0].task_id,projectId]);
  const staleSpecification=!currentSpec.rowCount||currentSpec.rows[0].spec_version!==row.rows[0].qa_spec_version||currentSpec.rows[0].spec_review_status!=='current'||currentSpec.rows[0].spec_reviewed_version!==currentSpec.rows[0].spec_version||
   (row.rows[0].qa_plan_snapshot?.simplified===true&&remote.testedCommit!==currentSpec.rows[0].spec_reviewed_commit);
  if(!cases.length||!remote.testedCommit||!Array.isArray(remote.checks)||!remote.checks.length)verdict='blocked';
  if(checked.some(c=>c.result==='failed')||(Array.isArray(remote.checks)&&remote.checks.some((c:any)=>c.result==='failed'))||(Array.isArray(remote.findings)&&remote.findings.length>0))verdict='failed';
  else if((checked.some(c=>c.result!=='passed')||visualToolGap||snapshot?.singlePass===true&&!remote.checks?.some((c:any)=>c.result==='passed'))&&verdict==='passed')verdict='blocked';
  // A changed specification invalidates the entire run even if old cases failed.
  if(staleSpecification)verdict='blocked';
  const ran=checked.filter(c=>c.result==='passed'||c.result==='failed').length;
  const outcome=singlePass&&status==='completed'?'Проверено '+ran+' из '+cases.length+'.':message;
  const screenshots=Array.isArray(remote.screenshots)?remote.screenshots.filter((s:any)=>s?.mime==='image/jpeg'&&typeof s.data==='string'&&s.data.length<=250000&&/^[A-Za-z0-9+/=]+$/.test(s.data)).slice(0,3):[];
  const report={screenshots,summary:remote.summary||outcome,...(singlePass?{executionVerified:remote.executionVerified===true}:{}),findings:remote.findings||[],checks:remote.checks||[],caseResults:checked,capabilities:String(remote.capabilities||'').slice(0,1500),commit:remote.testedCommit||null,spec_version:row.rows[0].qa_spec_version,staleSpecification};
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
 const verified=await pool.query("SELECT 1 FROM ai_test_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.project_id=$2 AND r.task_id=$3 AND r.status='completed' AND r.verdict='passed' AND r.report->>'commit' IS NOT NULL AND r.qa_spec_version=t.spec_version",[testId,projectId,taskId]);
 if(!verified.rowCount)throw ApplicationFailure.nonRetryable('Нет успешного тестирования коммита PR');
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
    tools:'MCP orchestrator: tasks.read, approvals.list, approvals.answer_question, approvals.deliver_task_answer, workflow.release_task и остальные разрешённые инструменты ПМ. Если владелец уточнил требования, передай его текущее исходное сообщение аналитику через approvals.deliver_task_answer с task_id и source_message_id. Даже старую карточку без ID вопросов можно вернуть на повторный анализ. При просьбе слить PR используй workflow.release_task. Не утверждай, что доступно лишь чтение, пока не проверил реально доступные инструменты.',
    instructions:(await conversationInstructions(pool,projectId,'manager')).slice(0,2200),
    scope:JSON.stringify({task_id:taskId,source_message_id:messageId,title:snapshot.task.title,stage:snapshot.task.stage,description:String(snapshot.task.description||'').slice(0,1700),pr_url:snapshot.task.pr_url}),
    context:JSON.stringify({pending_requests:pending.slice(0,4),latest_qa:latest?{status:latest.status,verdict:latest.verdict}:null,images:images.map(image=>image.name)}).slice(0,500)+'\n'+detailContext,
    continuation:replyTarget?'Ответ на сообщение: '+String(replyTarget.body).slice(0,1000):'',
    output:'Отвечай по-русски с Markdown-абзацами и списками. Если задача ожидает требований, не заставляй владельца повторять уже данный ответ: используй tools для передачи сохранённого сообщения. При просьбе продвинуть задачу вызывай инструмент, сообщай подтверждённый результат или точную причину блокировки. QA blocked не равно passed. Очередь выкладки ещё не означает успешный деплой.'
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

/**
 * Peer-to-peer specialist communication. The manager is not a relay for all
 * messages: only unresolved customer decisions enter its inbox.
 */
export async function resolvePeerQuestions(args:{projectId:string;taskId:string;noteId?:string}):Promise<{resolved:number;pending:number}>{
 const {projectId,taskId}=args;
 const notes=await pool.query(
  "SELECT id,author_stage,target_stage,body FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND source_kind='agent' AND (status='open' OR (status='processing' AND processing_at<now()-interval '10 minutes')) AND ($3::uuid IS NULL OR id=$3) ORDER BY requires_customer DESC,created_at LIMIT 2",
  [projectId,taskId,args.noteId||null]);
 let resolved=0;
 for(const note of notes.rows){
  const locked=await pool.query(
   "UPDATE task_agent_notes SET status='processing',processing_at=now() WHERE id=$1 AND project_id=$2 AND (status='open' OR (status='processing' AND processing_at<now()-interval '10 minutes')) RETURNING id",
   [note.id,projectId]);
  if(!locked.rowCount)continue;
  try{
   const [task,stage,rules,settings]=await Promise.all([
    pool.query('SELECT title,description,spec_version FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]),
    pool.query('SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage=$2',[projectId,note.target_stage]),
    pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at DESC LIMIT 12',[projectId]),
    pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId])
   ]);
   const name=String(stage.rows[0]?.agent_name||'Менеджер проекта');
   const context=await taskNotesContext(pool,projectId,taskId,null,12);
   const conversation=await taskConversationEvidence(pool,projectId,taskId);
   const pr=note.target_stage==='development'||note.target_stage==='analysis'
    ?await prEvidence(projectId,taskId).catch(e=>({commitSha:'',patch:'PR недоступен: '+String(e).slice(0,170),summary:''}))
    :null;
   const sources={specification:String(task.rows[0]?.description||'').slice(0,4500),conversation:conversation.slice(-2800),notes:context.slice(-2400),pr:pr?.commitSha?pr.patch.slice(0,2000):''};
   const prompt=[
    'Ты '+name+' — независимый специалист AI-команды. Отвечай на конкретный вопрос другого агента, НЕ заказчику.',
    'Тебе доступны только перечисленные факты. Не притворяйся, что выполнял тесты, не выдумывай код или требования и не принимай решения за человека.',
    'Сначала проверь ТЗ, переписку и уже отвеченные вопросы. Закрывай вопрос только при полном ответе. Для status=answered укажи ключ источника и дословный фрагмент, подтверждающий ответ. Сам вопрос, предположение или обещание не являются источником.',
    'Если вопрос касается отсутствующего инструмента, кода или объективной проверки, status=needs_tool. Если заказчик должен изменить ТЗ или выбрать бизнес-правило, status=needs_customer.',
    'Верни строго JSON {"status":"answered|needs_tool|needs_customer","answer":"объяснение или конкретный недостающий факт","source":"specification|conversation|notes|pr","quote":"дословный фрагмент или пустая строка"} без Markdown.',
    'Роль и инструкции: '+String(stage.rows[0]?.agent_instructions||'').slice(0,1700),
    'Накопленный опыт специалиста:\n'+await agentMemoryContext(pool,projectId,note.target_stage),
    'Задача: '+String(task.rows[0]?.title||''),
    'Правила: '+JSON.stringify(rules.rows.map(x=>x.body)).slice(0,1000),
    ...Object.entries(sources).map(([key,value])=>key+':\n'+value),
    'Вопрос от '+note.author_stage+': '+String(note.body).slice(0,1600)
   ].join('\n\n');
   const ai=settings.rows[0];
   if(!ai?.enabled)throw Error('AI отключён в настройках проекта');
   const raw=await askRunnerAssistant(prompt,projectId,taskId,'peer_question_'+note.target_stage,await resolveRoleAiSettings(pool,projectId,note.target_stage,ai),65000,[],{role:note.target_stage,processId:note.id});
   const from=raw.indexOf('{'),to=raw.lastIndexOf('}');
   const answer=JSON.parse(raw.slice(from,to+1)) as {status:string;answer:string;source:keyof typeof sources;quote:string};
   const text=String(answer.answer||'').trim().slice(0,2200);
   const quote=String(answer.quote||'').trim();
   if(answer.status==='answered'&&text&&quote&&Object.hasOwn(sources,answer.source)&&sources[answer.source].includes(quote)&&!String(note.body).includes(quote)){
    const saved=await pool.query(
     "UPDATE task_agent_notes n SET status='answered',answer=$2,answer_author=$3,answered_at=now(),processing_at=NULL,requires_customer=false WHERE n.id=$1 AND n.status='processing' AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=n.task_id AND t.project_id=n.project_id AND t.spec_version=$4)",
     [note.id,text+'\n\nИсточник ('+answer.source+'): «'+quote.slice(0,650)+'»',name,task.rows[0]?.spec_version]);
    if(!saved.rowCount)throw Error('ТЗ изменилось во время поиска ответа');
    resolved++;
   }else if(answer.status==='needs_tool'){
    // A missing browser or code-reading tool is a capability gap, not an
    // unanswered business question for the customer. Preserve its evidence
    // and let independent QA report the affected cases as blocked.
    await pool.query("UPDATE task_agent_notes SET status='answered',answer=$2,answer_author='Система инструментов',answered_at=now(),processing_at=NULL,requires_customer=false WHERE id=$1 AND status='processing'",
     [note.id,'Средство недоступно: '+(text||'нужна инструментальная проверка')]);
    resolved++;
   }else if(answer.status==='needs_customer'){
    await pool.query("UPDATE task_agent_notes SET status='open',processing_at=NULL,requires_customer=true WHERE id=$1 AND status='processing'",[note.id]);
   }else{
    throw Error('Ответ не подтверждён фрагментом источника');
   }
  }catch(e){
   await pool.query("UPDATE task_agent_notes SET status='open',processing_at=NULL WHERE id=$1 AND status='processing'",[note.id]);
   await event(projectId,note.id,'analysis','peer_unanswered','Внутренний вопрос '+note.target_stage+' не удалось закрыть: '+String(e).slice(0,250),'warning');
  }
 }
 if(resolved){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const task=(await client.query("SELECT spec_version FROM tasks WHERE project_id=$1 AND id=$2 AND spec_review_status='needs_approval' FOR UPDATE",[projectId,taskId])).rows[0];
   if(task){
    const state=await resolveAgentQuestionsForReview(client,projectId,taskId,task.spec_version);
    if(!state.remaining&&!state.requiresApproval)
     await client.query("UPDATE tasks SET spec_review_status='pending',spec_review_note='Найден ответ на вопрос. Аналитик повторно сверяет ТЗ.' WHERE project_id=$1 AND id=$2",[projectId,taskId]);
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 const pending=await pendingAgentQuestions(pool,projectId,taskId);
 return {resolved,pending};
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

export async function pendingMergeTasks(batchId:string){
 const batch=await loadMergeBatch(pool,batchId);
 return batch?.task_ids.filter(id=>!batch.results.some(result=>result.taskId===id))??[];
}

export async function tryMergeBatchTask(batchId:string,taskId:string):Promise<{status:'merged'|'pending'|'conflict'|'skipped';reason?:string}>{
 const batch=await loadMergeBatch(pool,batchId);
 if(!batch?.task_ids.includes(taskId))return {status:'skipped',reason:'Задача отсутствует в очереди'};
 await setMergeProgress(pool,batchId,taskId,'Слияние PR '+(batch.results.length+1)+' из '+batch.task_ids.length);
 try{await mergeTaskPr(batch.project_id,taskId,batch.actor_id);return {status:'merged'};}
 catch(error){
  const reason=(error as Error).message;
  const status=(error as {statusCode?:number}).statusCode;
  if(!status||status>=500)throw error;
  if(/ещё вычисляет mergeability/i.test(reason))return {status:'pending',reason};
  if(/merge conflicts|содержит конфликт|mergeable.*dirty|GitHub отклонил слияние.*conflict/i.test(reason))return {status:'conflict',reason};
  return {status:'skipped',reason};
 }
}

export async function pollMergeConflict(batchId:string,taskId:string,attempt:number):Promise<{status:'running'|'completed'|'failed';message?:string}>{
 const batch=await loadMergeBatch(pool,batchId);
 if(!batch?.task_ids.includes(taskId))return {status:'failed',message:'Задача отсутствует в очереди'};
 const hex=createHash('sha256').update(batchId+':'+taskId+':'+attempt).digest('hex').slice(0,32);
 const jobId=hex.replace(/^(........)(....)(....)(....)/,'$1-$2-$3-$4-');
 try{
  const remote=await runner('/jobs/'+jobId);
  if(['completed','failed','cancelled'].includes(remote.status))
   return {status:remote.status==='completed'?'completed':'failed',message:String(remote.message||'').slice(0,1200)};
  if(remote.status!=='interrupted')return {status:'running'};
 }catch(error){
  if((error as {statusCode?:number}).statusCode!==404)return runnerUnavailable(error);
 }
 await setMergeProgress(pool,batchId,taskId,'Разрешение конфликта PR через Codex');
 const {project_id:projectId,actor_id:actorId}=batch;
 const details=await pool.query(`SELECT t.title,t.description,t.pr_number,t.git_branch,g.repository,c.secret_encrypted,a.model,a.reasoning
  FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id
  JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3
  LEFT JOIN project_ai_settings a ON a.project_id=t.project_id
  WHERE t.id=$1 AND t.project_id=$2 AND t.stage='merge_queue'`,[taskId,projectId,actorId]);
 const row=details.rows[0];
 if(!row?.pr_number||row.git_branch!==taskId)return {status:'failed',message:'Не найдена рабочая ветка PR задачи'};
 const token=decrypt(row.secret_encrypted);
 const response=await fetch('https://api.github.com/repos/'+row.repository+'/pulls/'+row.pr_number,{
  headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},signal:AbortSignal.timeout(15000)
 });
 if(!response.ok)throw Error('Не удалось получить PR: HTTP '+response.status);
 const pr=await response.json() as any;
 if(pr.merged)return {status:'completed'};
 if(pr.state!=='open'||pr.head?.ref!==row.git_branch)return {status:'failed',message:'Рабочая ветка PR изменилась'};
 const ai=await resolveRoleAiSettings(pool,projectId,'development',{model:row.model||'gpt-6-luna',reasoning:row.reasoning||'low'});
 try{
  await dispatch({id:jobId,kind:'resolve-conflict',taskId,projectId,repository:row.repository,baseBranch:pr.base.ref,token,
   model:ai.model,reasoning:ai.reasoning,roleCapacity:await roleCapacity(pool,projectId,'development'),
   maxRuntimeSeconds:900,title:row.title,description:row.description||''});
 }catch(error){
  const status=(error as {statusCode?:number}).statusCode;
  if(status&&status<500)return {status:'failed',message:(error as Error).message};
  return runnerUnavailable(error);
 }
 return {status:'running'};
}
export async function recordMergeBatchResult(batchId:string,result:MergeResult){await saveMergeResult(pool,batchId,result);}
export async function completeMergeBatch(batchId:string,error?:string){await finishMergeBatch(pool,batchId,error);}

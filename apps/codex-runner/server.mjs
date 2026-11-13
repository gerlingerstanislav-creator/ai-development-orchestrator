import {validAgentRequest,assistantRequestError,runnerJobRequestError} from './request-contracts.mjs';
import {createQaJobRunner} from './qa-job.mjs';
import {createCodexDeviceAuth} from './device-auth.mjs';
import http from 'node:http';
import {startCodexProxy,probeAuthEndpoint} from './codex-proxy.mjs';
import {createCommandExecutor} from './command-executor.mjs';
import {createCodexThreadStore,createCodexAppExecutor} from './codex-app-server.mjs';
import {createPersistentCliExecutor} from './codex-cli-session.mjs';
import {conversationThreadScope} from './codex-thread-scope.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {startQaBrowserGateway,openQaBrowserSession,getQaBrowserEvidence,getQaScreenshotEvidence,closeQaBrowserSession,browserHealth} from './browser-gateway.mjs';
import {jobIdentity,openJobJournal,recoveryAction,runtimeLimitResult} from './job-journal.mjs';
import {codexFailureDetail,conversationPolicy,createTaskPolicy,gitEnvironment,runnerEnvironment} from './execution-policy.mjs';
import {qaPrerequisiteError} from './qa-preflight.mjs';
import {qaBaselineCommands,readQaCommands,readQaReceipts,verifyQaExecution} from './qa-run-evidence.mjs';
import {incompleteQaCases,qaCompletionPrompt,completedQaSummary,applyVisualEvidenceGate} from './qa-completion.mjs';
import {withRunnerImages} from './chat-images.mjs';
import {createRateLimitCache,readCodexRateLimits} from './rate-limits.mjs';
import {agentMcp,withReaderContext,scopedAgentPrompt} from './agent-context.mjs';
import {assembleAgentPrompt} from '../api/src/prompt-assembler.mjs';
import {buildQaPrompt} from './qa-prompt.mjs';
import {buildDeveloperPrompt} from './developer-prompt.mjs';
import {jobRole,projectKey,nextRunnableJobIndex} from './job-scheduler.mjs';
import {parseExistingImplementation,parseNoChangesNeeded} from './development-outcome.mjs';
import {taskBranchName,ensureTaskBranchHistory} from './task-branch-history.mjs';
import {createDeterministicCiJobRunner} from './ci-job.mjs';

const execFileAsync=promisify(execFile);
const home=process.env.CODEX_HOME||'/home/node/.codex';
await mkdir(home,{recursive:true,mode:0o700});
const config=join(home,'config.toml');
try { await access(config); } catch { await writeFile(config,'cli_auth_credentials_store = "file"\n',{mode:0o600}); }
// Loopback-only CONNECT tunnel: use IPv4 resolution to avoid the Rust CLI's
// dual-stack DNS failures observed on some Docker/VPN networks.
// No plaintext TLS content or credentials are read by this tunnel.
const codexProxy=startCodexProxy();
startQaBrowserGateway();
const proxyUrl=codexProxy.url;
const baseEnv=runnerEnvironment();
const cliEnv={...baseEnv,HOME:process.env.HOME||'/home/node',CODEX_HOME:home,SSL_CERT_FILE:'/etc/ssl/certs/ca-certificates.crt',HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1'};
const codexDotenv=join(home,'.env');
// The Codex binary can load proxy settings from its own .env; provide
// the same loopback proxy there in addition to the child environment.
await writeFile(codexDotenv,`HTTP_PROXY=${proxyUrl}\nHTTPS_PROXY=${proxyUrl}\nhttp_proxy=${proxyUrl}\nhttps_proxy=${proxyUrl}\nNO_PROXY=localhost,127.0.0.1,::1\nno_proxy=localhost,127.0.0.1,::1\n`,{mode:0o600});
const reply=(res,status,payload)=>{
 const data=JSON.stringify(payload);
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(data)});
 res.end(data);
};
const deviceAuth=createCodexDeviceAuth({cliEnv,codexProxy,probeAuthEndpoint,execFileAsync,spawnImpl:spawn});
const {connected,runLogin,deviceInfo}=deviceAuth;
// Single-flight task runner: all Git operations happen outside the Codex sandbox.
// The GitHub credential is kept in process environment, never in CLI argv or git config files.
const activeJobs=new Map();
const runnerStateDir=process.env.RUNNER_STATE_DIR||join(home,'runner-jobs');
const journal=openJobJournal(runnerStateDir);
const threadStore=createCodexThreadStore(join(runnerStateDir,'codex-threads'));
const appExecutor=createCodexAppExecutor({store:threadStore,env:cliEnv});
const globalCodexSettings=args=>{
 const result=[];
 for(let i=0;i<args.length;i++)if(args[i]==='-c'&&i+1<args.length)result.push('-c',args[++i]);
 return result;
};
const appConversationSettings=globalCodexSettings(conversationPolicy);
const imagePaths=args=>args.flatMap((value,i)=>value==='--image'&&typeof args[i+1]==='string'?[args[i+1]]:[]);


journal.recover();
const readJob=id=>activeJobs.get(id)||journal.read(id);
function saveJob(job,state){journal.save({identity:jobIdentity(job),state},job.token);}
const jobChildren=new Map();
const cancelledJobs=new Set();
const assertJobActive=id=>{if(cancelledJobs.has(id))throw new Error('Выполнение остановлено');};
function stopCommand(child){
 if(!child?.pid)return;
 try{process.kill(-child.pid,'SIGKILL');}
 catch(error){
  if(error.code!=='ESRCH'){
   process.stderr.write('Не удалось остановить группу процессов: '+error.code+'\n');
   child.kill('SIGKILL');
  }
 }
}
const MAX_PARALLEL_DEVELOPMENT=20; // Actual per-project role limits come from signed API jobs.
const MAX_PARALLEL_PER_ROLE=1;
const activeByRole=new Map();
const activeByProject=new Map();
const agentApi=process.env.ADO_AGENT_API_URL||'http://api:3001/internal/agent-tools';
const MAX_PARALLEL_CHAT=4;
const jobQueue=[];
const activeBranches=new Set();
const runningJobIds=new Set();
let runningJobs=0;
let storageRetry;
let activeChatRequests=0;
const activeAgentRoles=new Map();
function startNextJobs(){
 // Drop cancelled requests first; then select fairly across ready projects.
 for(let i=0;i<jobQueue.length;){
  if(cancelledJobs.has(jobQueue[i].job.id))jobQueue.splice(i,1);
  else i++;
 }
 while(runningJobs<MAX_PARALLEL_DEVELOPMENT){
  const i=nextRunnableJobIndex(jobQueue,{activeBranches,activeByRole,activeByProject,defaultRoleCapacity:MAX_PARALLEL_PER_ROLE});
  if(i<0)break;
  const {job,state}=jobQueue[i];
  const branchKey=job.repository+':'+job.taskId;
  const role=jobRole(job);
  const key=projectKey(job);
  const roleKey=key+':'+role;
  state.status='running';state.startedAt=new Date().toISOString();
  state.message='Исполнитель приступил к заданию';
  try{saveJob(job,state);}
  catch(error){
   state.status='queued';state.startedAt=null;
   state.message='Ожидает доступа к журналу исполнителя';
   process.stderr.write(state.message+': '+error.message+'\n');
   storageRetry??=setTimeout(()=>{storageRetry=undefined;startNextJobs();},5000).unref();
   return;
  }
  jobQueue.splice(i,1);
  activeBranches.add(branchKey);
  runningJobIds.add(job.id);
  runningJobs++;
  activeByRole.set(roleKey,(activeByRole.get(roleKey)||0)+1);
  activeByProject.set(key,(activeByProject.get(key)||0)+1);
  let expiredPhase;
  const deadline=setTimeout(()=>{
   if(state.status!=='running')return;
   expiredPhase=state.message;
   state.message='Остановка по таймауту · '+expiredPhase;
   cancelledJobs.add(job.id);
   stopCommand(jobChildren.get(job.id));
  },job.maxRuntimeSeconds*1000).unref();
  const scope=job.projectId?{projectId:job.projectId,taskId:job.taskId,processId:job.id,role,actorId:job.actorId}:null;
  void withReaderContext(agentApi,jobKey,scope,context=>{
   if(job.kind==='test')return runTestJob(job,state,context);
   if(job.kind==='review')return runArchitectureReviewJob(job,state,context);
   if(job.kind==='ci')return runDeterministicCiJob(job,state);
   if(job.kind==='resolve-conflict')return runConflictJob(job,state,context);
   return runJob(job,state,context);
  }).catch(e=>{if(!cancelledJobs.has(job.id)){state.status='failed';state.message=String(e?.message||e).replaceAll(job.token||'','[REDACTED]').slice(0,1500);}}).finally(()=>{
   clearTimeout(deadline);
   if(expiredPhase&&state.status!=='cancelled'&&state.status!=='completed')
    Object.assign(state,runtimeLimitResult(state,expiredPhase,job.maxRuntimeSeconds));
   try{saveJob(job,state);activeJobs.delete(job.id);}
   catch(error){process.stderr.write('Не удалось сохранить результат задания '+job.id+': '+error.message+'\n');}
   activeBranches.delete(branchKey);runningJobIds.delete(job.id);cancelledJobs.delete(job.id);runningJobs--;
   activeByRole.set(roleKey,Math.max(0,(activeByRole.get(roleKey)||1)-1));
   activeByProject.set(key,Math.max(0,(activeByProject.get(key)||1)-1));
   startNextJobs();
  });
 }
 for(let i=0;i<jobQueue.length;i++)jobQueue[i].state.message='Ожидает свободного исполнителя своей роли (очередь '+(i+1)+')';
}
const jobKey=process.env.RUNNER_SHARED_SECRET||'';
if(jobKey.length<32)throw Error('RUNNER_SHARED_SECRET required');
function authorized(req){
 const supplied=req.headers['x-runner-secret'];
 if(typeof supplied!=='string')return false;
 const a=Buffer.from(supplied),b=Buffer.from(jobKey);
 return a.length===b.length && timingSafeEqual(a,b);
}
const command=createCommandExecutor({baseEnv,assertJobActive,jobChildren,stopCommand,codexFailureDetail});
const persistentCli=createPersistentCliExecutor(threadStore,command);
const runDeterministicCiJob=createDeterministicCiJobRunner({command,assertJobActive,saveJob,isolatedTaskPolicy,cliEnv});
async function isolatedTaskPolicy(workdir,dir,jobId,writable=true,qa=false){
 const policy=await createTaskPolicy(workdir,{writable,qa});
 try{await command('codex',[...policy.sandboxArgs,'--','/bin/true'],{cwd:dir,env:cliEnv,jobId,timeout:15000});}
 catch(error){throw Error('Изоляция Runner недоступна: '+error.message);}
 return policy;
}
async function createPullRequest(job,branch,summary){
 const response=await fetch('https://api.github.com/repos/'+job.repository+'/pulls',{
  method:'POST',
  headers:{Authorization:'Bearer '+job.token,'Content-Type':'application/json',
   Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'},
  body:JSON.stringify({
   title:'AI: '+job.title.slice(0,180),
   body:'Автоматически подготовлено Codex по задаче '+job.taskId+'\n\nМодель: '+job.model+
   '\n\n'+summary.slice(0,1500)+'\n\nПроверьте изменения и тесты перед слиянием.',
   head:branch,base:job.baseBranch,draft:false
  }),
  signal:AbortSignal.timeout(25000)
 });
 if(!response.ok){
  throw new Error('GitHub PR HTTP '+response.status+
   (response.status===403||response.status===422?' — проверь Pull requests: Read and write и правила веток':''));
 }
 return response.json();
}
function codexJsonResult(output){
 let message='',usage={input_tokens:0,cached_input_tokens:0,output_tokens:0};
 for(const line of String(output||'').split('\n')){
  let event;try{event=JSON.parse(line);}catch{continue;}
  if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')message=event.item.text;
  if(event.type==='turn.completed'&&event.usage){
   const u=event.usage;
   usage={input_tokens:Number(u.input_tokens)||0,cached_input_tokens:Number(u.cached_input_tokens)||0,output_tokens:Number(u.output_tokens)||0};
  }
 }
 return {message,usage};
}
function addUsage(a,b){
 return {input_tokens:(a.input_tokens||0)+(b.input_tokens||0),
  cached_input_tokens:(a.cached_input_tokens||0)+(b.cached_input_tokens||0),
  output_tokens:(a.output_tokens||0)+(b.output_tokens||0)};
}
async function ensureTaskPullRequest(job,branch,commit,summary){
 const url='https://api.github.com/repos/'+job.repository;
 const headers={Authorization:'Bearer '+job.token,Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const list=async state=>{
  const response=await fetch(url+'/pulls?state='+state+'&head='+
   encodeURIComponent(job.repository.split('/')[0]+':'+branch)+'&per_page=100',{
    headers,signal:AbortSignal.timeout(20000)
   });
  if(!response.ok)throw Error('Не удалось проверить '+state+' PR: GitHub HTTP '+response.status);
  return response.json();
 };
 const patch=async(number,body)=>{
  const response=await fetch(url+'/pulls/'+number,{
   method:'PATCH',headers:{...headers,'Content-Type':'application/json'},
   body:JSON.stringify(body),signal:AbortSignal.timeout(20000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Не удалось восстановить PR #'+number+': GitHub HTTP '+response.status+
   ' '+String(data.message||'').slice(0,220));
  return data;
 };
 assertJobActive(job.id);
 const open=await list('open');
 let pr=open.find(item=>item.base?.ref===job.baseBranch);
 if(!pr&&open.length){
  // A PR for this task branch already exists against another base. Creating
  // another would hit 422; change the target explicitly and keep its history.
  pr=await patch(open[0].number,{base:job.baseBranch});
 }
 if(!pr){
  const closed=await list('closed');
  const recoverable=closed.find(item=>!item.merged_at&&item.base?.ref===job.baseBranch);
  if(recoverable)pr=await patch(recoverable.number,{state:'open'});
 }
 if(!pr){
  try{pr=await createPullRequest(job,branch,summary);}
  catch(error){
   // A concurrent writer may have created the PR between list and POST.
   const again=await list('open');
   pr=again.find(item=>item.base?.ref===job.baseBranch);
   if(!pr)throw error;
  }
 }
 if(pr.head?.sha!==commit||!pr.html_url){
  const current=await fetch(url+'/pulls/'+pr.number,{headers,signal:AbortSignal.timeout(20000)});
  if(current.ok)pr=await current.json();
 }
 if(pr.head?.sha!==commit||!pr.html_url)
  throw Error('PR #'+pr.number+' существует, но SHA ветки не совпадает с опубликованным коммитом. Не перезаписываем чужие изменения.');
 return pr.html_url;
}
async function resumePublishedCommit(job,state,git){
 if(!state.checkpoint)return false;
 const remote=(await git('ls-remote','origin','refs/heads/'+job.taskId)).stdout.trim().split(/\s+/)[0];
 const action=recoveryAction(state.checkpoint,remote);
 if(action==='changed')throw Error('Ветка GitHub изменилась после прерывания. Требуется проверка перед повтором.');
 return action==='published';
}

async function runJob(job,state,context){
 const deadline=Date.now()+job.maxRuntimeSeconds*1000;
 const timeLeft=()=>Math.max(0,deadline-Date.now());
 let cumulativeUsage={input_tokens:0,cached_input_tokens:0,output_tokens:0};
 // The workspace is task-owned, not run-owned: QA rework must see the same
 // files and the same Codex thread. Secrets are never stored in Git config.
 const workdir=join(runnerStateDir,'workspaces',job.taskId);
 await mkdir(workdir,{recursive:true,mode:0o700});
 const dir=join(workdir,'repo');
 const gitEnv=gitEnvironment(job.token);
 const git=(...args)=>command('git',args,{cwd:dir,env:gitEnv,timeout:45000,jobId:job.id});
 // Stable branch identity: one Git branch per task; different agents cannot
 // work in that branch concurrently (startNextJobs locks repository+taskId).
 const branch=taskBranchName(job.taskId);
 try{
  state.message='Клонирование репозитория';
  let existingWorkspace=false;
  try{await access(join(dir,'.git'));existingWorkspace=true;}catch{}
  if(!existingWorkspace)await command('git',['clone','--depth','1','--branch',job.baseBranch,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workdir,env:gitEnv,timeout:75000,jobId:job.id});
  else {
   const origin=(await git('remote','get-url','origin')).stdout.trim();
   if(origin!=='https://github.com/'+job.repository+'.git')
    throw Error('Сохранённая рабочая копия относится к другому репозиторию');
   // Never hard reset, checkout -f or clean: a killed Codex turn may leave
   // valuable uncommitted work on disk.
  }
  if(await resumePublishedCommit(job,state,git)){
   state.prUrl=await ensureTaskPullRequest(job,branch,state.checkpoint.commit,'Изменения восстановлены после перезапуска.');
   state.branch=branch;
   assertJobActive(job.id);
   state.status='completed';state.message='Готовый коммит и PR восстановлены из GitHub';
   return;
  }
  // Continue the same branch after failures/restarts if it already exists.
  const remoteBranch=await fetch('https://api.github.com/repos/'+job.repository+'/branches/'+encodeURIComponent(branch),{
   headers:{Authorization:'Bearer '+job.token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(20000)
  });
  if(remoteBranch.ok){
   state.message='Продолжение существующей ветки '+branch;
   await git('fetch','--depth','1','origin','refs/heads/'+branch+':refs/remotes/origin/'+branch);
   const currentBranch=(await git('branch','--show-current')).stdout.trim();
   if(currentBranch!==branch){
    const local=(await command('git',['show-ref','--verify','--quiet','refs/heads/'+branch],
     {cwd:dir,env:gitEnv,timeout:10000,jobId:job.id,allowNonzero:true})).exitCode===0;
    await git('checkout',...(local?[branch]:['-b',branch,'refs/remotes/origin/'+branch]));
   }
   // A depth-1 clone of main plus a depth-1 fetch of the task branch often
   // has no merge-base, even when GitHub does. Repair ancestry *before* the
   // model runs, so a 50-second Codex attempt is not wasted on git 128.
   const history=await ensureTaskBranchHistory(git,{baseBranch:job.baseBranch,taskBranch:branch});
   state.branchHistory=history.rehydrated?'restored':'shared';
   const baseRef='refs/remotes/origin/'+job.baseBranch;
   let canFastForward=false;
   try{await git('merge-base','--is-ancestor','HEAD',baseRef);canFastForward=true;}catch{}
   if(canFastForward){
    // Only a true fast-forward of the very same task branch is permitted.
    // No new branch, forced push, synthetic commit or loss of previous work.
    await git('merge','--ff-only',baseRef);
    await git('push','origin','HEAD:refs/heads/'+branch);
   }
  }else if(remoteBranch.status===404){
   const currentBranch=(await git('branch','--show-current')).stdout.trim();
   if(currentBranch!==branch){
    const local=(await command('git',['show-ref','--verify','--quiet','refs/heads/'+branch],
     {cwd:dir,env:gitEnv,timeout:10000,jobId:job.id,allowNonzero:true})).exitCode===0;
    await git('checkout',...(local?[branch]:['-b',branch]));
   }
   state.message='Создание ветки задачи в GitHub';
   // Publish even before Codex edits, so failures retain a stable task branch.
   await git('push','-u','origin','HEAD:refs/heads/'+branch);
  }else{
   throw new Error('Не удалось проверить ветку задачи: GitHub HTTP '+remoteBranch.status);
  }
  state.branch=branch;
  state.message='Изменяет код';
  const prompt=buildDeveloperPrompt(job);
  const policy=await isolatedTaskPolicy(workdir,dir,job.id);
  const developerScope={projectId:job.projectId,taskId:job.taskId,role:'development'};
  let codexTurns=0;
  const runCodex=async(instruction)=>{
   assertJobActive(job.id);
   const remaining=timeLeft();
   if(remaining<15000)throw Error('Исчерпано общее время разработки. Последняя попытка не запускается.');
   const previous=await threadStore.read(developerScope);
   // Initial handoff includes full instructions once. QA rework is a new turn
   // in the SAME thread, with only fresh feedback and the current task state.
   const nextPrompt=previous&&codexTurns===0
    ?'Продолжи разработку ранее назначенной задачи. Не повторяй завершённую работу. '+
     'Проверь текущие файлы и PR, учитывай изменения требований и следующие замечания:\n'+
     ('Задача: '+job.title+'\n'+String(job.description||'').slice(0,4800)+
      '\nЗамечания QA/CI: '+String(job.reworkFeedback||'нет новых замечаний').slice(0,4800))
    :previous&&codexTurns>0
    ?'Продолжи текущую попытку и устрани блокер. '+String(instruction).slice(-2400)
    :instruction;
   codexTurns++;
   await auditCodexPrompt(job,'development',nextPrompt);
   const result=await persistentCli({
    scope:developerScope,requestId:job.id+':dev:'+codexTurns,prompt:nextPrompt,
    model:job.model,reasoning:job.reasoning,cwd:dir,
    timeout:remaining,policyArgs:policy.execArgs,mcpArgs:context.args,
    env:{...cliEnv,...context.env},jobId:job.id,maxOutputChars:500000
   });
   state.threadId=result.threadId;
   const parsed=codexJsonResult(result.stdout);
   cumulativeUsage=addUsage(cumulativeUsage,parsed.usage);
   state.usage=cumulativeUsage;
   return {result,answer:parsed.message,files:await git('status','--porcelain')};
  };
  const completeWithoutEdits=async attempt=>{
   if(attempt.files.stdout.trim())return false;
   const head=(await git('rev-parse','HEAD')).stdout.trim();
   const base=(await git('rev-parse','refs/remotes/origin/'+job.baseBranch)).stdout.trim();
   if(head!==base){
    // Never fabricate a commit when earlier task commits are already present.
    // QA rework requires an explicit, checkable reason that no edits are
    // necessary. On initial recovery, the existing PR can simply be reused.
    const diff=(await git('diff','--name-only','refs/remotes/origin/'+job.baseBranch+'...HEAD')).stdout.trim();
    if(!diff)throw Error('Ветка отличается от базовой, но изменений для PR не обнаружено');
    const rework=String(job.reworkFeedback||'').trim();
    if(rework){
     const tracked=(await git('ls-files')).stdout.split(/\r?\n/).filter(Boolean);
     const review=parseNoChangesNeeded(attempt.answer||'',{headSha:head,trackedFiles:tracked});
     if(!review)return false; // Ask the developer to explain the no-change decision.
     assertJobActive(job.id);
     state.reworkReview=review;
     state.handoffNote='Исправления не требуются. Повторная проверка QA на SHA '+head+
      '. '+review.summary+' Проверено: '+review.files.join(', ')+
      '. Обоснование: '+review.reasons.join(' | ');
     state.message='Разработчик объяснил отсутствие необходимых правок и вернул тот же PR в QA';
    }
    state.prUrl=await ensureTaskPullRequest(job,branch,head,(attempt.answer||'').slice(0,6000));
    state.branch=branch;state.completionKind='pr';state.status='completed';
    if(!rework)state.message='Существующие изменения в ветке переданы в PR без нового коммита';
    return true;
   }
   const tracked=(await git('ls-files')).stdout.split(/\r?\n/).filter(Boolean);
   const evidence=parseExistingImplementation(attempt.answer||'',{baseSha:base,headSha:head,trackedFiles:tracked});
   if(!evidence)return false;
   state.completionKind='already_implemented';
   state.verifiedCommit=head;
   state.implementationEvidence=evidence;
   state.branch=branch; // Persistent task branch, even when QA verifies base SHA.
   state.prUrl=null;
   state.handoffNote=evidence.summary;
   state.status='completed';
   state.message='Разработчик подтвердил существующую реализацию в базовой ветке. Требуется независимый QA.';
   return true;
  };
  let attempt=await runCodex(prompt);
  if(!attempt.files.stdout.trim()){
   if(await completeWithoutEdits(attempt))return;
   if(timeLeft()<45000)throw Error('Не представлены ни изменения, ни подтверждение готовой реализации; времени на повторную попытку недостаточно');
   state.message='Уточняет результат разработки: изменения, повторное использование PR или доказательство готового кода';
   attempt=await runCodex(prompt+'\n\nПовторная попытка: если код уже соответствует замечаниям QA, обязательно предъяви RESULT: no_changes_needed и REWORK_REVIEW с явным объяснением, ссылками на файлы и проверяемыми причинами; если реализация уже в базовой ветке — используй RESULT: already_implemented и IMPLEMENTATION_EVIDENCE. Иначе исправь код. Не меняй файлы только ради коммита. Предыдущий ответ: '+String(attempt.answer||'').slice(-1100));
   if(!attempt.files.stdout.trim()){
    if(await completeWithoutEdits(attempt))return;
    throw Error('Агент не представил изменений или проверяемого доказательства уже реализованной задачи: '+String(attempt.answer||'').slice(-1300));
   }
  }
  assertJobActive(job.id);
  const previous=(await git('rev-parse','HEAD')).stdout.trim();
  state.message='Создание коммита';
  await git('add','--all');
  const staged=await git('diff','--cached','--name-only');
  if(staged.stdout.split('\n').some(x=>/(^|\/)(\.env(\.|$)|auth\.json$|\.git\/|credentials(\.|\/|$))/.test(x)))
   throw new Error('Обнаружены потенциально секретные файлы. Коммит отменён');
  await command('git',['-c','user.name=AI Development Orchestrator','-c','user.email=ai-orchestrator@users.noreply.github.com',
   'commit','-m','AI: '+job.title.slice(0,120)],{cwd:dir,env:gitEnv,timeout:30000});
  const handoff=String(attempt.answer||'').match(/HANDOFF_NOTE:\s*([^\n\r]{1,2800})/i)?.[1]?.trim()||'';
  state.handoffNote=/^(none|нет|отсутствуют)[.!]?$/i.test(handoff)?'':handoff.slice(0,2500);
   const learning=String(attempt.answer||'').match(/LEARNING_SUGGESTION:\s*([^\n\r]{1,1600})/i)?.[1]?.trim()||'';
   state.learningSuggestion=/^(none|нет|отсутствуют)[.!]?$/i.test(learning)?'':learning.slice(0,1600);
  const commit=(await git('rev-parse','HEAD')).stdout.trim();
  assertJobActive(job.id);
  state.checkpoint={previous,commit};
  state.message='Отправка ветки GitHub';
  saveJob(job,state);
  await git('push','-u','origin','HEAD:refs/heads/'+branch);
  assertJobActive(job.id);
  state.message='Создание Pull Request';
  const prBody=String(attempt.answer||'').replace(/^LEARNING_SUGGESTION:.*$/gmi,'').trim();
  const prUrl=await ensureTaskPullRequest(job,branch,commit,prBody||'Изменения подготовлены.');
  assertJobActive(job.id);
  state.prUrl=prUrl;state.completionKind='pr';state.status='completed';state.message='Pull Request создан. Проверь изменения перед слиянием.';
 }catch(e){
  if(!cancelledJobs.has(job.id)){state.status='failed';state.message=String(e?.message||e).replaceAll(job.token,'[REDACTED]').slice(0,3500);}
 }finally{
  // Workspace is retained until the task is closed and explicitly archived.
 }
}

/** Merge the current target branch into a PR branch, using Codex only for real conflicts.
 * The worker holds the per-task branch lock while resolving and pushing.
 * Codex never receives the GitHub token; git commands carry it through env.
 */
async function auditCodexPrompt(job,role,prompt){
 const endpoint=String(process.env.ADO_AGENT_API_URL||'');
 if(!endpoint.includes('/internal/agent-tools'))return;
 try{
  await fetch(endpoint.replace(/\/internal\/agent-tools.*$/,'/internal/agent-prompt'),{
   method:'POST',headers:{'X-Runner-Secret':process.env.RUNNER_SHARED_SECRET||'','Content-Type':'application/json'},
   body:JSON.stringify({projectId:job.projectId,processId:job.id,role,prompt}),
   signal:AbortSignal.timeout(4000)
  });
 }catch{ /* A diagnostics failure must never interrupt the agent. */ }
}

// A first-pass AI test agent runs within the disposable Codex container.
// No persistent environment provisioning or Docker socket is exposed to it.
const runTestJob=createQaJobRunner({
 command,assertJobActive,saveJob,isolatedTaskPolicy,cliEnv,persistentCli,
 auditCodexPrompt,codexJsonResult,addUsage,
 browser:{health:browserHealth,open:openQaBrowserSession,evidence:getQaBrowserEvidence,screenshots:getQaScreenshotEvidence,close:closeQaBrowserSession},
 isCancelled:id=>cancelledJobs.has(id)
});

async function runArchitectureReviewJob(job,state,context){
 const workspace=await mkdtemp(join(tmpdir(),'ado-architect-'));
 const dir=join(workspace,'repo');
 try{
  state.message='Получение неизменяемого коммита для архитектурного ревью';
  await command('git',['clone','--branch',job.branch||job.taskId,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workspace,env:gitEnvironment(job.token),timeout:90000,jobId:job.id});
  const head=(await command('git',['rev-parse','HEAD'],{cwd:dir,jobId:job.id})).stdout.trim();
  if(head!==job.expectedCommit)throw Error('PR изменился до архитектурного ревью');
  await command('git',['fetch','origin',job.baseBranch],{cwd:dir,env:gitEnvironment(job.token),jobId:job.id,timeout:90000});
  const policy=await isolatedTaskPolicy(workspace,dir,job.id,false,false);
  const prompt=assembleAgentPrompt({
   identity:'Независимый архитектор / Tech Lead. '+String(job.agentInstructions||'').slice(0,1200),
   objective:'Независимо проверь код текущего PR на соответствие требованиям. '+job.title+'\n'+String(job.description||'').slice(0,8000),
   scope:'Репозиторий '+job.repository+'; базовая ветка '+job.baseBranch+'; проверяемый SHA '+head,
   policy:'Не изменяй файлы, не выполняй git push/commit; не объявляй предположения доказанными дефектами.',
   tools:'Локальный diff origin/'+job.baseBranch+', исходные файлы, тесты, связанные модули, MCP задачи и документации.',
   protocol:'Проверь реальный diff, соседние модули, совместимость контрактов/БД/API, безопасность и регрессии. При необходимости прочитай актуальную задачу через orchestrator.tasks.read. Блокируют только подтверждённые нарушения, не вкусовые замечания.',
   output:'Только JSON: {"verdict":"approved|changes_requested","summary":"...","findings":[{"severity":"blocking|advice","file":"путь","reason":"факт","suggestion":"исправление"}]}. При blocking verdict=changes_requested, иначе approved; каждый пункт с конкретным файлом.',
   budget:13000
  });
  state.message='Независимое ревью архитектора';
  const result=await persistentCli({
   scope:{projectId:job.projectId,taskId:job.taskId,role:'architect'},
   requestId:job.id+':review',model:job.model,reasoning:job.reasoning,
   prompt,cwd:dir,env:{...cliEnv,...context.env},policyArgs:policy.execArgs,
   mcpArgs:context.args,jobId:job.id,timeout:Math.min(1200000,job.maxRuntimeSeconds*1000),
   maxOutputChars:150000
  });
  state.threadId=result.threadId;
  const parsed=codexJsonResult(result.stdout);
  const response=String(parsed.message||'').trim().replace(/^`{3}(?:json)?\s*/i,'').replace(/\s*`{3}$/,'');
  const start=response.indexOf('{'),end=response.lastIndexOf('}');
  if(start<0||end<=start)throw Error('Архитектор не вернул проверяемый JSON отчёт');
  const report=JSON.parse(response.slice(start,end+1));
  if(!['approved','changes_requested'].includes(report.verdict)||typeof report.summary!=='string'||
    !Array.isArray(report.findings)||report.findings.length>30||
    report.findings.some(x=>!['blocking','advice'].includes(x.severity)||typeof x.file!=='string'||typeof x.reason!=='string'||typeof x.suggestion!=='string')||
    (report.verdict==='approved'&&report.findings.some(x=>x.severity==='blocking')))
   throw Error('Ревью архитектора не прошло валидацию');
  state.reviewReport={verdict:report.verdict,summary:report.summary.slice(0,2000),
   findings:report.findings.map(x=>({severity:x.severity,file:x.file.slice(0,300),reason:x.reason.slice(0,1600),suggestion:x.suggestion.slice(0,1600)}))};
  state.reviewedCommit=head;state.usage=parsed.usage;
  state.status='completed';state.message=report.verdict==='approved'?'Архитектор одобрил PR':'Архитектор запросил исправления';
 }finally{await rm(workspace,{recursive:true,force:true}).catch(()=>{});}
}

async function runConflictJob(job,state,context){
 const workspace=await mkdtemp(join(tmpdir(),'ado-conflict-'));
 const dir=join(workspace,'repo');
 const gitEnv=gitEnvironment(job.token);
 const git=(...args)=>command('git',args,{cwd:dir,env:gitEnv,jobId:job.id,timeout:90000});
 try{
  state.message='Получение свежих веток PR и целевой ветки';
  await command('git',['clone','--branch',job.taskId,'https://github.com/'+job.repository+'.git',dir],{cwd:workspace,env:gitEnv,jobId:job.id,timeout:90000});
  await git('fetch','origin',job.baseBranch);
  if(await resumePublishedCommit(job,state,git)){
   assertJobActive(job.id);
   state.status='completed';state.message='Готовое разрешение конфликта восстановлено из GitHub';
   state.branch=job.taskId;
   return;
  }
  const headBefore=(await git('rev-parse','HEAD')).stdout.trim();
  const targetSha=(await git('rev-parse','FETCH_HEAD')).stdout.trim();
  let conflicts=[];
  try{await git('-c','user.name=AI Development Orchestrator','-c','user.email=ai-orchestrator@users.noreply.github.com','merge','--no-edit','FETCH_HEAD');}
  catch(error){
   const unmerged=(await git('diff','--name-only','--diff-filter=U')).stdout.trim();
   conflicts=unmerged.split('\n').filter(Boolean);
   if(!conflicts.length)throw error;
  }
  if(conflicts.length){
   state.message='Codex устраняет '+conflicts.length+' конфликт(ов) в локальной копии';
   const prompt=assembleAgentPrompt({
    identity:'AI-разработчик, разрешающий конфликт слияния',
    objective:'Сохрани совместимые изменения PR и целевой ветки при разрешении Git merge conflicts. '+job.title+'\n'+String(job.description||'').slice(0,10000),
    scope:'Репозиторий '+job.repository+'; целевая ветка '+job.baseBranch+'; PR '+job.taskId,
    policy:'Работай только в локальной копии. Запрещены git commit/push/checkout/reset, GitHub API и изменения секретов.',
    tools:'Локальный git diff, файлы с конфликтами, чтение задачи и связанной документации через MCP.',
    protocol:'Разбери обе версии каждого конфликтующего участка и окружающий код, устрани маркеры, по возможности выполни локальные тесты. Если правильное поведение требует решения владельца — не угадывай.',
    output:'При невозможности разрешить неоднозначность напиши NEEDS_USER: конкретный вопрос. Иначе оставь разрешённые файлы локально; Runner проверит diff и выполнит коммит.',
    runtime:'Конфликтующие файлы: '+conflicts.join(', ').slice(0,2200),
    budget:14000
   });
   const policy=await isolatedTaskPolicy(workspace,dir,job.id);
   const result=await persistentCli({
    scope:{projectId:job.projectId,taskId:job.taskId,role:'conflict_resolver'},
    requestId:job.id+':resolve',model:job.model,reasoning:job.reasoning,prompt,
    cwd:dir,env:{...cliEnv,...context.env},policyArgs:policy.execArgs,
    mcpArgs:context.args,jobId:job.id,timeout:Math.min(job.maxRuntimeSeconds*1000,900000)
   });
   state.threadId=result.threadId;
   const parsed=codexJsonResult(result.stdout);
   state.usage=parsed.usage;
   const answer=parsed.message||'';
   if(/NEEDS_USER\s*:/i.test(answer))throw new Error('Требуется решение пользователя: '+answer.slice(answer.search(/NEEDS_USER\s*:/i)+11,answer.search(/NEEDS_USER\s*:/i)+850));
   await git('add','--all');
   const stillUnmerged=(await git('ls-files','-u')).stdout.trim();
   if(stillUnmerged)throw new Error('Не все конфликты разрешены автоматически. Нужна проверка: '+conflicts.join(', '));
   const changed=(await git('diff','--cached','--name-only')).stdout.split('\n').filter(Boolean);
   if(changed.some(x=>/(^|\/)(\.env(\.|$)|auth\.json$|\.git\/|credentials(\.|\/|$))/.test(x)))
    throw new Error('Разрешение затронуло секретные файлы, автоматическое слияние отменено');
   await git('diff','--cached','--check');
   // A resolved file may have no staged diff if the chosen side matches HEAD.
   await command('git',['-c','user.name=AI Development Orchestrator','-c','user.email=ai-orchestrator@users.noreply.github.com',
    'commit','-m','Resolve PR conflicts with '+job.baseBranch],{cwd:dir,env:gitEnv,jobId:job.id,timeout:30000});
  }
  // Refuse to overwrite concurrent edits to the PR branch.
  const remoteHead=(await git('ls-remote','origin','refs/heads/'+job.taskId)).stdout.split(/\s+/)[0];
  if(remoteHead!==headBefore)throw new Error('Ветка PR изменилась во время разрешения конфликтов. Повтори операцию.');
  const remoteTarget=(await git('ls-remote','origin','refs/heads/'+job.baseBranch)).stdout.split(/\s+/)[0];
  if(remoteTarget!==targetSha)throw new Error('Целевая ветка изменилась во время разрешения конфликтов. Повтори операцию.');
  const commit=(await git('rev-parse','HEAD')).stdout.trim();
  assertJobActive(job.id);
  state.checkpoint={previous:headBefore,commit};
  saveJob(job,state);
  await git('push','origin','HEAD:refs/heads/'+job.taskId);
  assertJobActive(job.id);
  state.status='completed';state.message='Конфликты устранены, ветка PR обновлена';
  state.branch=job.taskId;state.resolvedFiles=conflicts;
 }catch(error){
  if(!cancelledJobs.has(job.id)){state.status='failed';state.message=String(error?.message||error).replaceAll(job.token,'[REDACTED]').slice(0,1800);}
 }finally{await rm(workspace,{recursive:true,force:true}).catch(()=>{});}
}
async function readJson(req,maxLength=50000){
 let text='';
 for await(const chunk of req){
  text+=chunk.toString();
  if(text.length>maxLength)throw Error('Слишком большой запрос');
 }
 return JSON.parse(text);
}

// Cache account limits for 75 seconds. Failed requests may use a clearly
// marked last-good snapshot for at most ten minutes.
const rateLimitCache=createRateLimitCache(()=>readCodexRateLimits(spawn,{
 cwd:'/opt/codex-runner',env:cliEnv,timeoutMs:16000
}));
function safeQuotaFailure(error){
 const message=String(error?.message||error||'Неизвестная ошибка');
 return message
  .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi,'Bearer [REDACTED]')
  .replace(/\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/g,'[REDACTED]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[REDACTED]@')
  .slice(0,250);
}

http.createServer(async(req,res)=>{
 try {
  if(!authorized(req))return reply(res,403,{error:'Forbidden'});
  if(req.method==='GET'&&(req.url==='/usage-limits'||req.url.startsWith('/usage-limits?'))){
   const refresh=new URL(req.url,'http://localhost').searchParams.get('refresh')==='1';
   try{return reply(res,200,await rateLimitCache.read({force:refresh}));}
   catch(error){
    const reason=safeQuotaFailure(error);
    process.stderr.write('[rate-limits] Codex app-server: '+reason+'\n');
    return reply(res,503,{error:reason});
   }
  }
  if(req.method==='GET'&&req.url==='/status'){
   const state=await connected();return reply(res,200,{...state,login:deviceAuth.activeLogin()});
  }
  if(req.method==='POST'&&req.url==='/login'){
   if((await connected()).connected)return reply(res,200,{connected:true});
   rateLimitCache.invalidate();runLogin();return reply(res,202,{connected:false,login:deviceInfo()});
  }
  if(req.method==='GET'&&req.url==='/device')return reply(res,200,{login:deviceInfo()});
  if(req.method==='POST'&&req.url==='/logout'){
   rateLimitCache.invalidate();
   await deviceAuth.logout();
   return reply(res,200,{connected:false});
  }
  if(req.url==='/agent'&&req.method==='POST'){
   if(activeChatRequests>=20)return reply(res,429,{error:'Очередь агентных диалогов заполнена'});
   const data=await readJson(req,9*1024*1024);
   if(!validAgentRequest(data))return reply(res,400,{error:'Неверный агентный запрос'});
   const roleKey=['manager','analyst','business_analyst'].includes(data.agent_role)&&/^[a-f0-9-]{36}$/.test(data.project_id||'')?data.project_id+':'+(data.agent_role==='business_analyst'?'analyst':data.agent_role):null;
    if(roleKey&&(activeAgentRoles.get(roleKey)||0)>=(data.role_capacity||1))return reply(res,429,{error:'Исполнитель этой роли занят'});
    if(roleKey)activeAgentRoles.set(roleKey,(activeAgentRoles.get(roleKey)||0)+1);
    activeChatRequests++;
   try{
    if(!(await connected()).connected)return reply(res,409,{error:'Сначала подключи Codex CLI'});
    // The shell policies keep the MCP session out of project commands.
    const context=agentMcp(data.session_token,agentApi);
    const scope=conversationThreadScope(data,'analyst');
    const previous=await threadStore.read(scope);
    const result=await withRunnerImages(data.images,imageArgs=>appExecutor({
     scope,requestId:String(data.request_id||data.session_token),
     prompt:previous&&typeof data.resume_prompt==='string'&&data.resume_prompt.trim()?data.resume_prompt:data.prompt,model:data.model,effort:data.reasoning,cwd:'/opt/codex-runner',
     timeout:240000,configArgs:[...appConversationSettings,...context.args],
     envOverrides:context.env,images:imagePaths(imageArgs),
     sandboxPolicy:{type:'readOnly',access:{type:'fullAccess'}}
    }));
    const message=result.message.trim();
    if(!message)return reply(res,502,{error:'Агент не вернул итоговое сообщение'});
    if(message.length>120000)return reply(res,413,{error:'Итоговый ответ агента превышает размер'});
    return reply(res,200,{message,usage:result.usage,thread_id:result.threadId,turn_id:result.turnId});
   }catch(error){
    return reply(res,503,{error:'Агент Codex: '+String(error?.message||error).slice(0,900)});
   }finally{activeChatRequests--;if(roleKey)activeAgentRoles.set(roleKey,Math.max(0,(activeAgentRoles.get(roleKey)||1)-1));}
  }
  if(req.url==='/assistant'&&req.method==='POST'){
   if(activeChatRequests>=MAX_PARALLEL_CHAT)return reply(res,429,{error:'Сейчас выполняется несколько AI-диалогов. Повтори запрос немного позже.'});
   const data=await readJson(req,9*1024*1024);
   const invalidAssistant=assistantRequestError(data);
   if(invalidAssistant)return reply(res,400,{error:invalidAssistant});
   activeChatRequests++;
   try{
    if(!(await connected()).connected)return reply(res,409,{error:'Сначала подключи Codex CLI в настройках аккаунта'});
    const result=await withReaderContext(agentApi,jobKey,data.context,context=>
     withRunnerImages(data.images,imageArgs=>appExecutor({
      scope:{...conversationThreadScope(data,'assistant'),role:'assistant:'+String(data.context?.role||'general')},requestId:String(data.request_id||randomUUID()),
      prompt:scopedAgentPrompt(context,data.prompt),model:data.model,effort:data.reasoning,
      cwd:'/opt/codex-runner',timeout:240000,
      configArgs:[...appConversationSettings,...context.args],
      envOverrides:context.env,images:imagePaths(imageArgs),
      sandboxPolicy:{type:'readOnly',access:{type:'fullAccess'}}
     })));
    const message=result.message.trim();
    if(!message)return reply(res,502,{error:'Codex вернул пустой ответ'});
    if(message.length>120000)return reply(res,413,{error:'Слишком объёмный ответ AI для одного этапа. Раздели итоговую документацию на несколько частей.'});
    return reply(res,200,{message,usage:result.usage,thread_id:result.threadId,turn_id:result.turnId});
   }catch(error){
    return reply(res,503,{error:'Codex: '+String(error?.message||error).slice(0,900)});
   }finally{activeChatRequests--;}
  }
  if(req.url==='/jobs'&&req.method==='POST'){
   const job=await readJson(req);
   const invalidJob=runnerJobRequestError(job);
   if(invalidJob)return reply(res,400,{error:invalidJob});
   const previous=readJob(job.id);
   const identity=jobIdentity(job);
   if(previous&&JSON.stringify(previous.identity)!==JSON.stringify(identity))
    return reply(res,422,{error:'Идентификатор запуска относится к другому заданию'});
   if(previous&&previous.state.status!=='interrupted')
    return reply(res,409,{error:'Запуск с таким ID уже существует'});
   const restarts=(previous?.state.restarts||0)+(previous?1:0);
   const state={...previous?.state,id:job.id,status:restarts>2?'failed':'queued',
    message:restarts>2?'Исчерпаны попытки восстановления исполнителя':'Задача принята в очередь',
    baseBranch:job.baseBranch,createdAt:previous?.state.createdAt||new Date().toISOString(),startedAt:null,restarts};
   saveJob(job,state);
   if(state.status==='failed')return reply(res,202,state);
   activeJobs.set(job.id,{identity,state,secret:job.token});
   jobQueue.push({job,state});
   startNextJobs();
   return reply(res,202,state);
  }
  if(req.method==='POST'&&/^\/jobs\/[a-f0-9-]{36}\/cancel$/.test(req.url||'')){
   const id=req.url.split('/')[2],record=readJob(id),state=record?.state;
   if(!state)return reply(res,404,{error:'Запуск не найден'});
   if(!['queued','running','interrupted'].includes(state.status))return reply(res,409,{error:'Запуск уже завершён'});
   cancelledJobs.add(id);
   const index=jobQueue.findIndex(item=>item.job.id===id);
   const [queued]=index>=0?jobQueue.splice(index,1):[];
   const child=jobChildren.get(id);stopCommand(child);
   state.status='cancelled';state.message='Остановлено пользователем';
   journal.save({identity:record.identity,state},record.secret??queued?.job.token);
   if(!child&&!runningJobIds.has(id)){activeJobs.delete(id);cancelledJobs.delete(id);}
   startNextJobs();
   return reply(res,200,{ok:true,status:'cancelled'});
  }
  if(req.method==='GET'&& /^\/jobs\/[a-f0-9-]{36}$/.test(req.url||'')){
   const job=readJob(req.url.slice(6));
   return job?reply(res,200,job.state):reply(res,404,{error:'Задача не найдена (возможно, исполнитель перезапущен)'});
  }
  if(req.method==='POST'&&req.url==='/test'){
   if(!(await connected()).connected)return reply(res,409,{error:'Codex ещё не подключён'});
   // execFile leaves stdin open as a pipe. Codex then waits for EOF and
   // prints "Reading additional input from stdin..." instead of starting.
   // Explicitly disable stdin for unattended execution.
   const result=await new Promise((resolve,reject)=>{
    const child=spawn('codex',['exec','--ephemeral','--skip-git-repo-check',...conversationPolicy,'Ответь ровно: подключение работает'],{
     cwd:'/opt/codex-runner',env:cliEnv,stdio:['ignore','pipe','pipe']
    });
    let stdout='',stderr='',finished=false,timedOut=false;
    const maxOutput=30000;
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-maxOutput);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-maxOutput);});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},120000);
    const settle=(error)=>{
     if(finished)return;finished=true;clearTimeout(timer);
     if(error)reject(error);else resolve({stdout,stderr});
    };
    child.on('error',settle);
    child.on('close',(code,signal)=>{
     if(timedOut)return settle(new Error('Превышено время выполнения Codex (120 секунд). '+stderr.slice(-500)));
     if(code!==0)return settle(new Error('Codex завершился с кодом '+code+(signal?' ('+signal+')':'')+': '+stderr.slice(-1200)));
     settle();
    });
   });
   return reply(res,200,{ok:true,message:result.stdout.trim().slice(0,1000)});
  }
  return reply(res,404,{error:'Not found'});
 }catch(e){return reply(res,503,{error:'Codex: '+String(e.message||e).slice(0,300)});}
}).listen(4300,'0.0.0.0');

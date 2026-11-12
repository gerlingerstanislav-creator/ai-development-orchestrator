import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {startQaBrowserGateway,openQaBrowserSession,getQaBrowserEvidence,closeQaBrowserSession,browserHealth} from './browser-gateway.mjs';
import {jobIdentity,openJobJournal,recoveryAction,runtimeLimitResult} from './job-journal.mjs';
import {codexFailureDetail,conversationPolicy,createTaskPolicy,gitEnvironment,runnerEnvironment} from './execution-policy.mjs';
import {qaPrerequisiteError} from './qa-preflight.mjs';
import {qaBaselineCommands,readQaCommands,readQaReceipts,verifyQaExecution} from './qa-run-evidence.mjs';
import {withRunnerImages} from './chat-images.mjs';
import {createRateLimitCache,readCodexRateLimits} from './rate-limits.mjs';
import {agentMcp,withReaderContext} from './agent-context.mjs';
import {jobRole,projectKey,nextRunnableJobIndex} from './job-scheduler.mjs';
import {parseExistingImplementation} from './development-outcome.mjs';

const execFileAsync=promisify(execFile);
const home=process.env.CODEX_HOME||'/home/node/.codex';
await mkdir(home,{recursive:true,mode:0o700});
const config=join(home,'config.toml');
try { await access(config); } catch { await writeFile(config,'cli_auth_credentials_store = "file"\n',{mode:0o600}); }
// Loopback-only CONNECT tunnel: use IPv4 resolution to avoid the Rust CLI's
// dual-stack DNS failures observed on some Docker/VPN networks.
// No plaintext TLS content or credentials are read by this tunnel.
let proxyAttempts=0,proxySuccess=0,proxyLastError='';
const proxyServer=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
proxyServer.on('connect',(req,client,head)=>{
 proxyAttempts++;
 const target=req.url||'';
 const match=/^([a-z0-9.-]+):(443)$/.exec(target);
 const host=match?.[1]||'';
 const allowed=host==='auth.openai.com'||host==='api.openai.com'||host==='chatgpt.com'||host.endsWith('.openai.com')||host.endsWith('.chatgpt.com');
 if(!allowed){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
 const remote=net.connect({host,port:443,family:4,timeout:12000});
 let established=false;
 remote.once('connect',()=>{proxySuccess++;established=true;client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head?.length)remote.write(head);remote.pipe(client);client.pipe(remote);});
 remote.on('error',(e)=>{proxyLastError=e.code||e.message||'connection_error';if(!established)client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');else client.destroy();});
 remote.on('timeout',()=>{proxyLastError='timeout';remote.destroy();});
 client.on('error',()=>remote.destroy());
 client.on('close',()=>remote.destroy());
});
proxyServer.listen(4399,'127.0.0.1');
startQaBrowserGateway();
const proxyUrl='http://127.0.0.1:4399';
const baseEnv=runnerEnvironment();
const cliEnv={...baseEnv,HOME:process.env.HOME||'/home/node',CODEX_HOME:home,SSL_CERT_FILE:'/etc/ssl/certs/ca-certificates.crt',HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1'};
const codexDotenv=join(home,'.env');
// The Codex binary can load proxy settings from its own .env; provide
// the same loopback proxy there in addition to the child environment.
await writeFile(codexDotenv,`HTTP_PROXY=${proxyUrl}\nHTTPS_PROXY=${proxyUrl}\nhttp_proxy=${proxyUrl}\nhttps_proxy=${proxyUrl}\nNO_PROXY=localhost,127.0.0.1,::1\nno_proxy=localhost,127.0.0.1,::1\n`,{mode:0o600});
async function probeProxyEndpoint(){
 // Replicate the HTTP CONNECT + verified TLS path used by Codex.
 // Never report response bodies or OAuth credentials.
 return await new Promise(resolve=>{
  let done=false;
  const finish=message=>{if(done)return;done=true;resolve(message);};
  const req=http.request({host:'127.0.0.1',port:4399,method:'CONNECT',path:'auth.openai.com:443',timeout:12000});
  req.on('connect',(response,socket)=>{
   if(response.statusCode!==200){socket.destroy();finish('Прокси: CONNECT HTTP '+response.statusCode);return;}
   const secure=tls.connect({socket,servername:'auth.openai.com',rejectUnauthorized:true});
   secure.setTimeout(12000);
   secure.once('secureConnect',()=>{
    secure.write('POST /api/accounts/deviceauth/usercode HTTP/1.1\r\nHost: auth.openai.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
   });
   let responseText='';
   secure.on('data',chunk=>{
    responseText+=(chunk.toString('utf8')).slice(0,256);
    const match=responseText.match(/^HTTP\/1\.[01] (\d{3})/);
    if(match){secure.destroy();finish('Прокси + TLS: HTTP '+match[1]);}
   });
   secure.on('end',()=>{if(!done)finish('Прокси + TLS: нет HTTP-ответа');});
   secure.on('error',e=>finish('Прокси + TLS: '+String(e.code||e.message).slice(0,90)));
   secure.on('timeout',()=>{secure.destroy();finish('Прокси + TLS: таймаут');});
  });
  req.on('error',e=>finish('Прокси CONNECT: '+String(e.code||e.message).slice(0,90)));
  req.on('timeout',()=>{req.destroy();finish('Прокси CONNECT: таймаут');});
  req.end();
 });
}

async function probeAuthEndpoint(){
 try{
  const response=await fetch('https://auth.openai.com/api/accounts/deviceauth/usercode',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(12000)});
  return 'Node.js HTTPS: HTTP '+response.status;
 }catch(error){const cause=error?.cause;return 'Node.js HTTPS: '+String(cause?.code||cause?.message||error.message).slice(0,100);}
}


let login=null, log='',loginState='idle',started=0,diagnosis='';
const safeText=()=>log.replace(/\x1b\[[0-9;]*m/g,'').slice(-3000);
const reply=(res,status,payload)=>{
 const data=JSON.stringify(payload);
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(data)});
 res.end(data);
};
async function connected() {
 try { const {stdout,stderr}=await execFileAsync('codex',['login','status'],{timeout:10000,maxBuffer:20000,env:cliEnv});
  return {connected:true,detail:(stdout||stderr).trim().slice(0,500)};
 } catch(e) {return {connected:false,detail:'Не авторизован'};}
}
function runLogin(){
 if(login && !login.killed && login.exitCode===null)return;
 log='';diagnosis='';proxyAttempts=0;proxySuccess=0;proxyLastError='';loginState='waiting';started=Date.now();
 login=spawn('codex',['login','--device-auth'],{env:{...cliEnv,RUST_LOG:'warn,reqwest=debug,hyper_util=debug'},stdio:['ignore','pipe','pipe']});
 const child=login;
 const collect=(chunk)=>{log=(log+chunk.toString('utf8')).slice(-10000)};
 child.stdout.on('data',collect);child.stderr.on('data',collect);
 child.on('error',e=>{loginState='error';log+='\n'+e.message;});
 child.on('exit',(code,signal)=>{if(login===child){loginState=code===0?'completed':loginState==='expired'?'expired':'error';if(code!==0){log+='\nCodex login завершился: '+(signal||code);const connections=proxyAttempts,successes=proxySuccess,proxyError=proxyLastError;void Promise.all([probeAuthEndpoint(),probeProxyEndpoint()]).then(([probe,tunnel])=>{diagnosis=probe+'; '+tunnel+'; Codex через прокси: '+connections+' попыток, '+successes+' соединений'+(proxyError?'; ошибка прокси: '+proxyError:'')+(connections===0?'. Codex не использовал настроенный прокси.':'');});}login=null;}});
 const deadline=setTimeout(()=>{if(login===child){child.kill('SIGTERM');loginState='expired';}},10*60*1000);
 deadline.unref();
}
function deviceInfo(){
 const output=safeText();
 // Only show the actual device-sign-in URL and code after the CLI provides one.
 // Do not mistake the /api/accounts/deviceauth/usercode error endpoint for a login link.
 const url=output.match(/https:\/\/auth\.openai\.com\/codex\/device\b/i)?.[0]||null;
 const code=url?output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/)?.[0]||null:null;
 return {state:loginState,url,code,instructions:output,diagnosis,startedAt:started||null};
}

// Single-flight task runner: all Git operations happen outside the Codex sandbox.
// The GitHub credential is kept in process environment, never in CLI argv or git config files.
const activeJobs=new Map();
const journal=openJobJournal(process.env.RUNNER_STATE_DIR||join(home,'runner-jobs'));
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
function command(binary,args,{cwd,env,timeout=30000,maxOutputChars=16000,jobId,allowNonzero=false}={}){
 return new Promise((resolve,reject)=>{
  if(jobId)assertJobActive(jobId);
  const child=spawn(binary,args,{cwd,env:{...baseEnv,...env},stdio:['ignore','pipe','pipe'],detached:true});
  if(jobId)jobChildren.set(jobId,child);
  let output='',errors='',done=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;stopCommand(child);},timeout);
  child.stdout.on('data',x=>{output=(output+x.toString()).slice(-maxOutputChars);});
  child.stderr.on('data',x=>{errors=(errors+x.toString()).slice(-16000);});
  const secret=env?.ADO_AGENT_SESSION_TOKEN;
  const redact=value=>secret?value.replaceAll(secret,'[REDACTED]'):value;
  const settle=(err,exitCode)=>{
   if(done)return;done=true;clearTimeout(timer);
   if(jobId&&jobChildren.get(jobId)===child)jobChildren.delete(jobId);
   if(err)reject(err);else resolve({stdout:redact(output),stderr:redact(errors),exitCode});
  };
  child.on('error',settle);
  child.on('close',(code)=>{
   if(timedOut)return settle(new Error(binary+' превысил ограничение времени'));
   if(code===null||code!==0&&!allowNonzero){
    const detail=binary==='codex'?codexFailureDetail(redact(output),redact(errors)):errors.slice(-1200);
    return settle(new Error(binary+' завершился с кодом '+code+': '+(detail||'Codex CLI не вернул причину ошибки. Проверь авторизацию Codex и подробный журнал Runner.')));
   }
   settle(undefined,code);
  });
 });
}
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
 const workdir=await mkdtemp(join(tmpdir(),'ado-run-'));
 const dir=join(workdir,'repo');
 const gitEnv=gitEnvironment(job.token);
 const git=(...args)=>command('git',args,{cwd:dir,env:gitEnv,timeout:45000,jobId:job.id});
 // Stable branch identity: one Git branch per task; different agents cannot
 // work in that branch concurrently (startNextJobs locks repository+taskId).
 const branch=job.taskId;
 try{
  state.message='Клонирование репозитория';
  await command('git',['clone','--depth','1','--branch',job.baseBranch,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workdir,env:gitEnv,timeout:75000,jobId:job.id});
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
   await git('checkout','-b',branch,'refs/remotes/origin/'+branch);
  }else if(remoteBranch.status===404){
   await git('checkout','-b',branch);
   state.message='Создание ветки задачи в GitHub';
   // Publish even before Codex edits, so failures retain a stable task branch.
   await git('push','-u','origin','HEAD:refs/heads/'+branch);
  }else{
   throw new Error('Не удалось проверить ветку задачи: GitHub HTTP '+remoteBranch.status);
  }
  state.branch=branch;
  state.message='Изменяет код';
  const prompt=[
   'Ты AI-разработчик, работаешь в настоящей локальной копии GitHub-репозитория.',
   'Рабочая директория является корнем репозитория. У тебя ЕСТЬ доступ на чтение и запись файлов в этой директории.',
   'Цель — довести ЭТАП разработки до подтверждаемого соответствия критериям приёмки. Сам реши, нужны ли изменения кода, переиспользование прежнего PR или проверка уже существующей реализации.',
   'Сначала осмотри файлы проекта. Если в репозитории только README или нет исходников, СОЗДАЙ необходимые исходные файлы с нуля.',
   'Для задачи про простую HTML-страницу достаточно index.html со встроенными CSS и JavaScript; не требуется публикация GitHub Pages.',
   'Когда задача требует сайт или страницу, создай работающий HTML/JS/CSS, не ограничивайся рекомендациями.',
   'Не задавай вопросов о GitHub-репозитории: он уже клонирован и привязан к проекту.',
   'Не трогай секреты, .env, credentials или настройки доступа. Не запускай git push, git commit, git checkout.',
   'Не используй GitHub MCP, GitHub API или другие удалённые инструменты для записи файлов: все изменения выполняй ТОЛЬКО в локальной рабочей папке. За commit, push и PR отвечает оркестратор.',
   'Не изменяй файлы вне рабочей директории. Не устанавливай пакеты из сети.',
   'Используй инструменты чтения задачи, проектных знаний и истории адресно. Для технических неопределённостей можешь консультироваться с другими специалистами и регистрировать доказанные блокеры. Не считай их закрытыми без подтверждения.',
   'Если задача полностью реализована в текущей БАЗОВОЙ ветке и правки не нужны, не создавай фиктивные изменения. Заверши строкой RESULT: already_implemented и отдельной строкой IMPLEMENTATION_EVIDENCE: {"summary":"не менее 40 символов, что реализовано","files":["существующий/путь.ext"],"criteria":["критерий и объяснение с привязкой к файлу"]}. Перечисли только реальные отслеживаемые файлы. QA независимо проверит утверждение; отсутствие PR не означает автоматического успеха.',
   'Если нужны правки, внеси их в доступную рабочую копию. Если задача заблокирована, назови конкретную причину и передай вопрос/блокер подходящему агенту через доступные MCP-инструменты.',
   'Поручение и контекст из общего конструктора: '+String(job.agentPrompt||['Задача: '+job.title+'\n'+job.description,'Инструкции: '+String(job.agentInstructions||'').slice(0,2000),'Правила: '+String(job.projectRules||'').slice(0,1300),'Документация: '+String(job.knowledgeContext||'').slice(0,1700),'Передача: '+String(job.handoffContext||'').slice(0,1100)].join('\n\n')),
   'В конце ответа отдельной строкой укажи HANDOFF_NOTE: <1–3 предложения простым языком для карточки: что изменилось, как это влияет на задачу и что требует внимания>. Если отдельного комментария нет, напиши HANDOFF_NOTE: none. Детали реализации оставь в основном отчёте. Не включай секреты.',
    'Если выявлен один повторно применимый урок для твоей роли, в последней строке укажи LEARNING_SUGGESTION: <конкретное правило с основанием на фактах запуска>; иначе LEARNING_SUGGESTION: none. Это предложение на согласование, не обязательное правило. Не включай секреты или персональные данные.'
  ].join('\n\n');
  const policy=await isolatedTaskPolicy(workdir,dir,job.id);
  const runCodex=async(instruction)=>{
   assertJobActive(job.id);
   const remaining=timeLeft();
   if(remaining<15000)throw new Error('Исчерпано общее время разработки. Последняя попытка не запускается.');
   await auditCodexPrompt(job,'development',context.prefix+instruction);
   const result=await command('codex',[
    'exec','-m',job.model,'-c','model_reasoning_effort="'+job.reasoning+'"',
    '--json','--ephemeral','--skip-git-repo-check',...policy.execArgs,...context.args,context.prefix+instruction
   ],{cwd:dir,env:{...cliEnv,...context.env},timeout:remaining,jobId:job.id});
   // Codex emits tool-use and sandbox diagnostics on stderr.
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
    // The task branch already contains work by a previous developer. Reuse
    // its PR rather than fabricating another file modification.
    const diff=(await git('diff','--name-only','refs/remotes/origin/'+job.baseBranch+'...HEAD')).stdout.trim();
    if(!diff)throw Error('Ветка отличается от базовой, но изменений для PR не обнаружено');
    state.prUrl=await ensureTaskPullRequest(job,branch,head,(attempt.answer||'').slice(0,6000));
    state.branch=branch;state.completionKind='pr';state.status='completed';
    state.message='Существующие изменения в ветке переданы в PR без нового коммита';
    return true;
   }
   const tracked=(await git('ls-files')).stdout.split(/\r?\n/).filter(Boolean);
   const evidence=parseExistingImplementation(attempt.answer||'',{baseSha:base,headSha:head,trackedFiles:tracked});
   if(!evidence)return false;
   state.completionKind='already_implemented';
   state.verifiedCommit=head;
   state.implementationEvidence=evidence;
   state.branch=job.baseBranch;
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
   attempt=await runCodex(prompt+'\n\nПовторная попытка: докажи существующую реализацию с RESULT и IMPLEMENTATION_EVIDENCE, либо сделай действительно необходимые изменения. Не меняй файлы только ради коммита. Предыдущий ответ: '+String(attempt.answer||'').slice(-1100));
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
  await rm(workdir,{recursive:true,force:true}).catch(()=>{});
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
async function runTestJob(job,state,context){
 // Every attempt gets a fresh browser identity, even when the durable QA job ID
 // is retried. The browser host may still hold an orphan from an earlier run.
 const qaBrowserSessionId=randomUUID();
 const workdir=join(process.env.QA_BROWSER_WORKSPACES_DIR||'/var/lib/ado-qa-workspaces','ado-qa-'+qaBrowserSessionId);
 await mkdir(workdir,{recursive:true,mode:0o700});
 const dir=join(workdir,'repo');
 const gitEnv=gitEnvironment(job.token);
 const singlePass=job.testPlan?.singlePass===true;
 const adHoc=singlePass&&job.testPlan.adHoc===true;
 try{
  state.message='Получение ветки для независимой проверки';
  await command('git',['clone','--depth','1','--branch',job.branch||job.taskId,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workdir,env:gitEnv,timeout:90000,jobId:job.id});
  const rev=await command('git',['rev-parse','HEAD'],{cwd:dir,timeout:10000,jobId:job.id});
  const commit=rev.stdout.trim();
  if((job.expectedCommit&&commit!==job.expectedCommit)||(state.testedCommit&&commit!==state.testedCommit))
   throw Error('Ветка PR изменилась. Требуется сверка нового коммита перед QA.');
  assertJobActive(job.id);
  state.testedCommit=commit;
  saveJob(job,state);
  // Probe from INSIDE the actual QA sandbox; a tool installed on the host may
  // not be runnable under bubblewrap. A browser is "available" only when a
  // headless process really starts, not just when "which chromium" succeeds.
  const policy=await isolatedTaskPolicy(workdir,dir,job.id,true,true);
  const probeScript=[
   'for tool in node npm npx python3 pytest git; do if command -v "$tool" >/dev/null 2>&1; then echo "$tool: available"; else echo "$tool: unavailable"; fi; done',
   'for tool in chromium chromium-browser google-chrome playwright; do if command -v "$tool" >/dev/null 2>&1; then echo "$tool: installed but not validated"; else echo "$tool: unavailable"; fi; done',
   'if test -d node_modules; then echo "node_modules: available"; else echo "node_modules: unavailable"; fi',
   'if python3 -c "import sqlite3" >/dev/null 2>&1; then echo "python3_runtime: ok"; else echo "python3_runtime: unavailable"; fi',
   'echo "network_policy: npm/PyPI registries and loopback only"'
  ].join('; ');
  const probe=await command('codex',[...policy.sandboxArgs,'--','sh','-c',probeScript],{
   cwd:dir,env:cliEnv,timeout:25000,maxOutputChars:6000,jobId:job.id
  });
  const browserAvailable=await browserHealth();
  const capabilities=(probe.stdout.trim()+'\nqa_browser: '+(browserAvailable?'playwright chromium available':'unavailable')).slice(0,2500);
  if(browserAvailable){
   const browserSession=openQaBrowserSession(qaBrowserSessionId,(job.testPlan?.cases||[]).map(test=>test.id),{adHoc});
   await writeFile(join(dir,'.ado-browser-session.json'),JSON.stringify(browserSession),{mode:0o600});
  }
  state.capabilities=capabilities;
  const tracked=(await command('git',['ls-files'],{cwd:dir,env:gitEnv,timeout:10000,maxOutputChars:100000,jobId:job.id})).stdout.split(/\r?\n/);
  const prerequisite=qaPrerequisiteError(tracked,capabilities);
  if(prerequisite&&!job.testPlan?.simplified)throw Error(prerequisite);
  const baseline=[];
  if(singlePass){
   const packageJson=tracked.includes('package.json')
    ? await readFile(join(dir,'package.json'),'utf8').then(JSON.parse).catch(()=>null)
    : null;
   for(const check of qaBaselineCommands(tracked,packageJson,capabilities)){
    state.message='Запускает '+check.name;
    try{
     const result=await command('codex',[...policy.sandboxArgs,'--','env',
      'NO_PROXY=localhost,127.0.0.1,::1','no_proxy=localhost,127.0.0.1,::1','sh','-c',check.command],{
      cwd:dir,env:cliEnv,timeout:60000,maxOutputChars:5000,jobId:job.id,allowNonzero:true
     });
     baseline.push({...check,exitCode:result.exitCode,output:(result.stdout+'\n'+result.stderr).trim().slice(-2200)});
    }catch(error){
     assertJobActive(job.id);
     baseline.push({...check,exitCode:null,output:String(error.message||error).slice(-1000)});
    }
   }
  }
  // Keep complete case data in the isolated workspace instead of embedding a huge JSON in the prompt.
  await writeFile(join(dir,'.ado-qa-plan.json'),JSON.stringify(job.testPlan||{}),{mode:0o600});
  const prompt=[
   'Ты независимый AI-тестировщик в отдельной временной копии репозитория.',
   'СНАЧАЛА исследуй проект и реальные возможности среды. Затем запусти ВСЕ доступные и относящиеся к ТЗ проверки (сборка, unit, integration, API, пользовательские сценарии, если для них есть инструменты). Записывай фактические команды и результаты.',
   'Если проект не требует зависимостей, не объявляй его непроверяемым только из-за отсутствия node_modules.',
   baseline.length?'Runner уже запустил стандартные проверки в изоляции. Используй их результаты, если они проверяют нужное поведение. Если команда не прошла из-за зависимостей, подготовь среду и повтори. Сам определи, указывает ли её вывод на дефект или ограничение среды. Фактический результат: '+JSON.stringify(baseline):'',
   singlePass?'Сначала запусти доступную проверку проекта. Для Python используй python3 -m pytest, если в проекте есть тесты. Для Node запусти имеющийся скрипт тестов, установив зависимости при необходимости. Если готовых тестов для требования нет, выполни конкретную проверку с утверждением об ожидаемом результате, например вызови функцию или локальный API с тестовыми данными.': '',
   'Для каждой проверки используй подтверждаемую команду с ID теста: node /opt/codex-runner/qa-exec.mjs case CASE_ID -- node --test ... (или другую конкретную команду). Для дополнительных проверок: node /opt/codex-runner/qa-exec.mjs check CHECK_ID -- npm test, а тот же CHECK_ID верни в поле checks[].evidenceId. Программа сама записывает код выхода и результат; не выдумывай результаты. Для blocked/not_run команду не запускай и оставь command и evidenceId пустыми. В поле command можешь вернуть запускаемую команду, но Runner сверяет ID с реальным протоколом исполнения.',
   'По каждому case_id дай отдельный verdict только по реальным доказательствам проверки; отсутствие возможности исполнения = blocked/not_run. Не требуй дополнительных макетов, точных брейкпоинтов или геометрии, если их нет в утверждённых требованиях. Если задача прямо требует следования конкретному макету, а ссылка/правила действительно отсутствуют, назови это пробелом в требованиях, но не объявляй имеющийся браузер недоступным. Приоритет — проверить все однозначные критерии.',
   'Не утверждай, что пользовательский путь, браузерное действие или ручная проверка выполнены без реального инструмента и воспроизведения.',
   (adHoc?'Для каждого выбранного сценария':'Для КАЖДОГО case_id из плана')+' верни result, evidence и reason. reason для passed/failed = executed; для недоступных сценариев = tool_unavailable|environment_unavailable|manual_only. Если настоящая причина не установлена, reason = unknown (слияние без проверки нельзя рекомендовать).',
   'Для недоступного сценария evidence должно назвать отсутствующий инструмент или среду, конкретную проверку, которая не запускалась, и почему. Не заменяй это общими фразами.',
   'Невозможность установить отсутствующую зависимость из сети — ограничение среды, а не дефект приложения. Указывай такие проверки в checks как not_run; найденную настоящую ошибку проверенного кода показывай как failed.',
   'Массив findings используй ТОЛЬКО для подтверждённых дефектов приложения, а не для отсутствующих инструментов; последние описывай в caseResults.',
   'Разрешено устанавливать зависимости проекта через npm и pip только из разрешённых registry.npmjs.org и PyPI в рабочую копию проекта или локальный venv. Не устанавливай глобальные пакеты, не меняй GitHub, не читай секреты и не пытайся обойти сетевую политику.',
   'Если в проекте есть package-lock.json, используй npm ci; если есть Python-проект, используй python3 -m venv внутри рабочей копии и pip. Запускай unit, integration и API проверки. Записывай фактические команды и коды возврата.',
   'Для очередей с задержками проверяй время через управляемые часы и временную SQLite-базу: НЕ жди настоящие 5 или 15 минут. Для интеграций Telegram используй заглушки отправки; реальные токены не нужны для локальных модульных тестов.',
   'Проверяй текущий PR и ранее слитую регрессию. Не требуй уже готового бота, прогноза или пользовательского пути от отдельного Python-модуля, если они реализуются другими незавершёнными задачами.',
   'Можно поднимать локальный тестовый HTTP-сервер на 127.0.0.1 и запускать тесты против него. Завершай сервер после теста (например, через trap). Не используй внешние живые сервисы: имитируй Telegram, погоду, платежи и время.',
   'ВАЖНО: сетевой proxy Codex сбрасывает NO_PROXY для каждой sandbox-команды. Если Node.js fetch, Playwright или тесты обращаются к локальному HTTP-серверу, запускай клиентскую команду с явными NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 (например: env NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 npm test). Это исключает только localhost из прокси; произвольные внешние хосты по-прежнему запрещены.',
   browserAvailable?'Playwright Chromium ДОСТУПЕН через отдельный защищённый контейнер. Запусти node /opt/codex-runner/browser-client.mjs start, затем для КАЖДОГО проверяемого визуального тест-кейса выполни node /opt/codex-runner/browser-client.mjs assert --case CASE_ID "выражение JS, возвращающее true при выполнении ожидаемого результата". CASE_ID должен ТОЧНО совпадать с case_id из .ado-qa-plan.json. Допустимы дополнительные assert для одного кейса, viewport WIDTH HEIGHT, goto /, click CSS_SELECTOR, fill CSS_SELECTOR VALUE, screenshot. Для дополнительных проверок применяй assert --check CHECK_ID и указывай evidenceId=CHECK_ID в checks. Браузерное подтверждение автоматически сохраняется на стороне Runner и не зависит от текста command. Для отзывчивой вёрстки используй типовые мобильные и десктопные viewport; если в ТЗ нет конкретных размеров, НЕ объявляй их отсутствие нехваткой инструмента или блокером, проверяй отсутствие выхода элементов за границы экрана на репрезентативных ширинах. Отсутствие утверждённого макета само по себе не делает функциональные критерии непроверяемыми: не выдумывай требования о точном расположении. После установки зависимостей или сборки повтори start. Браузер не имеет доступа к интернету или Docker. Не засчитывай скриншот без проверяемого утверждения.':'Браузерный сервис недоступен — браузерные кейсы должны получить blocked/tool_unavailable; не устанавливай Chromium в sandbox.',
   'Тестовая среда не имеет доступа к Docker-сокету, секретам приложения, внутренним сервисам платформы или произвольному интернету. Все команды выполняются в изоляции.',
   'Сбой Codex CLI — не доказательство отсутствия инструментов и не основание автоматически разрешать пропуск проверок.',
   'Используй реальные доступные инструменты и запускай E2E только если браузер или тестовый сервер действительно стартовали; иначе отметь точные недоступные сценарии.',
   'При невозможности проверки не скрывай её. Если все реально доступные проверки выполнены без ошибок, но несколько сценариев недоступны, верни verdict=blocked и точный список таких сценариев. НЕ разрешай слияние самостоятельно — его может согласовать только пользователь.',
   'Если инструмент есть и проверку можно провести, обязательно попробуй. Отсутствие времени, ошибка теста или неподтверждённый результат НЕ является доказательством, что инструмент недоступен.',
   (!singlePass?'Сформируй только JSON: {"verdict":"passed|failed|blocked","summary":"что проверено и результат","handoffNote":"процедурное замечание другому агенту, не часть документации; пустая строка если замечаний нет","findings":[{"severity":"critical|major|minor","description":"дефект","steps":"способ воспроизведения или проверка","expected":"ожидаемый результат","actual":"фактический результат"}],"checks":[{"name":"название проверки","result":"passed|failed|not_run","details":"доказательство"}],"caseResults":[{"case_id":"uuid из плана","result":"passed|failed|blocked|not_run","reason":"executed|tool_unavailable|environment_unavailable|manual_only|unknown","evidence":"команда и результат или причина недоступности"}]}.':'Сформируй JSON по заданной схеме. У каждого caseResults должны быть case_id и title.'),
   'Вердикт failed при обнаружении воспроизводимых проблем. Вердикт passed только при достаточных проверках и отсутствии дефектов. blocked — если проверить нельзя.',
   singlePass?'В summary и handoffNote кратко объясни, что получилось и что мешало. Число проверок подсчитает система.':'Поля summary и handoffNote видны человеку. Коротко объясни результат простым языком, включая сколько сценариев проверено, что осталось и почему. Подробные команды и доказательства запиши в checks и caseResults.',
   'В поле learningSuggestion запиши одно полезное повторно применимое улучшение процесса QA, основанное на фактических проверках этого запуска, или пустую строку. Это предложение на утверждение пользователю, не обязательная инструкция. Не добавляй секреты или персональные данные.',
   'Поручение и контекст из общего конструктора: '+String(job.agentPrompt||['Задача: '+job.title+'\n'+String(job.description).slice(0,6000),'Инструкции: '+String(job.agentInstructions||'').slice(0,1600),'Правила: '+String(job.projectRules||'').slice(0,800),'Документация: '+String(job.knowledgeContext||'').slice(0,900),'Передача: '+String(job.handoffContext||'').slice(0,800)].join('\n\n')),
   'Возможности текущего контейнера, обнаруженные автоматически: '+capabilities,
   prerequisite?'Ограничение среды: '+prerequisite+' Выполни остальные доступные проверки.':'',
   adHoc?'Файл плана пуст. Сам выбери до 20 проверок по ТЗ и изменённому поведению, выполни доступные сразу. Верни для каждой запись caseResults с уникальным case_id qa-1, qa-2 и так далее и понятным title. Включи недоступные сценарии, если они нужны для приёмки.':'План тестирования находится в файле .ado-qa-plan.json в корне текущей временной рабочей копии. Прочитай его полностью перед проверками; проверь КАЖДЫЙ case_id, используй шаги и ожидаемые результаты из файла.',
   'Текущий git commit: '+state.testedCommit
  ].join('\n\n');
  state.message='Проверяет код и запускает доступные тесты';
  const commandField={command:{type:'string'}};
  const titleField=singlePass?{title:{type:'string'}}:{};
  const reportSchema={
   type:'object',additionalProperties:false,
   required:['verdict','summary','handoffNote','learningSuggestion','findings','checks','caseResults'],
   properties:{
    verdict:{type:'string',enum:['passed','failed','blocked']},
    summary:{type:'string'},
    handoffNote:{type:'string'},
     learningSuggestion:{type:'string'},
    findings:{type:'array',items:{type:'object',additionalProperties:false,required:['severity','description','steps','expected','actual'],properties:{
     severity:{type:'string',enum:['critical','major','minor']},description:{type:'string'},steps:{type:'string'},expected:{type:'string'},actual:{type:'string'}}}},
    checks:{type:'array',items:{type:'object',additionalProperties:false,required:['name','result','details','evidenceId',...Object.keys(commandField)],properties:{evidenceId:{type:'string'},...commandField,
     name:{type:'string'},result:{type:'string',enum:['passed','failed','not_run']},details:{type:'string'}}}},
    caseResults:{type:'array',items:{type:'object',additionalProperties:false,required:['case_id','result','reason','evidence',...Object.keys(commandField),...Object.keys(titleField)],properties:{...commandField,...titleField,
     case_id:{type:'string'},result:{type:'string',enum:['passed','failed','blocked','not_run']},
     reason:{type:'string',enum:['executed','tool_unavailable','environment_unavailable','manual_only','unknown']},evidence:{type:'string'}}}}
   }
  };
  const schemaPath=join(workdir,'qa-report.schema.json');
  await writeFile(schemaPath,JSON.stringify(reportSchema),{mode:0o600});
  const verifyReport=message=>{
   const fenced=message.match(/```(?:json)?\s*([\s\S]*?)```/i);
   const source=fenced?.[1]||message;
   const first=source.indexOf('{'),last=source.lastIndexOf('}');
   if(first<0||last<=first)throw Error('AI-тестировщик не вернул JSON');
   let data;
   try{data=JSON.parse(source.slice(first,last+1));}catch{throw Error('AI-тестировщик вернул некорректный JSON');}
   if(!['passed','failed','blocked'].includes(data.verdict)||typeof data.summary!=='string'||!Array.isArray(data.findings)||!Array.isArray(data.checks)||!Array.isArray(data.caseResults))
    throw Error('AI-тестировщик вернул недопустимую структуру отчёта');
   const required=(job.testPlan?.cases||[]).map(c=>c.id);
   if(data.caseResults.some(c=>!c||typeof c.case_id!=='string'||!['passed','failed','blocked','not_run'].includes(c.result)||typeof c.evidence!=='string'||typeof c.reason!=='string'))
    throw Error('Некорректные результаты отдельных тест-кейсов');
   if(required.some(id=>!data.caseResults.some(c=>c.case_id===id)))
    throw Error('В отчёте отсутствуют результаты части тест-кейсов');
   if(adHoc&&(!data.caseResults.length||data.caseResults.length>20||
    new Set(data.caseResults.map(c=>c.case_id)).size!==data.caseResults.length||
    data.caseResults.some(c=>!/^qa-[1-9][0-9]?$/.test(c.case_id)||typeof c.title!=='string'||c.title.trim().length<3||c.title.length>240)))
    throw Error('Отчёт должен содержать уникальные сценарии проверки с названиями');
   return data;
  };
  const args=['exec','-m',job.model,'-c','model_reasoning_effort="'+job.reasoning+'"',
   '--json','--ephemeral','--skip-git-repo-check',...policy.execArgs,
   '--output-schema',schemaPath];
  await auditCodexPrompt(job,'testing',context.prefix+prompt+'\n\nПоле learningSuggestion: краткий вывод или пустая строка.');
  const firstRun=await command('codex',[...args,...context.args,context.prefix+prompt+'\n\nПоле learningSuggestion: краткий вывод или пустая строка.'],{
   cwd:dir,env:{...cliEnv,...context.env},timeout:Math.min(job.maxRuntimeSeconds*1000,900000),maxOutputChars:350000,jobId:job.id
  });
  let parsed=codexJsonResult(firstRun.stdout);
  state.usage=parsed.usage;
  let report,correctionOutput='';
  try{report=verifyReport(parsed.message||'');}
  catch(error){
   state.message='AI-тестировщик завершил проверки, но отчёт некорректен. Повторное форматирование отчёта';
   // The second attempt must not invent successful checks. It only reformats
   // the prior agent's actual evidence into the strict machine-readable schema.
   const correction=[
    'Сформируй валидный JSON-отчёт по указанной схеме. Ранее тестировщик вернул некорректный формат.',
    'Не утверждай о выполнении тестов, для которых нет реальных доказательств в предыдущем ответе.',
    'Неподтверждённые кейсы отмечай blocked/not_run, reason=unknown; не выдавай отсутствие данных за tool_unavailable.',
    'Причина переформатирования: '+String(error.message||error),
    'Case IDs: '+JSON.stringify((job.testPlan?.cases||[]).map(c=>c.id)),
    'Предыдущий ответ тестировщика: '+String(parsed.message||'').slice(0,45000)
   ].join('\n\n');
   await auditCodexPrompt(job,'testing',correction);
   const second=await command('codex',[...args,correction],{
    cwd:dir,env:cliEnv,timeout:Math.min(150000,job.maxRuntimeSeconds*1000),maxOutputChars:200000,jobId:job.id
   });
   correctionOutput=second.stdout;
   const corrected=codexJsonResult(second.stdout);
   state.usage=addUsage(state.usage,corrected.usage);
   report=verifyReport(corrected.message||'');
  }
  assertJobActive(job.id);
  const executedCommands=[...baseline.filter(c=>Number.isInteger(c.exitCode)),...readQaCommands(firstRun.stdout),...readQaCommands(correctionOutput)];
  const receiptText=await readFile(join(dir,'.ado-qa-executions.jsonl'),'utf8').catch(()=>'');
  const receipts=readQaReceipts(receiptText.slice(0,250000),executedCommands);
  report=verifyQaExecution(report,executedCommands,baseline,{receipts,browserEvidence:getQaBrowserEvidence(qaBrowserSessionId)});
  state.executionVerified=true;
  if(adHoc)state.cases=report.cases;
  state.verdict=report.verdict;
  state.summary=report.summary.slice(0,3500);
  state.handoffNote=String(report.handoffNote||'').slice(0,2500);
   state.learningSuggestion=String(report.learningSuggestion||'').slice(0,1600);
  // Keep small screenshots as immutable QA evidence before deleting the workspace.
  const screenshotDir=join(dir,'.ado-qa-evidence');
  const shots=await readdir(screenshotDir).catch(()=>[]);
  const screenshots=[];
  for(const name of shots.filter(name=>/^[0-9a-f-]{36}\.jpg$/i.test(name)).slice(0,3)){
   const bytes=await readFile(join(screenshotDir,name)).catch(()=>null);
   if(bytes&&bytes.length>100&&bytes.length<=180000)screenshots.push({name,mime:'image/jpeg',data:bytes.toString('base64')});
  }
  state.screenshots=screenshots;
  state.findings=report.findings.slice(0,20);
  state.checks=report.checks.slice(0,30);
  state.caseResults=report.caseResults.slice(0,50);
  state.status='completed';
  state.message=singlePass?'Проверено '+report.caseResults.filter(c=>c.result==='passed'||c.result==='failed').length+' из '+report.caseResults.length:
   'Проверка завершена: '+(report.verdict==='passed'?'дефекты не найдены':report.verdict==='failed'?'обнаружены ошибки':'требуется ручная проверка');
 }catch(e){
  if(!cancelledJobs.has(job.id)){state.status='failed';state.message=String(e?.message||e).replaceAll(job.token||'','[REDACTED]').slice(0,1800);}
 }finally{
  // Always stop Chromium before deleting the shared QA workspace. This runs
  // after passed, blocked, failed, cancelled and interrupted agent attempts.
  await closeQaBrowserSession(qaBrowserSessionId);
  await rm(workdir,{recursive:true,force:true}).catch(()=>{});
 }
}
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
  const prompt=[
   'Ты независимый архитектор платформы и Tech Lead. Проведи CODE REVIEW конкретного коммита PR, не меняй файлы.',
   'Изучи реальный код, diff относительно origin/'+job.baseBranch+', соседние модули, тесты, миграции и совместимость.',
   'Опирайся только на доказанные дефекты, не придумывай нарушения и не блокируй PR из-за вкусовых пожеланий.',
   'Блокирующие находки: ошибки архитектуры, нарушение контрактов, security, несовместимость миграций или реальная регрессия.',
   'Если существенных дефектов нет — APPROVED. Некритичные улучшения перечисли как advice, они не блокируют.',
   'ВЕРНИ ТОЛЬКО JSON без markdown: {"verdict":"approved|changes_requested","summary":"...","findings":[{"severity":"blocking|advice","file":"...","reason":"...","suggestion":"..."}]}.',
   'При наличии blocking finding verdict обязан быть changes_requested. Укажи проверяемые конкретные файлы.',
   'Задача: '+job.title+'\n'+String(job.description).slice(0,8000),
   'Инструкции роли: '+String(job.agentInstructions||'').slice(0,6000)
  ].join('\n\n');
  state.message='Независимое ревью архитектора';
  const result=await command('codex',['exec','-m',job.model,'-c','model_reasoning_effort="'+job.reasoning+'"',
   '--json','--ephemeral','--skip-git-repo-check',...policy.execArgs,...context.args,context.prefix+prompt],{
   cwd:dir,env:{...cliEnv,...context.env},jobId:job.id,timeout:Math.min(1200000,job.maxRuntimeSeconds*1000),maxOutputChars:150000
  });
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
async function runDeterministicCiJob(job,state){
 const workspace=await mkdtemp(join(tmpdir(),'ado-ci-'));
 const dir=join(workspace,'repo');
 const gitEnv=gitEnvironment(job.token);
 const checks=[];
 let postgresStarted=false;
 const postgresData=join(workspace,'ci-postgres');
 const socketDir=join(workspace,'scratch','pgsocket');
 let databaseUrl='';
 const run=async(name,args,timeout=120000)=>{
  assertJobActive(job.id);state.message='CI: '+name;
  const commandResult=await command('codex',[...policy.sandboxArgs,'--',...(databaseUrl?['env','DATABASE_URL='+databaseUrl]:[]),...args],{
   cwd:dir,env:cliEnv,timeout,maxOutputChars:9000,jobId:job.id,allowNonzero:true});
  const result={name,exitCode:commandResult.exitCode,output:(commandResult.stdout+'\n'+commandResult.stderr).slice(-3500)};
  checks.push(result);state.ciChecks=checks;saveJob(job,state);
  return result.exitCode===0;
 };
 let policy;
 try{
  state.message='CI: получение точного SHA';
  await command('git',['clone','--branch',job.branch||job.taskId,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workspace,env:gitEnv,timeout:90000,jobId:job.id});
  const head=(await command('git',['rev-parse','HEAD'],{cwd:dir,jobId:job.id})).stdout.trim();
  if(head!==job.expectedCommit)throw Error('SHA PR изменился до запуска CI');
  state.testedCommit=head;
  if(job.baseCommit){
   await command('git',['fetch','origin',job.baseBranch],{cwd:dir,env:gitEnv,jobId:job.id,timeout:90000});
   const base=(await command('git',['rev-parse','FETCH_HEAD'],{cwd:dir,jobId:job.id})).stdout.trim();
   if(base!==job.baseCommit)throw Error('Целевая ветка PR изменилась: необходимо новое CI');
   // Validate conflict-free integration without changing the checked-out PR.
   const merge=await command('git',['-c','user.name=ADO CI','-c','user.email=ci@users.noreply.github.com','merge','--no-commit','--no-ff','FETCH_HEAD'],{
    cwd:dir,env:gitEnv,jobId:job.id,timeout:60000,allowNonzero:true});
   checks.push({name:'merge compatibility',exitCode:merge.exitCode,output:(merge.stdout+'\n'+merge.stderr).slice(-2500)});
   if(merge.exitCode!==0){state.ciChecks=checks;state.ciVerdict='failed';state.status='completed';state.message='CI: конфликт интеграции веток';return;}
  }
  policy=await isolatedTaskPolicy(workspace,dir,job.id,true,true);
  const files=(await command('git',['ls-files'],{cwd:dir,jobId:job.id,maxOutputChars:400000})).stdout.split(/\r?\n/).filter(Boolean);
  const has=(file)=>files.includes(file);
  const pkg=has('package.json')?JSON.parse(await readFile(join(dir,'package.json'),'utf8')):null;
  // A fresh PostgreSQL cluster is local to THIS CI job, socket-only, and erased on exit.
  // Never point arbitrary project tests at the application's real DATABASE_URL.
  const packages=await Promise.all(files.filter(file=>file==='package.json'||file.endsWith('/package.json')).slice(0,30)
   .map(async file=>readFile(join(dir,file),'utf8').then(JSON.parse).catch(()=>null)));
  const needsPg=packages.some(x=>x&&(x.dependencies?.pg||x.devDependencies?.pg));
  if(needsPg){
   state.message='CI: изолированная PostgreSQL-база';
   await mkdir(socketDir,{recursive:true,mode:0o700});
   await command('/usr/lib/postgresql/15/bin/initdb',['-D',postgresData,'-U','orchestrator','--auth-local=trust','--auth-host=reject','--no-instructions'],
    {cwd:workspace,timeout:120000,jobId:job.id,maxOutputChars:6000});
   await command('/usr/lib/postgresql/15/bin/pg_ctl',['-D',postgresData,'-l',join(workspace,'ci-postgres.log'),
    '-o',"-c listen_addresses='' -c shared_buffers=16MB -c max_connections=20 -c fsync=off -k "+socketDir+" -p 5432",'start','-w'],
    {cwd:workspace,timeout:90000,jobId:job.id,maxOutputChars:6000});
   postgresStarted=true;
   await command('/usr/bin/createdb',['-h',socketDir,'-U','orchestrator','orchestrator'],
    {cwd:workspace,timeout:20000,jobId:job.id});
   databaseUrl='postgres://orchestrator@localhost:5432/orchestrator?host='+encodeURIComponent(socketDir);
  }
  let executed=0;
  if(pkg){
   if(!await run('npm dependencies',['npm','install','--no-audit','--no-fund'],480000)){
    state.ciChecks=checks;state.ciVerdict='failed';state.status='completed';state.message='CI: установка зависимостей не выполнена';return;
   }
   for(const name of ['check','build','test']){
    if(pkg.scripts?.[name]){executed++;await run('npm '+name,['npm','run',name],360000);}
   }
   const nodeTests=files.filter(x=>/\.test\.(mjs|js)$/.test(x)).slice(0,200);
   if(nodeTests.length&&!pkg.scripts?.test){executed++;await run('node unit tests',['node','--test',...nodeTests],360000);}
   const syntax=files.filter(x=>/^apps\/(codex-runner|qa-browser)\/.*\.mjs$/.test(x)).slice(0,80);
   for(const filename of syntax){executed++;await run('syntax '+filename,['node','--check',filename],30000);}
  }
  if(files.some(x=>/^(pyproject.toml|pytest.ini|setup.py)$/.test(x))){executed++;await run('python tests',['python3','-m','pytest','-q'],360000);}
  if(!executed){checks.push({name:'supported tests',exitCode:1,output:'Нет известных технических проверок для этого проекта'});}
  state.ciChecks=checks;state.ciVerdict=checks.every(x=>x.exitCode===0)?'passed':'failed';
  state.status='completed';state.message=state.ciVerdict==='passed'?'Собственный CI: все проверки пройдены':'Собственный CI: обнаружены ошибки';
 }finally{
  if(postgresStarted)await command('/usr/lib/postgresql/15/bin/pg_ctl',['-D',postgresData,'stop','-m','immediate','-w'],{
   cwd:workspace,timeout:20000,allowNonzero:true
  }).catch(()=>{});
  await rm(workspace,{recursive:true,force:true}).catch(()=>{});
 }
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
   const prompt=[
    'Ты устраняешь Git merge conflicts после объединения целевой ветки с PR.',
    'Работай ТОЛЬКО в этой локальной копии. Не выполняй git commit, push, checkout, reset или команды с GitHub API.',
    'Изучи обе версии конфликтующих участков, исходную задачу и окружающий код.',
    'Сохрани все совместимые изменения целевой ветки и PR. Не удаляй функциональность ради завершения merge.',
    'Если невозможно достоверно определить правильное поведение без решения пользователя, напиши NEEDS_USER: и конкретный вопрос. Не подменяй неоднозначность произвольным решением.',
    'Иначе разреши каждый конфликт, удали конфликтные маркеры и, по возможности, запусти локальные проверки.',
    'Не создавай и не изменяй .env, credential или файлы авторизации.',
    'Задача: '+job.title,
    'Требования: '+job.description.slice(0,12000),
    'Конфликтующие файлы: '+conflicts.join(', ').slice(0,5000)
   ].join('\n\n');
   const policy=await isolatedTaskPolicy(workspace,dir,job.id);
   const result=await command('codex',[
     'exec','-m',job.model,'-c','model_reasoning_effort="'+job.reasoning+'"',
     '--json','--ephemeral','--skip-git-repo-check',...policy.execArgs,...context.args,context.prefix+prompt
   ],{cwd:dir,env:{...cliEnv,...context.env},jobId:job.id,timeout:Math.min(job.maxRuntimeSeconds*1000,900000)});
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
   const state=await connected();return reply(res,200,{...state,login:loginState!=='idle'?deviceInfo():null});
  }
  if(req.method==='POST'&&req.url==='/login'){
   if((await connected()).connected)return reply(res,200,{connected:true});
   rateLimitCache.invalidate();runLogin();return reply(res,202,{connected:false,login:deviceInfo()});
  }
  if(req.method==='GET'&&req.url==='/device')return reply(res,200,{login:deviceInfo()});
  if(req.method==='POST'&&req.url==='/logout'){
   rateLimitCache.invalidate();
   if(login){login.kill('SIGTERM');login=null;}loginState='idle';log='';
   try{await execFileAsync('codex',['logout'],{timeout:10000,env:cliEnv});}catch{}
   return reply(res,200,{connected:false});
  }
  if(req.url==='/agent'&&req.method==='POST'){
   if(activeChatRequests>=20)return reply(res,429,{error:'Очередь агентных диалогов заполнена'});
   const data=await readJson(req,9*1024*1024);
   if(typeof data.prompt!=='string'||data.prompt.length<1||data.prompt.length>24000||
      !['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'].includes(data.model)||
      !['low','medium'].includes(data.reasoning)||
      typeof data.session_token!=='string'||!/^[a-f0-9]{64}$/.test(data.session_token))
     return reply(res,400,{error:'Неверный агентный запрос'});
   const roleKey=['manager','analyst','business_analyst'].includes(data.agent_role)&&/^[a-f0-9-]{36}$/.test(data.project_id||'')?data.project_id+':'+(data.agent_role==='business_analyst'?'analyst':data.agent_role):null;
    if(roleKey&&(activeAgentRoles.get(roleKey)||0)>=(data.role_capacity||1))return reply(res,429,{error:'Исполнитель этой роли занят'});
    if(roleKey)activeAgentRoles.set(roleKey,(activeAgentRoles.get(roleKey)||0)+1);
    activeChatRequests++;
   try{
    if(!(await connected()).connected)return reply(res,409,{error:'Сначала подключи Codex CLI'});
    // The shell policies keep the MCP session out of project commands.
    const context=agentMcp(data.session_token,agentApi);
    const result=await withRunnerImages(data.images,imageArgs=>command('codex',[
     'exec','-m',data.model,'-c','model_reasoning_effort="'+data.reasoning+'"',
     '--json','--ephemeral','--skip-git-repo-check',...conversationPolicy,...context.args,...imageArgs,data.prompt
    ],{cwd:'/opt/codex-runner',env:{...cliEnv,...context.env},timeout:240000,maxOutputChars:500000}));
    const parsed=codexJsonResult(result.stdout);
    const message=parsed.message.trim();
    if(!message)return reply(res,502,{error:'Агент не вернул итоговое сообщение'});
    if(message.length>120000)return reply(res,413,{error:'Итоговый ответ агента превышает размер'});
    return reply(res,200,{message,usage:parsed.usage});
   }catch(error){
    return reply(res,503,{error:'Агент Codex: '+String(error?.message||error).slice(0,900)});
   }finally{activeChatRequests--;if(roleKey)activeAgentRoles.set(roleKey,Math.max(0,(activeAgentRoles.get(roleKey)||1)-1));}
  }
  if(req.url==='/assistant'&&req.method==='POST'){
   if(activeChatRequests>=MAX_PARALLEL_CHAT)return reply(res,429,{error:'Сейчас выполняется несколько AI-диалогов. Повтори запрос немного позже.'});
   const data=await readJson(req,9*1024*1024);
   if(typeof data.prompt!=='string'||data.prompt.length<1||data.prompt.length>24000||
      !['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'].includes(data.model)||
      !['low','medium'].includes(data.reasoning))
     return reply(res,400,{error:typeof data.prompt==='string'&&data.prompt.length>24000
      ?'AI-запрос слишком большой: '+data.prompt.length+' символов при лимите 24000'
      :'Некорректные параметры AI-запроса'});
   activeChatRequests++;
   try{
    if(!(await connected()).connected)return reply(res,409,{error:'Сначала подключи Codex CLI в настройках аккаунта'});
    const result=await withReaderContext(agentApi,jobKey,data.context,context=>
     withRunnerImages(data.images,imageArgs=>command('codex',[
      'exec','-m',data.model,'-c','model_reasoning_effort="'+data.reasoning+'"',
      '--json','--ephemeral','--skip-git-repo-check',...conversationPolicy,...context.args,...imageArgs,context.prefix+data.prompt
     ],{cwd:'/opt/codex-runner',env:{...cliEnv,...context.env},timeout:240000,maxOutputChars:500000})));
    const parsed=codexJsonResult(result.stdout);
    const message=parsed.message.trim();
    if(!message)return reply(res,502,{error:'Codex вернул пустой ответ'});
    if(message.length>120000)return reply(res,413,{error:'Слишком объёмный ответ AI для одного этапа. Раздели итоговую документацию на несколько частей.'});
    return reply(res,200,{message,usage:parsed.usage});
   }catch(error){
    return reply(res,503,{error:'Codex: '+String(error?.message||error).slice(0,900)});
   }finally{activeChatRequests--;}
  }
  if(req.url==='/jobs'&&req.method==='POST'){
   const job=await readJson(req);
   if(job.kind && !['resolve-conflict','test','review','ci'].includes(job.kind))return reply(res,400,{error:'Недопустимый тип задания'});
   if(typeof job.id!=='string'||! /^[a-f0-9-]{36}$/.test(job.id) ||
    typeof job.taskId!=='string'|| !/^[a-f0-9-]{36}$/.test(job.taskId) ||
    typeof job.repository!=='string'|| !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(job.repository) ||
    (['ci','review'].includes(job.kind)&&(!/^[a-f0-9]{40}$/i.test(job.expectedCommit)||job.baseCommit!==undefined&&!/^[a-f0-9]{40}$/i.test(job.baseCommit)))||
    (job.branch!==undefined&&(typeof job.branch!=='string'||!/^[a-zA-Z0-9_.\/-]+$/.test(job.branch)||job.branch.startsWith('-')))||
    typeof job.baseBranch!=='string'|| !/^[a-zA-Z0-9_.\/-]+$/.test(job.baseBranch) ||
    !['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'].includes(job.model)||
    !['low','medium'].includes(job.reasoning)||
    !Number.isInteger(job.maxRuntimeSeconds)||job.maxRuntimeSeconds<90||job.maxRuntimeSeconds>7200||
    typeof job.token!=='string'||job.token.length<20||
    (job.roleCapacity!==undefined&&(!Number.isInteger(job.roleCapacity)||job.roleCapacity<1||job.roleCapacity>10))||
     typeof job.title!=='string'||job.title.length>300||typeof job.description!=='string')
    return reply(res,400,{error:'Некорректные параметры задачи'});
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

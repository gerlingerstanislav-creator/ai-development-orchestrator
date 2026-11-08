import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

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
const proxyUrl='http://127.0.0.1:4399';
const cliEnv={...process.env,CODEX_HOME:home,SSL_CERT_FILE:'/etc/ssl/certs/ca-certificates.crt',HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1'};
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
const MAX_PARALLEL_DEVELOPMENT=3;
const MAX_PARALLEL_CHAT=4;
const jobQueue=[];
const activeBranches=new Set();
let runningJobs=0;
let activeChatRequests=0;
function startNextJobs(){
 for(let i=0;i<jobQueue.length && runningJobs<MAX_PARALLEL_DEVELOPMENT;){
  const {job,state}=jobQueue[i];
  const branchKey=job.repository+':'+job.taskId;
  if(activeBranches.has(branchKey)){i++;continue;}
  jobQueue.splice(i,1);
  activeBranches.add(branchKey);
  runningJobs++;
  state.status='running';state.startedAt=new Date().toISOString();
  state.message='Запуск разработки в изолированной рабочей папке';
  void runJob(job,state).finally(()=>{
   activeBranches.delete(branchKey);runningJobs--;startNextJobs();
  });
 }
 for(let i=0;i<jobQueue.length;i++)jobQueue[i].state.message='Ожидает свободного исполнителя (очередь '+(i+1)+')';
}
const jobKey=process.env.RUNNER_SHARED_SECRET||'';
if(jobKey.length<32)throw Error('RUNNER_SHARED_SECRET required');
function authorized(req){
 const supplied=req.headers['x-runner-secret'];
 if(typeof supplied!=='string')return false;
 const a=Buffer.from(supplied),b=Buffer.from(jobKey);
 return a.length===b.length && timingSafeEqual(a,b);
}
function command(binary,args,{cwd,env,timeout=30000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let output='',errors='',done=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  child.stdout.on('data',x=>{output=(output+x.toString()).slice(-16000);});
  child.stderr.on('data',x=>{errors=(errors+x.toString()).slice(-16000);});
  const settle=(err)=>{
   if(done)return;done=true;clearTimeout(timer);
   if(err)reject(err);else resolve({stdout:output,stderr:errors});
  };
  child.on('error',settle);
  child.on('close',(code)=>{
   if(timedOut)return settle(new Error(binary+' превысил ограничение времени'));
   if(code!==0)return settle(new Error(binary+' завершился с кодом '+code+': '+errors.slice(-1200)));
   settle();
  });
 });
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
 const result=await response.json();
 return result.html_url;
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
async function runJob(job,state){
 const deadline=Date.now()+job.maxRuntimeSeconds*1000;
 const timeLeft=()=>Math.max(0,deadline-Date.now());
 let cumulativeUsage={input_tokens:0,cached_input_tokens:0,output_tokens:0};
 const workdir=await mkdtemp(join(tmpdir(),'ado-run-'));
 const dir=join(workdir,'repo');
 const auth=Buffer.from('x-access-token:'+job.token).toString('base64');
 const gitEnv={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',
  GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+auth};
 const git=(...args)=>command('git',args,{cwd:dir,env:gitEnv,timeout:45000});
 // Stable branch identity: one Git branch per task; different agents cannot
 // work in that branch concurrently (startNextJobs locks repository+taskId).
 const branch=job.taskId;
 try{
  state.message='Клонирование репозитория';
  await command('git',['clone','--depth','1','--branch',job.baseBranch,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workdir,env:gitEnv,timeout:75000});
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
  state.message='Codex изменяет код';
  const prompt=[
   'Ты AI-разработчик, работаешь в настоящей локальной копии GitHub-репозитория.',
   'Рабочая директория является корнем репозитория. У тебя ЕСТЬ доступ на чтение и запись файлов в этой директории.',
   'ОБЯЗАТЕЛЬНО внеси реальные изменения в файлы, используя доступные инструменты. Одного текстового ответа недостаточно.',
   'Сначала осмотри файлы проекта. Если в репозитории только README или нет исходников, СОЗДАЙ необходимые исходные файлы с нуля.',
   'Для задачи про простую HTML-страницу достаточно index.html со встроенными CSS и JavaScript; не требуется публикация GitHub Pages.',
   'Когда задача требует сайт или страницу, создай работающий HTML/JS/CSS, не ограничивайся рекомендациями.',
   'Не задавай вопросов о GitHub-репозитории: он уже клонирован и привязан к проекту.',
   'Не трогай секреты, .env, credentials или настройки доступа. Не запускай git push, git commit, git checkout.',
   'Не используй GitHub MCP, GitHub API или другие удалённые инструменты для записи файлов: все изменения выполняй ТОЛЬКО в локальной рабочей папке. За commit, push и PR отвечает оркестратор.',
   'Не изменяй файлы вне рабочей директории. Не устанавливай пакеты из сети.',
   'Постарайся выполнить задачу полностью. Если требования противоречивы, объясни препятствие.',
   'Проект: '+job.repository+' (целевая ветка: '+job.baseBranch+').',
   'Название задачи: '+job.title,
   'Утверждённые правила проекта:\n'+String(job.projectRules||'').slice(0,12000),
   'Описание задачи:\n'+job.description.slice(0,18000),
   'Связанные задачи: '+JSON.stringify(job.relatedTasks||[]).slice(0,6000)
  ].join('\n\n');
  const runCodex=async(instruction)=>{
   const remaining=timeLeft();
   if(remaining<15000)throw new Error('Исчерпано общее время разработки. Последняя попытка не запускается.');
   const result=await command('codex',[
    'exec','-m',job.model,'-c','model_reasoning_effort="'+job.reasoning+'"',
    '--json','--ephemeral','--skip-git-repo-check',
    // Docker is the isolation boundary. Nested Linux sandbox needs namespaces
    // forbidden by Docker defaults; never expose GitHub token to Codex.
    '--sandbox','danger-full-access',instruction
   ],{cwd:dir,env:{...cliEnv,RUNNER_SHARED_SECRET:undefined},timeout:remaining});
   // Codex emits tool-use and sandbox diagnostics on stderr.
   const parsed=codexJsonResult(result.stdout);
   cumulativeUsage=addUsage(cumulativeUsage,parsed.usage);
   state.usage=cumulativeUsage;
   return {result,answer:parsed.message,files:await git('status','--porcelain')};
  };
  let attempt=await runCodex(prompt);
  if(!attempt.files.stdout.trim()){
   if(timeLeft()<45000)throw new Error('Codex завершил первую попытку без изменений. Недостаточно времени для повторного запуска.');
   const assistantText=(attempt.answer||'').slice(-1500);
   const diagnostics=(attempt.result.stderr||'').slice(-1200);
   state.message='Codex не создал файлы. Повторная попытка с явным требованием изменить репозиторий.';
   // One focused retry handles cases where Codex interpreted the task as a request
   // for advice rather than a request to create real source files.
   attempt=await runCodex(prompt+'\n\nПОВТОРНЫЙ ЗАПУСК: предыдущий ответ не изменил ни одного файла. '+ 
    'Создай или отредактируй исходные файлы прямо сейчас. Не отвечай без фактических изменений. '+ 
    'Предыдущий ответ: '+assistantText.slice(-800));
   if(!attempt.files.stdout.trim()){
    const finalText=(attempt.answer||'').slice(-1600).replaceAll(job.token,'[REDACTED]');
    const finalErrors=(attempt.result.stderr||diagnostics).slice(-900).replaceAll(job.token,'[REDACTED]');
    throw new Error('Codex не изменил файлы после двух попыток. '+
     'Ответ модели: '+(finalText||assistantText||'нет текста')+
     (finalErrors?' | Диагностика: '+finalErrors:''));
   }
  }
  const result=attempt.result;
  state.message='Создание коммита';
  await git('add','--all');
  const staged=await git('diff','--cached','--name-only');
  if(staged.stdout.split('\n').some(x=>/(^|\/)(\.env(\.|$)|auth\.json$|\.git\/|credentials(\.|\/|$))/.test(x)))
   throw new Error('Обнаружены потенциально секретные файлы. Коммит отменён');
  await command('git',['-c','user.name=AI Development Orchestrator','-c','user.email=ai-orchestrator@users.noreply.github.com',
   'commit','-m','AI: '+job.title.slice(0,120)],{cwd:dir,env:gitEnv,timeout:30000});
  state.message='Отправка ветки GitHub';
  await git('push','-u','origin','HEAD:refs/heads/'+branch);
  state.message='Создание черновика Pull Request';
  const existingPr=await fetch('https://api.github.com/repos/'+job.repository+'/pulls?state=open&head='+
   encodeURIComponent(job.repository.split('/')[0]+':'+branch),{
   headers:{Authorization:'Bearer '+job.token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(20000)
  });
  if(!existingPr.ok)throw new Error('Не удалось проверить существующий PR: GitHub HTTP '+existingPr.status);
  const openPrs=await existingPr.json();
  const samePr=openPrs.find(pr=>pr.base?.ref===job.baseBranch);
  const prUrl=samePr?.html_url||await createPullRequest(job,branch,attempt.answer||'Изменения подготовлены.');
  state.prUrl=prUrl;state.status='completed';state.message='Pull Request создан. Проверь изменения перед слиянием.';
 }catch(e){
  state.status='failed';
  state.message=String(e?.message||e).replaceAll(job.token,'[REDACTED]').slice(0,3500);
 }finally{
  await rm(workdir,{recursive:true,force:true}).catch(()=>{});
 }
}
async function readJson(req){
 let text='';
 for await(const chunk of req){
  text+=chunk.toString();
  if(text.length>50000)throw Error('Слишком большой запрос');
 }
 return JSON.parse(text);
}

// Codex app-server exposes the same account rate windows as the Codex clients.
// A short-lived stdio process does not consume model tokens or reveal OAuth data.
async function readCodexRateLimits(){
 return new Promise((resolve,reject)=>{
  const child=spawn('codex',['app-server'],{cwd:'/opt/codex-runner',env:cliEnv,stdio:['pipe','pipe','pipe']});
  let output='',stderr='',settled=false;
  const finish=(error,data)=>{
   if(settled)return;settled=true;clearTimeout(timer);
   child.kill('SIGTERM');
   if(error)reject(error);else resolve(data);
  };
  const timer=setTimeout(()=>finish(new Error('Истекло время ожидания ответа Codex app-server')),20000);
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  child.on('error',e=>finish(new Error('Не удалось запустить Codex app-server: '+e.message)));
  child.on('exit',code=>{if(!settled)finish(new Error('Codex app-server завершился (код '+code+')'));});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-800);});
  child.stdout.on('data',chunk=>{
   output+=chunk.toString();
   if(output.length>1000000)return finish(new Error('Слишком большой ответ Codex app-server'));
   let end;
   while((end=output.indexOf('\n'))>=0){
    const line=output.slice(0,end).trim();output=output.slice(end+1);
    if(!line)continue;
    let msg;try{msg=JSON.parse(line);}catch{continue;}
    if(msg.id===1){
     if(msg.error)return finish(new Error('Ошибка инициализации Codex app-server'));
     send({method:'initialized',params:{}});
     send({id:2,method:'account/rateLimits/read',params:{}});
    }else if(msg.id===2){
     if(msg.error)return finish(new Error(String(msg.error.message||'Codex не предоставил лимиты').slice(0,250)));
     const response=msg.result||{};
     const raw=response.rateLimitsByLimitId||{};
     if(!Object.keys(raw).length && response.rateLimits)raw[response.rateLimits.limitId||'codex']=response.rateLimits;
     const windows=Object.entries(raw).map(([id,bucket])=>({
      id:String(id),name:typeof bucket.limitName==='string'?bucket.limitName:null,
      primary:safeRateWindow(bucket.primary),secondary:safeRateWindow(bucket.secondary),
      planType:typeof bucket.planType==='string'?bucket.planType:null,
      reachedType:typeof bucket.rateLimitReachedType==='string'?bucket.rateLimitReachedType:null
     }));
     finish(null,{windows,resetCredits:typeof response.rateLimitResetCredits?.availableCount==='number'?response.rateLimitResetCredits.availableCount:null,checkedAt:new Date().toISOString()});
    }
   }
  });
  send({id:1,method:'initialize',params:{clientInfo:{name:'ai_development_orchestrator',title:'AI Development Orchestrator',version:'0.1.0'}}});
 });
}
function safeRateWindow(w){
 if(!w||typeof w!=='object'||typeof w.usedPercent!=='number')return null;
 return {usedPercent:Math.min(100,Math.max(0,w.usedPercent)),
  windowDurationMins:typeof w.windowDurationMins==='number'?w.windowDurationMins:null,
  resetsAt:typeof w.resetsAt==='number'?w.resetsAt:null};
}

http.createServer(async(req,res)=>{
 try {
  if(req.method==='GET'&&req.url==='/usage-limits'){
   if(!authorized(req))return reply(res,403,{error:'Forbidden'});
   if(!(await connected()).connected)return reply(res,409,{error:'Сначала подключи ChatGPT в Codex CLI'});
   try{return reply(res,200,await readCodexRateLimits());}
   catch(error){return reply(res,503,{error:String(error?.message||error).slice(0,250)});}
  }
  if(req.method==='GET'&&req.url==='/status'){
   const state=await connected();return reply(res,200,{...state,login:loginState!=='idle'?deviceInfo():null});
  }
  if(req.method==='POST'&&req.url==='/login'){
   if((await connected()).connected)return reply(res,200,{connected:true});
   runLogin();return reply(res,202,{connected:false,login:deviceInfo()});
  }
  if(req.method==='GET'&&req.url==='/device')return reply(res,200,{login:deviceInfo()});
  if(req.method==='POST'&&req.url==='/logout'){
   if(login){login.kill('SIGTERM');login=null;}loginState='idle';log='';
   try{await execFileAsync('codex',['logout'],{timeout:10000,env:cliEnv});}catch{}
   return reply(res,200,{connected:false});
  }
  if(req.url==='/assistant'&&req.method==='POST'){
   if(!authorized(req))return reply(res,403,{error:'Forbidden'});
   if(activeChatRequests>=MAX_PARALLEL_CHAT)return reply(res,429,{error:'Сейчас выполняется несколько AI-диалогов. Повтори запрос немного позже.'});
   const data=await readJson(req);
   if(typeof data.prompt!=='string'||data.prompt.length<1||data.prompt.length>24000||
      !['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'].includes(data.model)||
      !['low','medium'].includes(data.reasoning))
     return reply(res,400,{error:'Некорректные параметры AI-запроса'});
   activeChatRequests++;
   try{
    if(!(await connected()).connected)return reply(res,409,{error:'Сначала подключи Codex CLI в настройках аккаунта'});
    const result=await command('codex',[
      'exec','-m',data.model,'-c','model_reasoning_effort="'+data.reasoning+'"',
      '--json','--ephemeral','--skip-git-repo-check','--sandbox','read-only',data.prompt
    ],{cwd:'/opt/codex-runner',env:cliEnv,timeout:105000});
    const parsed=codexJsonResult(result.stdout);
    const message=parsed.message.trim();
    if(!message)return reply(res,502,{error:'Codex вернул пустой ответ'});
    return reply(res,200,{message:message.slice(0,16000),usage:parsed.usage});
   }catch(error){
    return reply(res,503,{error:'Codex: '+String(error?.message||error).slice(0,900)});
   }finally{activeChatRequests--;}
  }
  if(req.url==='/jobs'&&req.method==='POST'){
   if(!authorized(req))return reply(res,403,{error:'Forbidden'});
   const job=await readJson(req);
   if(typeof job.id!=='string'||! /^[a-f0-9-]{36}$/.test(job.id) ||
    typeof job.taskId!=='string'|| !/^[a-f0-9-]{36}$/.test(job.taskId) ||
    typeof job.repository!=='string'|| !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(job.repository) ||
    typeof job.baseBranch!=='string'|| !/^[a-zA-Z0-9_.\/-]+$/.test(job.baseBranch) ||
    !['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'].includes(job.model)||
    !['low','medium'].includes(job.reasoning)||
    !Number.isInteger(job.maxRuntimeSeconds)||job.maxRuntimeSeconds<90||job.maxRuntimeSeconds>7200||
    typeof job.token!=='string'||job.token.length<20||
    typeof job.title!=='string'||job.title.length>300||typeof job.description!=='string')
    return reply(res,400,{error:'Некорректные параметры задачи'});
   if(activeJobs.has(job.id))return reply(res,409,{error:'Запуск с таким ID уже существует'});
   const state={id:job.id,status:'queued',message:'Задача принята в очередь',branch:null,baseBranch:job.baseBranch,prUrl:null,createdAt:new Date().toISOString(),startedAt:null};
   activeJobs.set(job.id,state);
   if(activeJobs.size>200){for(const [key,v] of activeJobs){if(v.status==='completed'||v.status==='failed'){activeJobs.delete(key);break;}}}
   jobQueue.push({job,state});
   startNextJobs();
   return reply(res,202,state);
  }
  if(req.method==='GET'&& /^\/jobs\/[a-f0-9-]{36}$/.test(req.url||'')){
   if(!authorized(req))return reply(res,403,{error:'Forbidden'});
   const job=activeJobs.get(req.url.slice(6));
   return job?reply(res,200,job):reply(res,404,{error:'Задача не найдена (возможно, исполнитель перезапущен)'});
  }
  if(req.method==='POST'&&req.url==='/test'){
   if(!(await connected()).connected)return reply(res,409,{error:'Codex ещё не подключён'});
   // execFile leaves stdin open as a pipe. Codex then waits for EOF and
   // prints "Reading additional input from stdin..." instead of starting.
   // Explicitly disable stdin for unattended execution.
   const result=await new Promise((resolve,reject)=>{
    const child=spawn('codex',['exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','Ответь ровно: подключение работает'],{
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

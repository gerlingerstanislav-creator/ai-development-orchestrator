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
let runningJob=null;
let chatBusy=false;
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
async function runJob(job,state){
 const workdir=await mkdtemp(join(tmpdir(),'ado-run-'));
 const dir=join(workdir,'repo');
 const auth=Buffer.from('x-access-token:'+job.token).toString('base64');
 const gitEnv={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',
  GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+auth};
 const git=(...args)=>command('git',args,{cwd:dir,env:gitEnv,timeout:45000});
 const branch='ai/task-'+job.taskId.slice(0,8)+'-'+job.id.slice(0,8);
 state.branch=branch;
 try{
  state.message='Клонирование репозитория';
  await command('git',['clone','--depth','1','--branch',job.baseBranch,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workdir,env:gitEnv,timeout:75000});
  await git('checkout','-b',branch);
  state.message='Codex изменяет код';
  const prompt=[
   'Ты работаешь в изолированной копии проекта. Выполни ровно одну задачу по существующему коду.',
   'Не трогай секреты, .env, credentials или настройки доступа. Не запускай git push, git commit, git checkout.',
   'Не изменяй файлы вне рабочей директории. Не устанавливай пакеты из сети.',
   'Если задача непонятна, не вноси случайных изменений.',
   'Название задачи: '+job.title,
   'Описание задачи:\n'+job.description.slice(0,18000)
  ].join('\n\n');
  const result=await command('codex',[
   'exec','-m',job.model,'-c','model_reasoning_effort="'+job.reasoning+'"',
   '--ephemeral','--skip-git-repo-check','--sandbox','workspace-write',prompt
  ],{cwd:dir,env:cliEnv,timeout:job.maxRuntimeSeconds*1000});
  const changed=await git('status','--porcelain');
  if(!changed.stdout.trim())throw new Error('Codex завершил работу без изменений файлов');
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
  const prUrl=await createPullRequest(job,branch,result.stdout||'Изменения подготовлены.');
  state.prUrl=prUrl;state.status='completed';state.message='Pull Request создан. Проверь изменения перед слиянием.';
 }catch(e){
  state.status='failed';
  state.message=String(e?.message||e).slice(0,1300).replaceAll(job.token,'[REDACTED]');
 }finally{
  runningJob=null;
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

http.createServer(async(req,res)=>{
 try {
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
   if(chatBusy||runningJob)return reply(res,409,{error:'Codex занят. Дождись завершения текущего запроса.'});
   const data=await readJson(req);
   if(typeof data.prompt!=='string'||data.prompt.length<1||data.prompt.length>24000||
      !['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'].includes(data.model)||
      !['low','medium'].includes(data.reasoning))
     return reply(res,400,{error:'Некорректные параметры AI-запроса'});
   chatBusy=true;
   try{
    if(!(await connected()).connected)return reply(res,409,{error:'Сначала подключи Codex CLI в настройках аккаунта'});
    const result=await command('codex',[
      'exec','-m',data.model,'-c','model_reasoning_effort="'+data.reasoning+'"',
      '--ephemeral','--skip-git-repo-check','--sandbox','read-only',data.prompt
    ],{cwd:'/opt/codex-runner',env:cliEnv,timeout:105000});
    const message=result.stdout.trim();
    if(!message)return reply(res,502,{error:'Codex вернул пустой ответ'});
    return reply(res,200,{message:message.slice(0,16000)});
   }catch(error){
    return reply(res,503,{error:'Codex: '+String(error?.message||error).slice(0,900)});
   }finally{chatBusy=false;}
  }
  if(req.url==='/jobs'&&req.method==='POST'){
   if(!authorized(req))return reply(res,403,{error:'Forbidden'});
   if(runningJob||chatBusy)return reply(res,409,{error:'Исполнитель занят другим AI-запросом'});
   const job=await readJson(req);
   if(typeof job.id!=='string'||! /^[a-f0-9-]{36}$/.test(job.id) ||
    typeof job.taskId!=='string'|| !/^[a-f0-9-]{36}$/.test(job.taskId) ||
    typeof job.repository!=='string'|| !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(job.repository) ||
    typeof job.baseBranch!=='string'|| !/^[a-zA-Z0-9_.\/-]+$/.test(job.baseBranch) ||
    !['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'].includes(job.model)||
    !['low','medium'].includes(job.reasoning)||
    !Number.isInteger(job.maxRuntimeSeconds)||job.maxRuntimeSeconds<90||job.maxRuntimeSeconds>900||
    typeof job.token!=='string'||job.token.length<20||
    typeof job.title!=='string'||job.title.length>300||typeof job.description!=='string')
    return reply(res,400,{error:'Некорректные параметры задачи'});
   const state={id:job.id,status:'running',message:'Задача принята',branch:null,prUrl:null};
   activeJobs.set(job.id,state);
   if(activeJobs.size>40){for(const [key,v] of activeJobs){if(v.status!=='running'){activeJobs.delete(key);break;}}}
   runningJob=job.id;
   void runJob(job,state);
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

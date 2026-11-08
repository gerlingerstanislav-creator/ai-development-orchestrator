import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

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

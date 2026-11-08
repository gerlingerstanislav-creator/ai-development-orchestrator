import http from 'node:http';
import net from 'node:net';
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
const proxyServer=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
proxyServer.on('connect',(req,client,head)=>{
 const target=req.url||'';
 const match=/^([a-z0-9.-]+):(443)$/.exec(target);
 const host=match?.[1]||'';
 const allowed=host==='auth.openai.com'||host==='api.openai.com'||host==='chatgpt.com'||host.endsWith('.openai.com')||host.endsWith('.chatgpt.com');
 if(!allowed){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
 const remote=net.connect({host,port:443,family:4,timeout:12000});
 let established=false;
 remote.once('connect',()=>{established=true;client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head?.length)remote.write(head);remote.pipe(client);client.pipe(remote);});
 remote.on('error',()=>{if(!established)client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');else client.destroy();});
 remote.on('timeout',()=>remote.destroy());
 client.on('error',()=>remote.destroy());
 client.on('close',()=>remote.destroy());
});
proxyServer.listen(4399,'127.0.0.1');
const proxyUrl='http://127.0.0.1:4399';
const cliEnv={...process.env,CODEX_HOME:home,HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1'};

let login=null, log='',loginState='idle',started=0;
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
 log='';loginState='waiting';started=Date.now();
 login=spawn('codex',['login','--device-auth'],{env:cliEnv,stdio:['ignore','pipe','pipe']});
 const child=login;
 const collect=(chunk)=>{log=(log+chunk.toString('utf8')).slice(-10000)};
 child.stdout.on('data',collect);child.stderr.on('data',collect);
 child.on('error',e=>{loginState='error';log+='\n'+e.message;});
 child.on('exit',(code,signal)=>{if(login===child){loginState=code===0?'completed':loginState==='expired'?'expired':'error';if(code!==0)log+='\nCodex login завершился: '+(signal||code);login=null;}});
 const deadline=setTimeout(()=>{if(login===child){child.kill('SIGTERM');loginState='expired';}},10*60*1000);
 deadline.unref();
}
function deviceInfo(){
 const output=safeText();
 // Only show the actual device-sign-in URL and code after the CLI provides one.
 // Do not mistake the /api/accounts/deviceauth/usercode error endpoint for a login link.
 const url=output.match(/https:\/\/auth\.openai\.com\/codex\/device\b/i)?.[0]||null;
 const code=url?output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/)?.[0]||null:null;
 return {state:loginState,url,code,instructions:output,startedAt:started||null};
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
   const {stdout,stderr}=await execFileAsync('codex',['exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','Ответь ровно: подключение работает'],{timeout:120000,maxBuffer:30000,cwd:'/opt/codex-runner',env:cliEnv});
   return reply(res,200,{ok:true,message:stdout.trim().slice(0,1000)});
  }
  return reply(res,404,{error:'Not found'});
 }catch(e){return reply(res,503,{error:'Codex: '+String(e.message||e).slice(0,300)});}
}).listen(4300,'0.0.0.0');

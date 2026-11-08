import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync=promisify(execFile);
const home=process.env.CODEX_HOME||'/home/node/.codex';
await mkdir(home,{recursive:true,mode:0o700});
const config=join(home,'config.toml');
try { await access(config); } catch { await writeFile(config,'cli_auth_credentials_store = "file"\n',{mode:0o600}); }
let login=null, log='',loginState='idle',started=0;
const safeText=()=>log.replace(/\x1b\[[0-9;]*m/g,'').slice(-3000);
const reply=(res,status,payload)=>{
 const data=JSON.stringify(payload);
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(data)});
 res.end(data);
};
async function connected() {
 try { const {stdout,stderr}=await execFileAsync('codex',['login','status'],{timeout:10000,maxBuffer:20000});
  return {connected:true,detail:(stdout||stderr).trim().slice(0,500)};
 } catch(e) {return {connected:false,detail:'Не авторизован'};}
}
function runLogin(){
 if(login && !login.killed && login.exitCode===null)return;
 log='';loginState='waiting';started=Date.now();
 login=spawn('codex',['login','--device-auth'],{env:{...process.env,CODEX_HOME:home},stdio:['ignore','pipe','pipe']});
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
 const url=output.match(/https:\/\/[^\s"'<>]+/i)?.[0]||null;
 // Device code is displayed only to the authenticated administrator.
 const code=output.match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}\b/i)?.[0]||null;
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
   try{await execFileAsync('codex',['logout'],{timeout:10000});}catch{}
   return reply(res,200,{connected:false});
  }
  if(req.method==='POST'&&req.url==='/test'){
   if(!(await connected()).connected)return reply(res,409,{error:'Codex ещё не подключён'});
   const {stdout,stderr}=await execFileAsync('codex',['exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','Ответь ровно: подключение работает'],{timeout:120000,maxBuffer:30000,cwd:'/opt/codex-runner'});
   return reply(res,200,{ok:true,message:stdout.trim().slice(0,1000)});
  }
  return reply(res,404,{error:'Not found'});
 }catch(e){return reply(res,503,{error:'Codex: '+String(e.message||e).slice(0,300)});}
}).listen(4300,'0.0.0.0');

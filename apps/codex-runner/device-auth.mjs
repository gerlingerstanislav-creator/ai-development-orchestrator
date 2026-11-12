import {spawn} from 'node:child_process';

/**
 * Device-code login lifecycle owned separately from Runner HTTP/jobs.
 * Uses the existing ChatGPT subscription via local Codex CLI; no API keys.
 */
export function createCodexDeviceAuth({
 cliEnv,codexProxy,probeAuthEndpoint,execFileAsync,spawnImpl=spawn
}){
let login=null, log='',loginState='idle',started=0,diagnosis='';
const safeText=()=>log.replace(/\x1b\[[0-9;]*m/g,'').slice(-3000);

async function connected() {
 try { const {stdout,stderr}=await execFileAsync('codex',['login','status'],{timeout:10000,maxBuffer:20000,env:cliEnv});
  return {connected:true,detail:(stdout||stderr).trim().slice(0,500)};
 } catch(e) {return {connected:false,detail:'Не авторизован'};}
}
function runLogin(){
 if(login && !login.killed && login.exitCode===null)return;
 log='';diagnosis='';codexProxy.reset();loginState='waiting';started=Date.now();
 login=spawnImpl('codex',['login','--device-auth'],{env:{...cliEnv,RUST_LOG:'warn,reqwest=debug,hyper_util=debug'},stdio:['ignore','pipe','pipe']});
 const child=login;
 const collect=(chunk)=>{log=(log+chunk.toString('utf8')).slice(-10000)};
 child.stdout.on('data',collect);child.stderr.on('data',collect);
 child.on('error',e=>{loginState='error';log+='\n'+e.message;});
 let deadline;
 child.on('exit',(code,signal)=>{clearTimeout(deadline);if(login===child){loginState=code===0?'completed':loginState==='expired'?'expired':'error';if(code!==0){log+='\nCodex login завершился: '+(signal||code);const {attempts:connections,successes,lastError:proxyError}=codexProxy.stats();void Promise.all([probeAuthEndpoint(),codexProxy.probe()]).then(([probe,tunnel])=>{diagnosis=probe+'; '+tunnel+'; Codex через прокси: '+connections+' попыток, '+successes+' соединений'+(proxyError?'; ошибка прокси: '+proxyError:'')+(connections===0?'. Codex не использовал настроенный прокси.':'');});}login=null;}});
 deadline=setTimeout(()=>{if(login===child){child.kill('SIGTERM');loginState='expired';}},10*60*1000);
 deadline.unref();
}
function deviceInfo(){
 const output=safeText();
 // Only show the actual device-sign-in URL and code after the CLI provides one.
 // Do not mistake the /api/accounts/deviceauth/usercode error endpoint for a login link.
 const url=output.match(/https:\/\/auth\.openai\.com\/codex\/device\b/i)?.[0]||null;
 // Codex can emit diagnostics containing unrelated code-shaped strings before
 // the real device URL. Prefer the most recent code from the CLI output.
 const codes=url?[...output.matchAll(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/g)]:[];
 const code=codes.at(-1)?.[0]||null;
 return {state:loginState,url,code,instructions:output,diagnosis,startedAt:started||null};
}


 function activeLogin(){return loginState!=='idle'?deviceInfo():null;}
 async function logout(){
  if(login){login.kill('SIGTERM');login=null;}
  loginState='idle';log='';diagnosis='';started=0;
  try{await execFileAsync('codex',['logout'],{timeout:10000,env:cliEnv});}catch{}
 }
 return {connected,runLogin,deviceInfo,activeLogin,logout};
}

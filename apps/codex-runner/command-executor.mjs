import {spawn} from 'node:child_process';

/**
 * Single process execution boundary for Git and Codex commands.
 * The runner still owns cancellation and job lifecycle; dependencies are
 * injected so commands can be exercised without a running HTTP server.
 */
export function createCommandExecutor({baseEnv,assertJobActive,jobChildren,stopCommand,codexFailureDetail,spawnImpl=spawn}){
 return function command(binary,args,{cwd,env,timeout=30000,maxOutputChars=16000,jobId,allowNonzero=false,onStdout}={}){
 return new Promise((resolve,reject)=>{
  if(jobId)assertJobActive(jobId);
  const child=spawnImpl(binary,args,{cwd,env:{...baseEnv,...env},stdio:['ignore','pipe','pipe'],detached:true});
  if(jobId)jobChildren.set(jobId,child);
  let output='',errors='',done=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;stopCommand(child);},timeout);
  child.stdout.on('data',x=>{const chunk=x.toString();output=(output+chunk).slice(-maxOutputChars);onStdout?.(chunk);});
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
}

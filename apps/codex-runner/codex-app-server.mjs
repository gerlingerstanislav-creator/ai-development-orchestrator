import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const validId=/^[a-zA-Z0-9_-]{8,128}$/;
const usageValue=value=>Number.isFinite(Number(value))?Math.max(0,Number(value)):0;
export const threadStorageKey=scope=>createHash('sha256').update(JSON.stringify([
 String(scope.projectId||''),String(scope.role||''),String(scope.taskId||scope.processId||'')
])).digest('hex');
export function codexUsage(event){
 const u=event?.params?.tokenUsage?.last||event?.params?.tokenUsage?.total||event?.params?.last||event?.params?.total||{};
 return {input_tokens:usageValue(u.inputTokens??u.input_tokens),
  cached_input_tokens:usageValue(u.cachedInputTokens??u.cached_input_tokens),
  output_tokens:usageValue(u.outputTokens??u.output_tokens)};
}

/** Never persist secrets, prompts, GitHub tokens, MCP credentials or arbitrary paths.
 * CODEX_HOME owns the rollout data; this journal stores only session identity.
 */
export function createCodexThreadStore(directory){
 const inFlight=new Map();
 const path=key=>join(directory,key+'.json');
 return {
  async read(scope){
   try{
    const record=JSON.parse(await readFile(path(threadStorageKey(scope)),'utf8'));
    return validId.test(record.threadId||'')&&record.key===threadStorageKey(scope)?record:null;
   }catch(error){if(error.code==='ENOENT')return null;throw error;}
  },
  async save(scope,threadId,turnId=null){
   if(!validId.test(threadId))throw Error('Codex вернул некорректный thread_id');
   if(turnId!==null&&!validId.test(turnId))throw Error('Codex вернул некорректный turn_id');
   await mkdir(directory,{recursive:true,mode:0o700});
   const key=threadStorageKey(scope);
   const target=path(key),temp=target+'.'+process.pid+'.tmp';
   const file=await open(temp,'w',0o600);
   try{await file.writeFile(JSON.stringify({key,threadId,turnId,updatedAt:new Date().toISOString()}));await file.sync();}
   finally{await file.close();}
   await rename(temp,target);
  },
  /** Same task/role is serialized; a repeated HTTP request joins the active
   * turn rather than charging tokens for a duplicate. Different requests queue.
   */
  async run(scope,requestId,run){
   const key=threadStorageKey(scope);
   const existing=inFlight.get(key);
   if(existing?.requestId===requestId)return existing.promise;
   const before=existing?.promise.catch(()=>{});
   const current=(async()=>{if(before)await before;return run();})();
   const entry={requestId,promise:current};
   inFlight.set(key,entry);
   try{return await current;}
   finally{if(inFlight.get(key)===entry)inFlight.delete(key);}
  }
 };
}

/** A fresh stdio connection per turn is intentional: threads persist in
 * CODEX_HOME across worker crashes; no App Server process holds the state hostage.
 */
export function createCodexAppExecutor({store,spawnImpl=spawn,env={},command='codex'}){
 return async function execute({scope,requestId,prompt,model,effort,cwd,timeout=240000,
  configArgs=[],sandboxPolicy,images=[],envOverrides={},onStarted,onProgress,onChild,signal}){
  return store.run(scope,requestId,async()=>{
   const child=spawnImpl(command,['app-server','--listen','stdio://',...configArgs],{
    cwd,env:{...env,...envOverrides},stdio:['pipe','pipe','pipe'],detached:true
   });
   onChild?.(child);
   const rl=createInterface({input:child.stdout,crlfDelay:Infinity});
   const pending=new Map();
   let seq=0,turnId=null,threadId=null,answer='',lastUsage=null,closed=false,completed=false;
   let completionResolve,completionReject;
   const completedTurn=new Promise((resolve,reject)=>{completionResolve=resolve;completionReject=reject;});
   // A failed handshake can occur before we start awaiting turn completion.
   completedTurn.catch(()=>{});
   let errorLog='';
   child.stderr.on('data',data=>{errorLog=(errorLog+data.toString()).slice(-2000);});
   function send(method,params,id=null){
    if(child.stdin.destroyed)throw Error('Codex App Server завершил соединение');
    child.stdin.write(JSON.stringify(id===null?{method,params}:{id,method,params})+'\n');
   }
   function call(method,params){
    const id=++seq;
    return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send(method,params,id);});
   }
   function fail(error){
    if(completed)return;
    completed=true;
    const err=error instanceof Error?error:Error(String(error));
    for(const wait of pending.values())wait.reject(err);
    pending.clear();
    completionReject(err);
   }
   rl.on('line',line=>{
    if(line.length>2000000){fail(Error('Codex App Server вернул слишком большой ответ'));return;}
    let msg;
    try{msg=JSON.parse(line);}catch{return;}
    if(msg.id!==undefined&&msg.id!==null&&pending.has(msg.id)){
     const task=pending.get(msg.id);pending.delete(msg.id);
     if(msg.error)task.reject(Error(String(msg.error.message||'Codex RPC error').slice(0,900)));
     else task.resolve(msg.result);
     return;
    }
    if(msg.id!==undefined&&msg.id!==null){
     // Never grant unsolicited tool/shell/escalation requests.
     try{child.stdin.write(JSON.stringify({id:msg.id,result:{decision:'decline'}})+'\n');}catch{}
     return;
    }
    if(msg.method==='item/completed'&&msg.params?.item?.type==='agentMessage'){
     if(typeof msg.params.item.text==='string')answer=msg.params.item.text;
    }
    if(msg.method==='thread/tokenUsage/updated')lastUsage=codexUsage(msg);
    if(msg.method==='turn/completed'&&(!turnId||msg.params?.turn?.id===turnId)){
     const state=msg.params?.turn?.status;
     if(state==='completed'){completed=true;completionResolve();}
     else fail(Error(String(msg.params?.turn?.error?.message||'Codex turn '+state).slice(0,900)));
    }
    if(msg.method==='item/started'||msg.method==='item/completed'){
     onProgress?.({method:msg.method,type:msg.params?.item?.type,threadId,turnId});
    }
   });
   child.on('error',fail);
   child.on('close',code=>{
    closed=true;
    if(!completed)fail(Error('Codex App Server завершился до окончания turn (код '+code+'): '+errorLog));
   });
   const kill=()=>{
    try{process.kill(-child.pid,'SIGKILL');}
    catch{child.kill('SIGKILL');}
   };
   const timer=setTimeout(()=>{fail(Error('Codex turn превысил ограничение времени'));kill();},timeout);
   const abort=()=>{fail(Error('Выполнение остановлено'));kill();};
   if(signal?.aborted)abort();
   else signal?.addEventListener('abort',abort,{once:true});
   try{
    await call('initialize',{clientInfo:{name:'ai-development-orchestrator',title:'AI Development Orchestrator',version:'1.0.0'}});
    send('initialized',{});
    const saved=await store.read(scope);
    const thread=saved
     ?await call('thread/resume',{threadId:saved.threadId,excludeTurns:true})
     :await call('thread/start',{model,cwd,approvalPolicy:'never',
       sandbox:sandboxPolicy?.type==='readOnly'?'readOnly':'workspaceWrite',ephemeral:false,serviceName:'ai-development-orchestrator'});
    threadId=thread?.thread?.id;
    if(!validId.test(threadId||''))throw Error('Codex App Server не вернул thread_id');
    // Persist the ID before issuing a model turn: even a crash during work
    // leaves a resumable thread.
    await store.save(scope,threadId);
    const input=[{type:'text',text:prompt},...images.map(path=>({type:'localImage',path}))];
    const response=await call('turn/start',{threadId,input,cwd,model,effort,
     approvalPolicy:'never',...(sandboxPolicy?{sandboxPolicy}:{})});
    turnId=response?.turn?.id;
    if(!validId.test(turnId||''))throw Error('Codex App Server не вернул turn_id');
    await store.save(scope,threadId,turnId);
    await onStarted?.({threadId,turnId});
    await completedTurn;
    return {threadId,turnId,message:answer.trim(),usage:lastUsage||
      {input_tokens:0,cached_input_tokens:0,output_tokens:0}};
   }catch(error){fail(error);throw error;}
   finally{
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    // The turn is finished/failed, so the child has no work to preserve.
    if(!closed)kill();
    rl.close();onChild?.(null);
   }
  });
 };
}

/** The existing Runner JSON parser remains compatible while migration is
 * gradual: no synthetic success is created for incomplete turn notifications.
 */
export function asCodexExecResult(response){
 return {stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:response.message}})+'\n'+
  JSON.stringify({type:'turn.completed',usage:response.usage})+'\n',stderr:'',exitCode:0,
  threadId:response.threadId,turnId:response.turnId};
}

// Account rate limits are a cheap read but starting a Codex app-server is not.
// Share one short-lived read among callers, keep fresh data briefly and avoid
// repeated process launches while the upstream service is unavailable.

export function normalizeCodexRateLimits(response,checkedAt=new Date().toISOString()){
 const raw=response?.rateLimitsByLimitId&&typeof response.rateLimitsByLimitId==='object'
  ?{...response.rateLimitsByLimitId}:{};
 if(!Object.keys(raw).length&&response?.rateLimits){
  raw[response.rateLimits.limitId||'codex']=response.rateLimits;
 }
 const windows=Object.entries(raw)
  .filter(([,value])=>value&&typeof value==='object')
  .map(([id,bucket])=>({
   id:String(id),name:typeof bucket.limitName==='string'?bucket.limitName:null,
   primary:rateWindow(bucket.primary),secondary:rateWindow(bucket.secondary),
   planType:typeof bucket.planType==='string'?bucket.planType:null,
   reachedType:typeof bucket.rateLimitReachedType==='string'?bucket.rateLimitReachedType:null
  }));
 return {windows,resetCredits:typeof response?.rateLimitResetCredits?.availableCount==='number'
  ?response.rateLimitResetCredits.availableCount:null,checkedAt};
}
function rateWindow(value){
 if(!value||typeof value!=='object'||typeof value.usedPercent!=='number')return null;
 return {usedPercent:Math.max(0,Math.min(100,value.usedPercent)),
  windowDurationMins:typeof value.windowDurationMins==='number'?value.windowDurationMins:null,
  resetsAt:typeof value.resetsAt==='number'?value.resetsAt:null};
}

export function readCodexRateLimits(spawnProcess,{env,cwd='/opt/codex-runner',timeoutMs=16000}={}){
 return new Promise((resolve,reject)=>{
  let child,timer,finished=false,buffer='';
  const done=(error,result)=>{
   if(finished)return;
   finished=true;clearTimeout(timer);
   if(child&&!child.killed)child.kill('SIGTERM');
   if(error)reject(error);else resolve(result);
  };
  try{child=spawnProcess('codex',['app-server'],{cwd,env,stdio:['pipe','pipe','pipe']});}
  catch(error){reject(error);return;}
  const send=(msg)=>{
   try{
    child.stdin.write(JSON.stringify(msg)+'\n',error=>{
     if(error)done(new Error('Codex app-server: не удалось передать запрос ('+(error.code||'stdin')+')'));
    });
   }catch(error){done(new Error('Codex app-server: ошибка записи в stdin'));}
  };
  timer=setTimeout(()=>done(new Error('Codex app-server не ответил за '+Math.round(timeoutMs/1000)+' секунд')),timeoutMs);
  child.on('error',error=>done(new Error('Не удалось запустить Codex app-server: '+error.message)));
  child.stdin.on('error',error=>done(new Error('Codex app-server: stdin '+(error.code||error.message))));
  child.on('exit',(code,signal)=>done(new Error('Codex app-server завершился до ответа ('+(signal||code)+')')));
  child.stdout.on('data',chunk=>{
   buffer+=chunk.toString('utf8');
   if(buffer.length>1000000)return done(new Error('Codex app-server: слишком большой ответ'));
   let end;
   while(!finished&&(end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
    if(!line)continue;
    let message;
    try{message=JSON.parse(line);}catch{continue;}
    if(message.id===1){
     if(message.error)return done(new Error('Codex app-server: ошибка инициализации'));
     send({method:'initialized',params:{}});
     send({id:2,method:'account/rateLimits/read',params:{}});
    }else if(message.id===2){
     if(message.error)return done(new Error('Codex: '+String(message.error.message||'не удалось получить лимиты').slice(0,220)));
     done(null,normalizeCodexRateLimits(message.result||{}));
    }
   }
  });
  send({id:1,method:'initialize',params:{
   clientInfo:{name:'ai_development_orchestrator',title:'AI Development Orchestrator',version:'0.1.0'}
  }});
 });
}

export function createRateLimitCache(read,{now=()=>Date.now(),freshMs=75000,staleMs=600000,backoffMs=15000}={}){
 let snapshot=null,successTime=0,nextAttempt=0,inflight=null,lastError=null;
 const age=()=>now()-successTime;
 const stale=()=>snapshot&&age()<=staleMs
  ?{...snapshot,stale:true,warning:'Не удалось обновить лимиты: '+(lastError?.message||'временный сбой')}
  :null;
 return {
  read({force=false}={}){
   if(inflight)return inflight;
   if(!force&&snapshot&&age()<freshMs)return Promise.resolve({...snapshot,stale:false});
   if(now()<nextAttempt){
    const previous=stale();
    return previous?Promise.resolve(previous):Promise.reject(lastError||new Error('Повторная проверка лимитов временно отложена'));
   }
   inflight=Promise.resolve().then(read).then(value=>{
    if(!value||!Array.isArray(value.windows))throw new Error('Codex вернул некорректные данные лимитов');
    snapshot=value;successTime=now();nextAttempt=0;lastError=null;
    return {...snapshot,stale:false};
   }).catch(error=>{
    lastError=error instanceof Error?error:new Error(String(error));
    nextAttempt=now()+backoffMs;
    const previous=stale();
    if(previous)return previous;
    throw lastError;
   }).finally(()=>{inflight=null;});
   return inflight;
  },
  invalidate(){snapshot=null;successTime=0;nextAttempt=0;lastError=null;}
 };
}

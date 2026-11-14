/** Public-facing progress only. Never forward raw Codex reasoning, prompts,
 * command lines, tool arguments, tool responses, credentials or private logs.
 */
const safe=(value,max=320)=>String(value||'')
 .replace(/(?:Bearer\s+|gh[pousr]_|sk-)[A-Za-z0-9_.-]{8,}/gi,'[скрыто]')
 .replace(/(?:password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]{4,}/gi,'[скрыто]')
 .replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const cleanTool=value=>/^[a-zA-Z0-9_.-]{1,80}$/.test(String(value||''))?String(value):'';

export function visibleCodexProgress(msg){
 if(!msg||typeof msg!=='object'||typeof msg.method!=='string')return null;
 const method=msg.method,params=msg.params||{},item=params.item||{};
 if(method==='turn/started')return {kind:'status',text:'ПМ приступил к обработке'};
 if(method==='turn/plan/updated'){
  const plan=Array.isArray(params.plan)?params.plan:[];
  const current=plan.find(step=>step?.status==='inProgress'||step?.status==='in_progress')||plan.find(step=>step?.status==='pending');
  const label=safe(current?.step||current?.text||current?.description||'',160);
  return {kind:'plan',text:label?('План: '+label).slice(0,320):'ПМ уточняет план выполнения'};
 }
 // Codex explicitly labels this as a *summary*; raw reasoning text/deltas
 // are intentionally not exposed. Different app-server versions may omit it.
 // User-visible answer chunks, not internal reasoning, are safe to preview.
 if(method==='item/agentMessage/delta'&&typeof params.delta==='string'){
  const delta=String(params.delta).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,240);
  return delta?{kind:'message',text:delta}:null;
 }
 if(method==='item/reasoning/summaryTextDelta'&&typeof params.delta==='string'){
  // Preserve whitespace between streamed tokens; trim only after aggregation.
  const delta=String(params.delta).replace(/[\\u0000-\\u001f\\u007f]/g,' ').slice(0,240);
  return delta.trim()?{kind:'summary',text:delta}:null;
 }
 if(method==='item/started'&&item.type==='mcpToolCall'){
  const tool=cleanTool(item.tool)||cleanTool(item.name);
  return {kind:'tool',text:'Вызов инструмента'+(tool?' '+tool:'')};
 }
 if(method==='item/completed'&&item.type==='mcpToolCall'){
  const tool=cleanTool(item.tool)||cleanTool(item.name);
  return {kind:'tool',text:'Инструмент'+(tool?' '+tool:'')+' завершил работу'};
 }
 if(method==='item/started'&&item.type==='commandExecution')
  return {kind:'tool',text:'Выполняет разрешённую команду'};
 if(method==='item/completed'&&item.type==='commandExecution')
  return {kind:'tool',text:'Завершено выполнение команды'};
 if(method==='item/started'&&item.type==='agentMessage')
  return {kind:'status',text:'Подготавливает ответ'};
 if(method==='turn/completed')
  return {kind:'status',text:'Сеанс Codex завершён, результат сохраняется'};
 return null;
}

export function createPmProgressPublisher({apiUrl,secret,projectId,messageId,attempt,fetchImpl=fetch}){
 let sequence=0,chain=Promise.resolve(),summary='',timer=null,summaryLength=0;
 let messageBuffer='',messageTimer=null,messageUpdates=0,messageDirty=false;
 const endpoint=apiUrl.replace(/\/internal\/agent-tools\/?$/,'/internal/pm-turn-progress');
 const send=(entry)=>{
  if(!entry||sequence>=300)return;
  const body={projectId,messageId,attempt,sequence:++sequence,kind:entry.kind,text:entry.text};
  chain=chain.then(async()=>{
   try{
    await fetchImpl(endpoint,{method:'POST',headers:{
     'X-Runner-Secret':secret,'Content-Type':'application/json'
    },body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
   }catch{/* The model turn must outlive a lost UI progress connection. */}
  });
 };
 const flushSummary=()=>{
  if(timer!==null){clearTimeout(timer);timer=null;}
  const text=safe(summary);
  summary='';
  if(text)send({kind:'summary',text});
 };
 const flushMessage=()=>{
  if(messageTimer!==null){clearTimeout(messageTimer);messageTimer=null;}
  if(!messageBuffer||!messageDirty||messageUpdates>=160)return;
  // Store a short sanitized snapshot, not full model output or tool payloads.
  const tail=messageBuffer.slice(-310);
  const text=safe(tail,310);
  if(text){messageDirty=false;messageUpdates++;send({kind:'message',text:(messageBuffer.length>310?'…':'')+text});}
 };
 const onEvent=msg=>{
  const entry=visibleCodexProgress(msg);
  if(!entry)return;
  if(msg.method==='item/started'&&msg.params?.item?.type==='agentMessage'){
   flushMessage();messageBuffer='';messageDirty=false;
  }
  if(entry.kind==='message'){
   flushSummary();
   messageBuffer=(messageBuffer+entry.text).slice(-4000);
   messageDirty=true;
   if(messageTimer===null)messageTimer=setTimeout(flushMessage,200);
   return;
  }
  flushMessage();
  if(entry.kind==='summary'){
   if(summaryLength>=2000)return;
   summaryLength+=entry.text.length;
   summary=(summary+entry.text).slice(0,320);
   if(summary.length>=200)flushSummary();
   else if(timer===null)timer=setTimeout(flushSummary,500);
  }else{
   flushSummary();
   send(entry);
  }
 };
 return {onEvent,flush:async()=>{flushMessage();flushSummary();await chain;},publish:send};
}

/**
 * Shared frontend API transport and session lifecycle.
 * The public behavior is deliberately unchanged during extraction:
 * same-origin credentials, one refresh for concurrent 401s, and expiry event.
 */
export const authTokenKey = 'ado-token';
const key = authTokenKey;

export class AuthExpiredError extends Error {}
let refreshInFlight:Promise<string|null>|null=null;
export function renewAccessToken():Promise<string|null>{
 if(refreshInFlight)return refreshInFlight;
 refreshInFlight=(async()=>{
  try{
   const response=await fetch('/api/auth/refresh',{method:'POST',credentials:'same-origin'});
   if(!response.ok)return null;
   const data=await response.json() as {token?:string};
   if(!data.token)return null;
   sessionStorage.setItem(key,data.token);
   return data.token;
  }catch{return null;}
 })().finally(()=>{refreshInFlight=null;});
 return refreshInFlight;
}
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
 const send=(token:string|null)=>fetch('/api'+path,{...options,credentials:'same-origin',headers:{...(options.body!=null?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});
 let response=await send(sessionStorage.getItem(key));
 if(response.status===401 && path!=='/login' && !path.startsWith('/auth/')){
  const nextToken=await renewAccessToken();
  if(nextToken)response=await send(nextToken);
  else{
   sessionStorage.removeItem(key);
   window.dispatchEvent(new Event('ado-session-expired'));
   throw new AuthExpiredError('Сессия завершена');
  }
 }
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Object.assign(Error(data.error||'Ошибка запроса'),{status:response.status});
 return data as T;
}

/** Authenticated SSE over fetch. EventSource cannot send our bearer header.
 * Last-Event-ID is represented by the persisted bigint cursor on reconnect.
 */
export async function streamPmProgress(projectId:string,after:number,onEvent:(event:{
 id:string;message_id:string;attempt:number;kind:'status'|'summary'|'plan'|'tool'|'message';text:string;created_at:string;
})=>void,signal:AbortSignal){
 const url='/api/projects/'+encodeURIComponent(projectId)+'/manager/inbox/progress?after='+after;
 const send=(token:string|null)=>fetch(url,{credentials:'same-origin',signal,headers:{
  Accept:'text/event-stream',...(token?{Authorization:'Bearer '+token}:{})
 }});
 let response=await send(sessionStorage.getItem(key));
 if(response.status===401){
  const token=await renewAccessToken();
  if(!token)throw new AuthExpiredError('Сессия завершена');
  response=await send(token);
 }
 if(!response.ok||!response.body)throw Error('Не удалось подключиться к событиям ПМ');
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let buffer='';
 try{
  while(!signal.aborted){
   const result=await reader.read();
   if(result.done)break;
   buffer+=decoder.decode(result.value,{stream:true});
   if(buffer.length>128000)throw Error('Превышен буфер событий ПМ');
   let marker=buffer.indexOf('\n\n');
   while(marker>=0){
    const block=buffer.slice(0,marker).replaceAll('\r','');
    buffer=buffer.slice(marker+2);
    const line=block.split('\n').find(value=>value.startsWith('data: '));
    if(line){
     try{
      const event=JSON.parse(line.slice(6));
      if(typeof event.id==='string'&&typeof event.message_id==='string'&&
       typeof event.text==='string'&&['status','summary','plan','tool','message'].includes(event.kind))
       onEvent(event);
     }catch{/* Ignore a malformed event without interrupting the connection. */}
    }
    marker=buffer.indexOf('\n\n');
   }
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

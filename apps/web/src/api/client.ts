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

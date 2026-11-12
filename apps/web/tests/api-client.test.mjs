import test from 'node:test';
import assert from 'node:assert/strict';
import {api,AuthExpiredError,authTokenKey} from '../src/api/client.ts';

function setupBrowser(initialToken){
 const data=new Map(initialToken?[[authTokenKey,initialToken]]:[]);
 const events=[];
 globalThis.sessionStorage={
  getItem:key=>data.get(key)??null,
  setItem:(key,value)=>data.set(key,String(value)),
  removeItem:key=>data.delete(key)
 };
 globalThis.window={dispatchEvent:event=>{events.push(event.type);return true}};
 return {data,events};
}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('API transport preserves same-origin credentials, bearer auth and JSON payload',async()=>{
 setupBrowser('token-1');
 let seen;
 globalThis.fetch=async(url,options)=>{seen={url,options};return json({ok:true})};
 assert.deepEqual(await api('/tasks',{method:'POST',body:JSON.stringify({title:'Task'})}),{ok:true});
 assert.equal(seen.url,'/api/tasks');
 assert.equal(seen.options.credentials,'same-origin');
 assert.equal(seen.options.headers.Authorization,'Bearer token-1');
 assert.equal(seen.options.headers['Content-Type'],'application/json');
 assert.equal(seen.options.method,'POST');
});

test('401 refreshes token and retries original request once',async()=>{
 const {data}=setupBrowser('expired');
 let refreshes=0,resources=0;
 globalThis.fetch=async(url,options)=>{
  if(url==='/api/auth/refresh'){
   refreshes++;assert.equal(options.credentials,'same-origin');
   return json({token:'renewed'});
  }
  resources++;
  return options.headers.Authorization==='Bearer renewed'?json({saved:true}):json({error:'expired'},401);
 };
 assert.deepEqual(await api('/resource'),{saved:true});
 assert.equal(refreshes,1);
 assert.equal(resources,2);
 assert.equal(data.get(authTokenKey),'renewed');
});

test('concurrent 401 responses share a single refresh request',async()=>{
 setupBrowser('expired');
 let refreshes=0;
 globalThis.fetch=async(url,options)=>{
  if(url==='/api/auth/refresh'){
   refreshes++;
   await new Promise(resolve=>setImmediate(resolve));
   return json({token:'renewed'});
  }
  return options.headers.Authorization==='Bearer renewed'?json({ok:true}):json({error:'expired'},401);
 };
 const responses=await Promise.all([api('/one'),api('/two')]);
 assert.deepEqual(responses,[{ok:true},{ok:true}]);
 assert.equal(refreshes,1);
});

test('failed refresh clears token and reports a session-expired event',async()=>{
 const {data,events}=setupBrowser('expired');
 globalThis.fetch=async(url)=>url==='/api/auth/refresh'?json({error:'denied'},401):json({error:'expired'},401);
 await assert.rejects(api('/projects'),error=>error instanceof AuthExpiredError);
 assert.equal(data.has(authTokenKey),false);
 assert.deepEqual(events,['ado-session-expired']);
});

test('login failures are not refreshed; HTTP error retains status',async()=>{
 const {events}=setupBrowser('expired');
 let calls=0;
 globalThis.fetch=async()=>{calls++;return json({error:'Bad credentials'},401)};
 await assert.rejects(api('/login',{method:'POST'}),error=>error.status===401&&error.message==='Bad credentials');
 assert.equal(calls,1);
 assert.deepEqual(events,[]);
});

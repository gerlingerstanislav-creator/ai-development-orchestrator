import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerCodexAdminRoutes} from '../dist/modules/codex/api.js';

function json(body,status=200){return new Response(JSON.stringify(body),{status});}
async function fixture({email='owner@example.test',grant=true}={}){
 const app=Fastify();
 const calls=[];
 const db={query:async(sql,args)=>{
  assert.match(sql,/SELECT email FROM users/);
  assert.deepEqual(args,['user-1']);
  return {rows:[{email}],rowCount:1};
 }};
 app.addHook('preHandler',async request=>{request.userId='user-1';});
 registerCodexAdminRoutes({
  app,pool:db,runnerUrl:'http://codex:4300',
  runnerSecret:()=> 'only-test-runner-secret',
  adminEmail:()=> 'owner@example.test',
  requireAdmin:async(_req,reply)=>{
   if(!grant){reply.code(403).send({error:'Forbidden'});return false;}
   return true;
  }
 });
 await app.ready();
 return {app,calls};
}
test('Codex endpoints preserve administrator-only access without forwarding forbidden requests',async()=>{
 const {app}=await fixture({email:'intruder@example.test'});
 const original=globalThis.fetch;
 let count=0;
 globalThis.fetch=async()=>{count++;return json({connected:true})};
 try{
  for(const [method,url] of [['GET','/api/codex/status'],['POST','/api/codex/login'],['GET','/api/codex/rate-limits']]){
   const response=await app.inject({method,url});
   assert.equal(response.statusCode,403,url);
  }
  assert.equal(count,0);
 }finally{globalThis.fetch=original;await app.close();}
});
test('Codex management forwards expected method, path and shared secret',async()=>{
 const {app}=await fixture();
 const original=globalThis.fetch;
 const requests=[];
 globalThis.fetch=async(url,options)=>{
  requests.push({url,options});
  return json({connected:true});
 };
 try{
  const operations=[['GET','status'],['POST','login'],['GET','device'],['POST','logout'],['POST','test']];
  for(const [method,part] of operations){
   const response=await app.inject({method,url:'/api/codex/'+part});
   assert.equal(response.statusCode,200,part);
  }
  assert.deepEqual(requests.map(x=>x.url),operations.map(([,p])=>'http://codex:4300/'+p));
  assert.deepEqual(requests.map(x=>x.options.method),operations.map(([method])=>method));
  for(const entry of requests){
   assert.equal(entry.options.headers['X-Runner-Secret'],'only-test-runner-secret');
   assert.equal(entry.options.signal.aborted,false);
  }
 }finally{globalThis.fetch=original;await app.close();}
});
test('Codex limits preserve forced refresh, upstream 409, invalid schema and transport failures',async()=>{
 const {app}=await fixture();
 const original=globalThis.fetch;
 try{
  let request;
  globalThis.fetch=async(url,options)=>{request={url,options};return json({windows:[{id:'limit'}]})};
  const ok=await app.inject({url:'/api/codex/rate-limits?refresh=1'});
  assert.equal(ok.statusCode,200);
  assert.deepEqual(ok.json().windows,[{id:'limit'}]);
  assert.equal(request.url,'http://codex:4300/usage-limits?refresh=1');
  assert.equal(request.options.headers['X-Runner-Secret'],'only-test-runner-secret');

  globalThis.fetch=async()=>json({error:'not authenticated'},409);
  assert.equal((await app.inject({url:'/api/codex/rate-limits'})).statusCode,409);
  globalThis.fetch=async()=>json({broken:true});
  const invalid=await app.inject({url:'/api/codex/rate-limits'});
  assert.equal(invalid.statusCode,503);
  assert.match(invalid.json().error,/неожиданный формат/);
  globalThis.fetch=async()=>{throw new Error('offline')};
  const offline=await app.inject({url:'/api/codex/rate-limits'});
  assert.equal(offline.statusCode,503);
  assert.match(offline.json().error,/offline/);
 }finally{globalThis.fetch=original;await app.close();}
});
test('rate-limit scope also requires service administrator privileges',async()=>{
 const {app}=await fixture({grant:false});
 const original=globalThis.fetch;
 let invoked=false;
 globalThis.fetch=async()=>{invoked=true;return json({windows:[]})};
 try{
  assert.equal((await app.inject({url:'/api/codex/rate-limits'})).statusCode,403);
  assert.equal(invoked,false);
 }finally{globalThis.fetch=original;await app.close();}
});

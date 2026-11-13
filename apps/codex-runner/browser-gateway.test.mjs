import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';

test('QA browser bridge isolates attempts, rejects stale tokens and closes sessions',async t=>{
 const upstreamSessions=new Map(), closed=[];
 const upstream=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/health')return res.end(JSON.stringify({ok:true}));
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);
  const old=upstreamSessions.get(body.session);
  if(old&&old!==body.token){
   res.writeHead(400);return res.end(JSON.stringify({ok:false,error:'Invalid QA session token'}));
  }
  if(body.action==='close'){
   upstreamSessions.delete(body.session);closed.push(body.session);
   return res.end(JSON.stringify({ok:true}));
  }
  if(!old)upstreamSessions.set(body.session,body.token);
  if(body.action==='assert')return res.end(JSON.stringify({ok:true,assertion:'passed',viewport:{width:390,height:844}}));
  res.end(JSON.stringify({ok:true}));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const originalUrl=process.env.QA_BROWSER_URL;
 process.env.QA_BROWSER_URL='http://127.0.0.1:'+upstream.address().port;
 const {startQaBrowserGateway,openQaBrowserSession,getQaBrowserEvidence,closeQaBrowserSession}=await import('./browser-gateway.mjs');
 const gateway=startQaBrowserGateway();await once(gateway,'listening');
 t.after(async()=>{
  await new Promise(resolve=>gateway.close(resolve));
  await new Promise(resolve=>upstream.close(resolve));
  if(originalUrl===undefined)delete process.env.QA_BROWSER_URL;
  else process.env.QA_BROWSER_URL=originalUrl;
 });
 const invoke=async(session,action,extra={})=>{
  const response=await fetch('http://127.0.0.1:4311/action',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({...session,action,...extra})
  });
  return {status:response.status,body:await response.json()};
 };
 const firstId=randomUUID(),secondId=randomUUID(),caseId=randomUUID();
 const first=openQaBrowserSession(firstId,[caseId]);
 assert.deepEqual((await invoke(first,'ping')).body,{ok:true,bridge:'connected'},'Sandbox ping must be authenticated without starting Chromium');
 assert.equal(upstreamSessions.has(firstId),false,'Bridge ping must not open an upstream session');
 assert.equal((await invoke({...first,token:'f'.repeat(64)},'ping')).status,403);
 assert.equal((await invoke(first,'start')).body.ok,true);
 assert.throws(()=>openQaBrowserSession(firstId,[caseId]),/already active/,'never rotate a live token');
 assert.equal((await invoke({...first,token:'f'.repeat(64)},'start')).status,403);
 assert.equal((await invoke(first,'assert',{qaKind:'case',qaId:caseId,expression:'true'})).body.assertion,'passed');
 assert.equal(getQaBrowserEvidence(firstId).length,1);
 await closeQaBrowserSession(firstId);
 assert.ok(closed.includes(firstId),'closing a QA job must close its upstream Chromium session');
 assert.equal(upstreamSessions.has(firstId),false);

 // A QA retry is a different attempt, even when it tests the same task.
 const second=openQaBrowserSession(secondId,[caseId]);
 assert.notEqual(second.token,first.token);
 assert.equal((await invoke(second,'start')).body.ok,true);
 assert.equal((await invoke({...second,token:first.token},'start')).status,403);
 assert.equal(getQaBrowserEvidence(secondId).length,0,'no evidence leaks from previous attempt');
 await closeQaBrowserSession(secondId);
 assert.deepEqual(closed,[firstId,secondId]);
 assert.equal(upstreamSessions.size,0,'no browser process retained after QA attempts');
});

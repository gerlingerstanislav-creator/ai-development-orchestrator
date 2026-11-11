import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {setDevelopmentMode,developmentModeEnabled,registerCloudDiagnosticsSettings,syncCloudDiagnosticsOnce,sendCloudBatch} from '../dist/cloud-diagnostics.js';

test('development mode defaults on and toggling persists/reset cloud cursors',async()=>{
 const state={enabled:true,resets:0};
 const query=async(sql,params=[])=>{
  if(sql.startsWith('SELECT development_mode'))return {rows:[{development_mode:state.enabled}]};
  if(sql.includes('INSERT INTO diagnostic_cloud_cursors')){state.resets++;return {rows:[]};}
  if(sql.includes('UPDATE service_diagnostics_settings')){state.enabled=params[0];return {rows:[]};}
  return {rows:[]};
 };
 const pool={query,connect:async()=>({query,release(){}})};
 assert.equal(await developmentModeEnabled(pool),true);
 assert.deepEqual(await setDevelopmentMode(pool,false),{development_mode:false});
 assert.equal(state.resets,9);
 assert.equal(await developmentModeEnabled(pool),false);
 await setDevelopmentMode(pool,false);
 assert.equal(state.resets,9,'repeating same setting does not reset cursors');
 await setDevelopmentMode(pool,true);
 assert.equal(state.resets,18);
});
test('settings API denies unauthenticated access and saves bool only',async()=>{
 let enabled=true;
 const query=async(sql,params=[])=>{
  if(sql.startsWith('SELECT development_mode'))return {rows:[{development_mode:enabled}]};
  if(sql.includes('UPDATE service_diagnostics_settings'))enabled=params[0];
  return {rows:[]};
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const app=Fastify();
 try{
  registerCloudDiagnosticsSettings(app,{pool,requireAdmin:async(req,reply)=>{
   if(req.headers.authorization!=='Bearer valid'){reply.code(403).send({error:'Forbidden'});return false;}return true;
  }});
  assert.equal((await app.inject({method:'GET',url:'/api/diagnostics/settings'})).statusCode,403);
  const get=await app.inject({method:'GET',url:'/api/diagnostics/settings',headers:{authorization:'Bearer valid'}});
  assert.deepEqual(get.json(),{development_mode:true});
  const bad=await app.inject({method:'PUT',url:'/api/diagnostics/settings',headers:{authorization:'Bearer valid'},payload:{development_mode:'false'}});
  assert.equal(bad.statusCode,500,'the API schema rejects string booleans');
  const updated=await app.inject({method:'PUT',url:'/api/diagnostics/settings',headers:{authorization:'Bearer valid'},payload:{development_mode:false}});
  assert.equal(updated.statusCode,200,updated.body);
  assert.deepEqual(updated.json(),{development_mode:false});
 }finally{await app.close();}
});
test('disabled mode never reads source records or sends cloud HTTP',async()=>{
 let fetchCalls=0,reads=0;
 const pool={query:async(sql)=>{
  if(sql.startsWith('SELECT development_mode'))return {rows:[{development_mode:false}]};
  reads++;return {rows:[]};
 }};
 assert.equal(await syncCloudDiagnosticsOnce(pool,{url:'https://example.supabase.co',apiKey:'sb_publishable_test',fetchFn:async()=>{fetchCalls++;return new Response('',{status:201});}}),0);
 assert.equal(fetchCalls,0);assert.equal(reads,0);
});
test('sender redacts process details and sends publishable key only in apikey header',async()=>{
 const requests=[];
 const fetchFn=async(url,options)=>{requests.push({url,options});return new Response('',{status:201});};
 const row={id:'00000000-0000-4000-8000-000000000001',project_id:'00000000-0000-4000-8000-000000000002',project_name:'Test',event_at:new Date(),level:'error',detail:'QA failed Bearer eyJhbGciOi.secret'};
 const pool={query:async(sql)=>{
  if(sql.startsWith('SELECT development_mode'))return {rows:[{development_mode:true}]};
  if(sql.startsWith('SELECT last_at'))return {rows:[]};
  if(sql.includes('FROM process_events'))return {rows:[row]};
  return {rows:[]};
 }};
 const count=await syncCloudDiagnosticsOnce(pool,{url:'https://example.supabase.co',apiKey:'sb_publishable_test',fetchFn});
 assert.equal(count,1);assert.equal(requests.length,1);
 assert.equal(requests[0].options.headers.apikey,'sb_publishable_test');
 assert.equal('Authorization' in requests[0].options.headers,false);
 const sent=JSON.parse(requests[0].options.body);
 assert.equal(sent.length,1);
 assert.match(JSON.stringify(sent),/QA failed/);
 assert.doesNotMatch(JSON.stringify(sent),/eyJhbGciOi/);
 assert.match(sent[0].event_key,/^process:/);
 assert.ok(requests[0].url.endsWith('/rest/v1/ado_diagnostic_events?on_conflict=event_key'));
});
test('cloud errors propagate so checkpoint is not advanced',async()=>{
 await assert.rejects(()=>sendCloudBatch([{event_key:'x'}],'https://example.supabase.co','sb_publishable_key',
  async()=>new Response('unauthorized',{status:401})),/HTTP 401/);
});

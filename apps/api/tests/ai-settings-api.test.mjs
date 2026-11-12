import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {z} from 'zod';
import {registerAiSettingsRoutes} from '../dist/modules/execution/api/ai-settings.js';

const project='123e4567-e89b-42d3-a456-426614174000';
function fixture({member=true,admin=true}={}){
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('SELECT model,reasoning,enabled FROM project_ai_settings'))return {rows:[],rowCount:0};
  if(sql.startsWith('INSERT INTO project_ai_settings'))return {rows:[],rowCount:1};
  if(sql.includes('UNION ALL'))return {rows:[{id:'run-1',model:'gpt-6-luna',status:'queued'}],rowCount:1};
  if(sql.includes('COUNT(*)::int AS requests'))return {rows:[{
   input_tokens:'11',cached_input_tokens:'4',output_tokens:'2',requests:1
  }],rowCount:1};
  if(sql.includes('ORDER BY created_at DESC LIMIT 20'))return {rows:[],rowCount:0};
  throw Error('Unexpected SQL '+sql);
 }};
 const app=Fastify();
 app.setErrorHandler((e,_req,reply)=>{
  if(e instanceof z.ZodError)return reply.code(400).send({error:'Invalid schema'});
  return reply.code(500).send({error:'Unexpected'});
 });
 registerAiSettingsRoutes(app,{
  pool:db,
  access:async(_req,reply)=>{
   if(!member){reply.code(403).send({error:'No project access'});return false;}
   return true;
  },
  requireAdmin:async(_req,reply)=>{
   if(!admin){reply.code(403).send({error:'Administrator only'});return false;}
   return true;
  }
 });
 return {app,calls};
}
test('project AI defaults and operator changes use scoped SQL and allowed models',async()=>{
 const f=fixture();
 try{
  const get=await f.app.inject({url:'/api/projects/'+project+'/ai-settings'});
  assert.equal(get.statusCode,200);
  assert.deepEqual(get.json(),{model:'gpt-6-luna',reasoning:'low',enabled:false});
  const chosen={model:'gpt-6-sol',reasoning:'medium',enabled:true};
  const put=await f.app.inject({method:'PUT',url:'/api/projects/'+project+'/ai-settings',payload:chosen});
  assert.equal(put.statusCode,200);
  assert.deepEqual(put.json(),chosen);
  assert.deepEqual(f.calls[1].args,[project,chosen.model,chosen.reasoning,chosen.enabled]);
  const invalid=await f.app.inject({method:'PUT',url:'/api/projects/'+project+'/ai-settings',
   payload:{model:'other-model',reasoning:'high',enabled:true}});
  assert.equal(invalid.statusCode,400);
  assert.equal(f.calls.length,2);
 }finally{await f.app.close();}
});
test('AI usage is scoped to project members and platform totals to admins',async()=>{
 const outsider=fixture({member:false,admin:false});
 try{
  for(const path of ['/api/projects/'+project+'/ai-settings','/api/projects/'+project+'/token-usage',
   '/api/projects/'+project+'/ai-runs']){
   assert.equal((await outsider.app.inject({url:path})).statusCode,403);
  }
  assert.equal((await outsider.app.inject({url:'/api/ai/token-usage'})).statusCode,403);
  assert.equal(outsider.calls.length,0);
 }finally{await outsider.app.close();}
 const member=fixture({admin:false});
 try{
  const usage=await member.app.inject({url:'/api/projects/'+project+'/token-usage'});
  assert.equal(usage.statusCode,200);
  assert.equal(usage.json().input_tokens,'11');
  const denied=await member.app.inject({method:'PUT',url:'/api/projects/'+project+'/ai-settings',
   payload:{model:'gpt-6-luna',reasoning:'low',enabled:false}});
  assert.equal(denied.statusCode,403);
  assert.equal(member.calls.length,1);
  assert.deepEqual(member.calls[0].args,[project]);
 }finally{await member.app.close();}
});
test('usage endpoints retain response contract and queued runs projection',async()=>{
 const f=fixture();
 try{
  const aggregate=await f.app.inject({url:'/api/ai/token-usage'});
  assert.deepEqual(aggregate.json(),{
   totals:{input_tokens:'11',cached_input_tokens:'4',output_tokens:'2',requests:1},latest:[]
  });
  const runs=await f.app.inject({url:'/api/projects/'+project+'/ai-runs'});
  assert.equal(runs.statusCode,200);
  assert.deepEqual(runs.json(),[{id:'run-1',model:'gpt-6-luna',status:'queued'}]);
  const runQuery=f.calls.find(x=>x.sql.includes('UNION ALL'));
  assert.deepEqual(runQuery.args,[project]);
 }finally{await f.app.close();}
});

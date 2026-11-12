import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {listProjectProcesses} from '../dist/modules/processes/infrastructure/project-process-list.js';
import {registerProjectProcessRoutes} from '../dist/modules/processes/project-api.js';

const project='123e4567-e89b-42d3-a456-426614174001';
const processId='123e4567-e89b-42d3-a456-426614174002';
function database(rows=()=>[]){
 const queries=[];
 return {
  queries,
  async query(sql,args){
   queries.push({sql,args});
   return {rows:rows(sql,args),rowCount:0};
  },
  async connect(){throw Error('Unexpected transaction: no running process');}
 };
}
function fixture({allowed=true,admin=true,db=database()}={}){
 const app=Fastify();
 let temporalCalls=0;
 registerProjectProcessRoutes(app,{
  pool:db,uid:()=> 'owner-id',
  access:async(_req,reply)=>{
   if(!allowed){reply.code(403).send({error:'Not a project member'});return false;}
   return true;
  },
  requireAdmin:async(_req,reply)=>{
   if(!admin){reply.code(403).send({error:'Administrator required'});return false;}
   return true;
  },
  temporal:async()=>{temporalCalls++;throw Error('Unexpected workflow dispatch');}
 });
 return {app,db,get temporalCalls(){return temporalCalls}};
}
test('project process read model never mutates state and scopes every query to one project',async()=>{
 const db=database(sql=>{
  if(sql.includes('FROM ai_task_runs r JOIN tasks t'))return [{
   id:processId,task_id:'task-id',status:'running',message:'Работа',model:'gpt-6-luna',
   created_at:'2026-11-12T10:00:00Z',completed_at:null,task_title:'Задача',display_number:17,pr_url:null
  }];
  return [];
 });
 const state=await listProjectProcesses(db,project);
 assert.equal(state.processes.length,1);
 assert.deepEqual(state.processes[0],{
  id:processId,kind:'development',title:'Разработка #17 · Задача',
  status:'running',detail:'Работа',createdAt:'2026-11-12T10:00:00Z',
  updatedAt:null,taskId:'task-id',result:null
 });
 assert.ok(db.queries.length>=13);
 for(const {sql,args} of db.queries){
  assert.match(sql.trim(),/^SELECT\b/i);
  assert.deepEqual(args,[project]);
 }
 assert.ok(Date.parse(state.checkedAt)>0);
});
test('process event and prompt endpoints require project membership and administrator privileges',async()=>{
 const outsider=fixture({allowed:false});
 try{
  for(const path of ['/api/projects/'+project+'/processes',
   '/api/projects/'+project+'/processes/'+processId+'/events',
   '/api/projects/'+project+'/processes/'+processId+'/prompts']){
   assert.equal((await outsider.app.inject({url:path})).statusCode,403,path);
  }
  assert.equal(outsider.db.queries.length,0);
 }finally{await outsider.app.close();}
 const member=fixture({admin:false});
 try{
  const result=await member.app.inject({url:'/api/projects/'+project+'/processes/'+processId+'/prompts'});
  assert.equal(result.statusCode,403);
  assert.equal(member.db.queries.length,0);
  const logs=await member.app.inject({url:'/api/projects/'+project+'/processes/'+processId+'/events'});
  assert.equal(logs.statusCode,200);
  assert.equal(member.db.queries.length,1);
  assert.deepEqual(member.db.queries[0].args,[project,processId]);
 }finally{await member.app.close();}
});
test('admin prompt audit response preserves exact project and run scoping',async()=>{
 const db=database(sql=>sql.includes('FROM agent_prompt_audit')?[{
  id:'prompt-1',role:'testing',operation:'codex_exec',prompt:'Task context',truncated:false
 }]:[]);
 const {app}=fixture({db});
 try{
  const reply=await app.inject({url:'/api/projects/'+project+'/processes/'+processId+'/prompts'});
  assert.equal(reply.statusCode,200);
  assert.equal(reply.json().prompts[0].operation,'codex_exec');
  assert.deepEqual(db.queries.map(x=>x.args),[[project,processId]]);
 }finally{await app.close();}
});
test('internal prompt ingestion refuses missing secret and unknown process',async()=>{
 const old=process.env.RUNNER_SHARED_SECRET;
 process.env.RUNNER_SHARED_SECRET='test-runner-secret';
 const {app,db}=fixture();
 try{
  const payload={projectId:project,processId,role:'development',prompt:'Approved developer prompt'};
  const missing=await app.inject({method:'POST',url:'/internal/agent-prompt',payload});
  assert.equal(missing.statusCode,403);
  assert.equal(db.queries.length,0);
  const unknown=await app.inject({method:'POST',url:'/internal/agent-prompt',
   headers:{'x-runner-secret':'test-runner-secret'},payload});
  assert.equal(unknown.statusCode,404);
  assert.deepEqual(db.queries[0].args,[project,processId]);
 }finally{
  if(old===undefined)delete process.env.RUNNER_SHARED_SECRET;
  else process.env.RUNNER_SHARED_SECRET=old;
  await app.close();
 }
});
test('stop refuses inactive processes without calling Temporal or external Runner',async()=>{
 const context=fixture();
 const original=globalThis.fetch;
 let networkCalls=0;
 globalThis.fetch=async()=>{networkCalls++;throw Error('Unexpected external request')};
 try{
  const result=await context.app.inject({method:'POST',
   url:'/api/projects/'+project+'/processes/'+processId+'/stop'});
  assert.equal(result.statusCode,409);
  assert.equal(context.temporalCalls,0);
  assert.equal(networkCalls,0);
  assert.ok(context.db.queries.some(x=>x.sql.includes('UPDATE agent_analysis_runs')));
  assert.ok(context.db.queries.some(x=>x.sql.includes('UPDATE ai_test_runs')));
 }finally{globalThis.fetch=original;await context.app.close();}
});

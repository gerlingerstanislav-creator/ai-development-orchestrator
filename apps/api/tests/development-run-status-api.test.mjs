import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {z} from 'zod';
import {registerDevelopmentRunStatusRoutes} from '../dist/modules/execution/api/development-run-status.js';

const projectId='123e4567-e89b-42d3-a456-426614174002';
const runId='123e4567-e89b-42d3-a456-426614174000';
const taskId='123e4567-e89b-42d3-a456-426614174001';
function fixture({allowed=true,run=null,intent=null}={}){
 const queries=[];
 const app=Fastify();
 app.setErrorHandler((error,_req,reply)=>{
  if(error instanceof z.ZodError)return reply.code(400).send({error:'Некорректные данные'});
  return reply.code(500).send({error:'Internal error'});
 });
 registerDevelopmentRunStatusRoutes({app,pool:{query:async(sql,args)=>{
  queries.push({sql,args});
  assert.match(sql.trim(),/^SELECT\s/i,'GET must never mutate database');
  if(sql.includes('FROM ai_task_runs')){
   assert.deepEqual(args,[runId,projectId],'run lookup must be project-scoped');
   return {rows:run?[run]:[],rowCount:run?1:0};
  }
  if(sql.includes('FROM iteration_execution_queue')){
   assert.deepEqual(args,[projectId,runId],'queue lookup must be project-scoped');
   return {rows:intent?[intent]:[],rowCount:intent?1:0};
  }
  throw Error('Unexpected SQL '+sql);
 }},access:async(_req,reply)=>{
  if(!allowed){reply.code(403).send({error:'Нет доступа к проекту'});return false;}
  return true;
 }});
 return {app,queries};
}

test('legacy development status is read-only and has no runner side effects',async()=>{
 const record={id:runId,task_id:taskId,model:'gpt-6',status:'running',branch:'feature/task',pr_url:null,message:'Writing code',cycle_id:null};
 const f=fixture({run:record});
 try{
  const response=await f.app.inject({url:'/api/projects/'+projectId+'/ai-runs/'+runId});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),record);
  assert.equal(f.queries.length,1);
 }finally{await f.app.close();}
});

test('Temporal cycle-backed run is returned as persisted without remote polling',async()=>{
 const record={id:runId,task_id:taskId,status:'completed',cycle_id:runId,pr_url:'https://github.com/acme/repo/pull/42'};
 const f=fixture({run:record});
 try{
  assert.deepEqual((await f.app.inject({url:'/api/projects/'+projectId+'/ai-runs/'+runId})).json(),record);
  assert.equal(f.queries.length,1);
 }finally{await f.app.close();}
});

test('queued iteration intent preserves compatibility statuses, model and message',async()=>{
 for(const [status,expected] of [['queued','queued'],['dispatched','completed'],['stale','failed']]){
  const f=fixture({intent:{id:runId,task_id:taskId,status,message:null,model:'gpt-6',created_at:'2026-11-13'}});
  try{
   const response=await f.app.inject({url:'/api/projects/'+projectId+'/ai-runs/'+runId});
   assert.equal(response.statusCode,200);
   assert.equal(response.json().status,expected);
   assert.equal(response.json().message,'Ожидает диспетчера разработки');
   assert.equal(response.json().model,'gpt-6');
   assert.equal(f.queries.length,2);
  }finally{await f.app.close();}
 }
});

test('status route protects project scope, returns 404 for missing run',async()=>{
 const denied=fixture({allowed:false});
 const absent=fixture();
 try{
  assert.equal((await denied.app.inject({url:'/api/projects/'+projectId+'/ai-runs/'+runId})).statusCode,403);
  assert.equal(denied.queries.length,0);
  const missing=await absent.app.inject({url:'/api/projects/'+projectId+'/ai-runs/'+runId});
  assert.equal(missing.statusCode,404);
  assert.deepEqual(missing.json(),{error:'Запуск не найден'});
  assert.equal(absent.queries.length,2);
 }finally{await denied.app.close();await absent.app.close();}
});

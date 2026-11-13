import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {z} from 'zod';
import {registerProjectTaskRoutes} from '../dist/modules/tasks/api.js';

const project='123e4567-e89b-42d3-a456-426614174000';
const task='123e4567-e89b-42d3-a456-426614174001';
const dep='123e4567-e89b-42d3-a456-426614174002';
function fixture({member=true,admin=true,query,connect}={}){
 const queries=[];let temporalCalls=0;
 const run=async(sql,args)=>{
  queries.push({sql,args});
  return (await query?.(sql,args))??{rows:[],rowCount:0};
 };
 const pool={query:run,connect:connect??(async()=>{throw Error('Unexpected transaction');})};
 const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>{
  if(error instanceof z.ZodError)return reply.code(400).send({error:'Schema validation failed'});
  return reply.code(error.statusCode||500).send({error:error.message});
 });
 const module=registerProjectTaskRoutes(app,{
  pool,uid:()=> 'actor-1',
  access:async(_req,reply)=>{
   if(!member){reply.code(403).send({error:'Not a member'});return false;}
   return true;
  },
  requireAdmin:async(_req,reply)=>{
   if(!admin){reply.code(403).send({error:'Owner approval required'});return false;}
   return true;
  },
  temporal:async()=>{temporalCalls++;throw Error('Unexpected Temporal dispatch');}
 });
 return {app,queries,...module,get temporalCalls(){return temporalCalls}};
}
test('nonmembers cannot read or mutate project task resources',async()=>{
 const f=fixture({member:false});
 try{
  const samples=[
   ['GET','/tasks',undefined],['POST','/tasks',{title:'No access'}],
   ['GET','/tasks/'+task+'/events',undefined],
   ['GET','/tasks/'+task+'/activity',undefined],
   ['GET','/tasks/'+task+'/requirements',undefined],
   ['POST','/tasks/'+task+'/requirements/retry',{}],
   ['PUT','/tasks/'+task+'/dependency',{depends_on_task_id:dep}],
   ['PATCH','/tasks/'+task,{title:'Forbidden'}]
  ];
  for(const [method,suffix,payload] of samples){
   const response=await f.app.inject({method,url:'/api/projects/'+project+suffix,...(payload?{payload}:{})});
   assert.equal(response.statusCode,403,method+' '+suffix);
  }
  assert.equal(f.queries.length,0);
  assert.equal(f.temporalCalls,0);
 }finally{await f.app.close();}
});
test('new task creation enforces project-owned parent and document question boundaries',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.startsWith('SELECT 1 FROM tasks WHERE id='))return {rows:[{exists:1}],rowCount:1};
  if(sql.startsWith('SELECT 1 FROM documents'))return {rows:[{exists:1}],rowCount:1};
  return {rows:[],rowCount:1};
 }});
 try{
  const path='/api/projects/'+project+'/tasks';
  const invalid=await f.app.inject({method:'POST',url:path,payload:{title:'Question',type:'question'}});
  assert.equal(invalid.statusCode,400);
  assert.equal(f.queries.length,0);
  const created=await f.app.inject({method:'POST',url:path,
   payload:{title:'User question',type:'question',document_id:dep,description:'What scope?'}});
  assert.equal(created.statusCode,201,JSON.stringify(created.json()));
  const insert=f.queries.find(x=>x.sql.includes("INSERT INTO tasks"));
  assert.match(insert.sql,/question_status\) VALUES/);
  assert.deepEqual(insert.args.slice(1,4),[project,'User question','What scope?']);
  assert.ok(f.queries.some(x=>x.sql.includes('INSERT INTO task_events')));
  const taskCreated=await f.app.inject({method:'POST',url:path,payload:{title:'Implementation',parent_id:task}});
  assert.equal(taskCreated.statusCode,201);
  assert.ok(f.queries.some(x=>x.sql.includes('INSERT INTO tasks(id,project_id,title,description,type,parent_id,position)')));
 }finally{await f.app.close();}
});
test('one dependency update function serves both HTTP and PM without cycles',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.includes('SELECT id,stage,git_branch FROM tasks'))return {rows:[{id:task,stage:'analysis',git_branch:null}],rowCount:1};
  if(sql.includes('SELECT id FROM tasks'))return {rows:[{id:dep}],rowCount:1};
  if(sql.startsWith('WITH RECURSIVE parents'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:1};
 }});
 try{
  await assert.rejects(f.updateDependency(project,task,task,'owner'),/самой себя/);
  assert.equal(f.queries.length,0);
  const change=await f.app.inject({method:'PUT',url:'/api/projects/'+project+'/tasks/'+task+'/dependency',
   payload:{depends_on_task_id:dep}});
  assert.equal(change.statusCode,200);
  assert.deepEqual(change.json(),{ok:true,depends_on_task_id:dep});
  assert.ok(f.queries.some(x=>x.sql.includes('WITH RECURSIVE parents')));
  assert.ok(f.queries.some(x=>x.sql.includes("UPDATE tasks SET depends_on_task_id")));
  const cleared=await f.updateDependency(project,task,null,'actor-1');
  assert.deepEqual(cleared,{ok:true,depends_on_task_id:null});
 }finally{await f.app.close();}
});
test('dependency mutation refuses existing Git branches and graph cycles',async()=>{
 const forked=fixture({query:async sql=>sql.includes('SELECT id,stage,git_branch FROM tasks')
  ?{rows:[{id:task,stage:'development',git_branch:'feature/1'}],rowCount:1}
  :{rows:[],rowCount:0}});
 try{
  await assert.rejects(forked.updateDependency(project,task,dep,'owner'),/после создания ветки/);
  assert.equal(forked.queries.length,1);
 }finally{await forked.app.close();}
 const cyclic=fixture({query:async sql=>{
  if(sql.includes('SELECT id,stage,git_branch FROM tasks'))return {rows:[{stage:'analysis',git_branch:null}],rowCount:1};
  if(sql.startsWith('SELECT id FROM tasks'))return {rows:[{id:dep}],rowCount:1};
  if(sql.startsWith('WITH RECURSIVE parents'))return {rows:[{exists:1}],rowCount:1};
  return {rows:[],rowCount:0};
 }});
 try{
  const response=await cyclic.app.inject({method:'PUT',url:'/api/projects/'+project+'/tasks/'+task+'/dependency',
   payload:{depends_on_task_id:dep}});
  assert.equal(response.statusCode,409);
  assert.match(response.json().error,/цикл зависимостей/);
  assert.equal(cyclic.queries.some(x=>x.sql.includes("UPDATE tasks SET depends_on_task_id")),false);
 }finally{await cyclic.app.close();}
});
test('requirements retry stays blocked while AI is disabled and never starts Temporal',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.includes('SELECT spec_version,spec_review_status FROM tasks'))
   return {rows:[{spec_version:2,spec_review_status:'current'}],rowCount:1};
  if(sql.includes('SELECT enabled FROM project_ai_settings'))
   return {rows:[{enabled:false}],rowCount:1};
  return {rows:[],rowCount:0};
 }});
 try{
  const response=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/tasks/'+task+'/requirements/retry',payload:{}});
  assert.equal(response.statusCode,409);
  assert.equal(response.json().started,false);
  assert.equal(f.temporalCalls,0);
 }finally{await f.app.close();}
});
test('task activity refuses unknown task before accessing other process histories',async()=>{
 const f=fixture();
 try{
  const response=await f.app.inject({url:'/api/projects/'+project+'/tasks/'+task+'/activity'});
  assert.equal(response.statusCode,404);
  assert.equal(f.queries.length,1);
  assert.deepEqual(f.queries[0].args,[task,project]);
 }finally{await f.app.close();}
});
test('direct API task stage changes cannot bypass orchestration workflow',async()=>{
 const calls=[];
 const row={id:task,type:'task',stage:'development',title:'Title',description:'Text',spec_version:1};
 const f=fixture({connect:async()=>({
  query:async(sql,args)=>{
   calls.push({sql,args});
   if(sql.includes('SELECT * FROM tasks'))return {rows:[row],rowCount:1};
   return {rows:[],rowCount:1};
  },release(){}
 })});
 try{
  const response=await f.app.inject({method:'PATCH',url:'/api/projects/'+project+'/tasks/'+task,
   payload:{stage:'done'}});
  assert.equal(response.statusCode,409);
  assert.match(response.json().error,/workflow/);
  assert.ok(calls.some(x=>x.sql==='ROLLBACK'));
  assert.equal(calls.some(x=>/UPDATE tasks|INSERT INTO task_events/.test(x.sql)),false);
 }finally{await f.app.close();}
});

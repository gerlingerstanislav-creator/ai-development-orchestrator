import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerQualityOperationsRoutes} from '../dist/modules/quality/api.js';

const project='123e4567-e89b-42d3-a456-426614174000';
const task='123e4567-e89b-42d3-a456-426614174001';
function fixture({member=true,admin=true,query,temporal}={}){
 const calls=[];let workflows=0;
 const pool={
  query:async(sql,args)=>{
   calls.push({sql,args});
   // The real note guard always yields one count row, including no questions.
   if(sql.includes('SELECT count(*)::int AS count FROM task_agent_notes'))
    return {rows:[{count:0}],rowCount:1};
   return (await query?.(sql,args))??{rows:[],rowCount:0};
  },
  connect:async()=>{throw Error('No transaction should be started in this scenario')}
 };
 const app=Fastify();
 registerQualityOperationsRoutes(app,{
  pool,
  uid:()=> 'user-1',
  access:async(_req,reply)=>{
   if(!member){reply.code(403).send({error:'No project membership'});return false;}
   return true;
  },
  requireAdmin:async(_req,reply)=>{
   if(!admin){reply.code(403).send({error:'Owner required'});return false;}
   return true;
  },
  temporal:async()=>{workflows++;return temporal?.()??{
   workflow:{
    start:async()=>{throw Error('Unexpected workflow start')},
    getHandle:()=>({describe:async()=>{throw Error('Unexpected workflow describe')}})
   }
  }},
  runnerUrl:'http://codex:4300',
  runnerSecret:'test-shared-secret',
  decryptToken:()=> 'mock-github-token'
 });
 return {app,calls,get workflows(){return workflows}};
}
test('project permissions protect all manual QA and quality-gate endpoints',async()=>{
 const f=fixture({member:false,admin:false});
 const urls=[
  ['GET','/test-runs'],['GET','/tasks/'+task+'/quality-gates'],
  ['POST','/tasks/'+task+'/quality-gates'],
  ['POST','/tasks/'+task+'/start-testing'],
  ['POST','/tasks/'+task+'/apply-qa-result']
 ];
 try{
  for(const [method,path] of urls){
   const response=await f.app.inject({method,url:'/api/projects/'+project+path,
    ...(method==='POST'?{payload:{}}:{})});
   assert.equal(response.statusCode,403,method+' '+path);
  }
  assert.equal(f.calls.length,0);
  assert.equal(f.workflows,0);
 }finally{await f.app.close();}
});
test('project QA history remains scoped and excludes screenshot payloads',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.includes("report - 'screenshots'"))return {rows:[{id:'qa-1',report:{summary:'Failed check'}}],rowCount:1};
  throw Error('Unexpected query: '+sql);
 }});
 try{
  const response=await f.app.inject({url:'/api/projects/'+project+'/test-runs'});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),[{id:'qa-1',report:{summary:'Failed check'}}]);
  assert.deepEqual(f.calls[0].args,[project]);
  assert.match(f.calls[0].sql,/report - 'screenshots'/);
 }finally{await f.app.close();}
});
test('manual QA cannot launch before task has a PR and a testing stage',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.startsWith('SELECT stage,pr_url,git_branch'))return {
   rows:[{stage:'development',pr_url:null,git_branch:null}],rowCount:1
  };
  return {rows:[],rowCount:0};
 }});
 try{
  const response=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/tasks/'+task+'/start-testing',payload:{}});
  assert.equal(response.statusCode,409);
  assert.match(response.json().error,/создай PR/);
  assert.equal(f.workflows,0);
 }finally{await f.app.close();}
});
test('a live Temporal workflow prevents a duplicate manual testing worker',async()=>{
 let described=0;
 const f=fixture({
  query:async sql=>{
   if(sql.startsWith('SELECT stage,pr_url,git_branch'))return {
    rows:[{stage:'testing',pr_url:'https://github.com/example/demo/pull/1',git_branch:'feature/1'}],rowCount:1
   };
   if(sql.startsWith('SELECT owner_id,workflow_id,started_at'))return {
    rows:[{owner_id:'owner',workflow_id:'manual-test-existing',started_at:new Date().toISOString()}],rowCount:1
   };
   return {rows:[],rowCount:0};
  },
  temporal:()=>({
   workflow:{
    getHandle:()=>({describe:async()=>{described++;return {status:{name:'RUNNING'}}}}),
    start:async()=>{throw Error('Must not start duplicate testing')}
   }
  })
 });
 try{
  const response=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/tasks/'+task+'/start-testing',payload:{}});
  assert.equal(response.statusCode,409);
  assert.match(response.json().error,/всё ещё выполняется/);
  assert.equal(f.workflows,1);
  assert.equal(described,1);
  assert.equal(f.calls.some(x=>x.sql.includes("UPDATE ai_test_runs")),false);
 }finally{await f.app.close();}
});
test('QA recovery refuses missing confirmed verdict without mutating workflow',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.startsWith('SELECT t.id,t.stage,t.pr_number'))return {
   rows:[{id:task,stage:'testing',pr_number:9,
    spec_version:2,spec_reviewed_version:2,spec_review_status:'current'}],rowCount:1
  };
  return {rows:[],rowCount:0};
 }});
 try{
  const response=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/tasks/'+task+'/apply-qa-result',payload:{}});
  assert.equal(response.statusCode,409);
  assert.match(response.json().error,/Нет завершённого подтверждённого QA/);
  assert.equal(f.workflows,0);
  assert.ok(f.calls.every(x=>!x.sql.startsWith('UPDATE tasks')));
 }finally{await f.app.close();}
});
test('quality gate manual launch requires PR in an eligible task stage',async()=>{
 const f=fixture();
 try{
  const response=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/tasks/'+task+'/quality-gates',payload:{}});
  assert.equal(response.statusCode,409);
  assert.match(response.json().error,/открытый PR/);
  assert.equal(f.workflows,0);
  assert.deepEqual(f.calls[0].args,[project,task]);
 }finally{await f.app.close();}
});
test('quality gate starts only after authorized project and PR checks',async()=>{
 const started=[];
 const f=fixture({
  query:async sql=>sql.includes("pr_number IS NOT NULL")?{rows:[{id:task}],rowCount:1}:{rows:[],rowCount:0},
  temporal:()=>({workflow:{start:async(name,options)=>{started.push({name,options})}}})
 });
 try{
  const response=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/tasks/'+task+'/quality-gates',payload:{}});
  assert.equal(response.statusCode,202,JSON.stringify(response.json()));
  assert.equal(response.json().status,'queued');
  assert.equal(started.length,1);
  assert.equal(started[0].name,'manualQualityGates');
  assert.equal(started[0].options.taskQueue,'agent-pipeline');
  assert.equal(started[0].options.args[0].projectId,project);
  assert.equal(started[0].options.args[0].taskId,task);
 }finally{await f.app.close();}
});

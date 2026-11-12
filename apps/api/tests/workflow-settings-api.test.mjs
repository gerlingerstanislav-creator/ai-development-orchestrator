import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {z} from 'zod';
import {registerWorkflowSettingsRoutes} from '../dist/modules/projects/workflow-api.js';
import {validStages,validMode} from '../dist/modules/projects/domain/workflow-stages.js';

const project='123e4567-e89b-42d3-a456-426614174000';
const task='123e4567-e89b-42d3-a456-426614174001';
const path='/api/projects/'+project;
function fixture({member=true,admin=true,handler}={}){
 const statements=[],transactions=[];
 const query=async(sql,args)=>{
  statements.push({sql,args});
  if(handler)return handler(sql,args);
  if(sql.includes('SELECT stage,label,mode,position'))return {rows:[{
   stage:'analysis',label:'Анализ',mode:'approval',position:1,agent_name:'Analyst',agent_instructions:'...',description:''
  }],rowCount:1};
  if(sql.includes('SELECT mode,health_url,environment'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:0};
 };
 const db={query,connect:async()=>({
  query:async(sql,args)=>{
   transactions.push({sql,args});
   if(handler)return handler(sql,args);
   return {rows:[],rowCount:0};
  },
  release:()=>{transactions.push({sql:'RELEASE'})}
 })};
 const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>{
  if(error instanceof z.ZodError)return reply.code(400).send({error:'Validation error'});
  const status=typeof error.statusCode==='number'?error.statusCode:500;
  return reply.code(status).send({error:error.message});
 });
 registerWorkflowSettingsRoutes(app,{
  pool:db,uid:()=> 'owner-1',
  access:async(_req,reply)=>{
   if(!member){reply.code(403).send({error:'Access denied'});return false;}
   return true;
  },
  requireAdmin:async(_req,reply)=>{
   if(!admin){reply.code(403).send({error:'Owner approval required'});return false;}
   return true;
  }
 });
 return {app,statements,transactions};
}
test('workflow domain validators accept known stages and reject invalid stages',()=>{
 assert.equal(validStages.parse('development'),'development');
 assert.equal(validMode.parse('automatic'),'automatic');
 assert.throws(()=>validStages.parse('unknown'));
 assert.throws(()=>validMode.parse('blocked'));
});
test('workflow queries preserve project-scoped responsibility data',async()=>{
 const f=fixture();
 try{
  const response=await f.app.inject({url:path+'/workflow'});
  assert.equal(response.statusCode,200);
  assert.equal(response.json()[0].stage,'analysis');
  assert.ok('responsibility' in response.json()[0]);
  assert.deepEqual(f.statements[0].args,[project]);
  const deployment=await f.app.inject({url:path+'/deployment/settings'});
  assert.deepEqual(deployment.json(),{mode:'skip'});
 }finally{await f.app.close();}
});
test('workflow changes and deployment settings require project access and admin rights',async()=>{
 const outsider=fixture({member:false});
 try{
  for(const suffix of ['/workflow','/specialist-agents/devops','/deployment/settings']){
   assert.equal((await outsider.app.inject({url:path+suffix})).statusCode,403);
  }
  assert.equal(outsider.statements.length,0);
 }finally{await outsider.app.close();}
 const readonly=fixture({admin:false});
 try{
  for(const [method,url,payload] of [
   ['PATCH',path+'/workflow/analysis',{mode:'manual'}],
   ['PUT',path+'/specialist-agents/devops',{agent_name:'Ops',agent_instructions:'Instructions'}],
   ['PUT',path+'/deployment/settings',{mode:'skip',health_url:'',environment:'production'}],
   ['POST',path+'/tasks/'+task+'/deployment/resolve',{outcome:'skipped',reason:'Owner decided to skip deployment'}]
  ]){
   const response=await readonly.app.inject({method,url,payload});
   assert.equal(response.statusCode,403,url);
  }
  assert.equal(readonly.statements.length,0);
  assert.equal(readonly.transactions.length,0);
 }finally{await readonly.app.close();}
});
test('deployment URL validation blocks internal hosts, requires HTTPS for automatic mode',async()=>{
 const f=fixture();
 try{
  const url=path+'/deployment/settings';
  for(const payload of [
   {mode:'automatic',environment:'production'},
   {mode:'manual',health_url:'http://public.example.com/health',environment:'production'},
   {mode:'manual',health_url:'https://localhost/status',environment:'production'}
  ]){
   const response=await f.app.inject({method:'PUT',url,payload});
   assert.equal(response.statusCode,400);
  }
  assert.equal(f.statements.length,0);
  const response=await f.app.inject({method:'PUT',url,
   payload:{mode:'automatic',health_url:'https://example.com/health',environment:'staging'}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(f.statements.at(-1).args,
   [project,'automatic','https://example.com/health','staging']);
 }finally{await f.app.close();}
});
test('workflow deployment agent settings are synchronized within one transaction',async()=>{
 const workflow={
  stage:'deployment',label:'Выкладка',mode:'manual',position:5,
  agent_name:'DevOps specialist',agent_instructions:'CI and deployment',description:'Deployment'
 };
 const f=fixture({handler:async sql=>{
  if(sql.startsWith('UPDATE workflow_stages SET'))return {rows:[workflow],rowCount:1};
  return {rows:[],rowCount:1};
 }});
 try{
  const response=await f.app.inject({method:'PATCH',url:path+'/workflow/deployment',
   payload:{agent_name:workflow.agent_name,agent_instructions:workflow.agent_instructions}});
  assert.equal(response.statusCode,200,JSON.stringify(response.json()));
  assert.equal(response.json().agent_name,workflow.agent_name);
  assert.equal(f.transactions[0].sql,'BEGIN');
  assert.match(f.transactions[1].sql,/UPDATE workflow_stages/);
  assert.match(f.transactions[2].sql,/INSERT INTO project_specialist_agents/);
  assert.equal(f.transactions[3].sql,'COMMIT');
  assert.equal(f.transactions.at(-1).sql,'RELEASE');
 }finally{await f.app.close();}
});
test('manual deployment resolution is atomic and writes task transition and audit event',async()=>{
 const f=fixture({handler:async sql=>{
  if(sql.startsWith('SELECT stage FROM tasks'))return {rows:[{stage:'deployment'}],rowCount:1};
  if(sql.startsWith('UPDATE task_deployment_records'))return {rows:[{task_id:task}],rowCount:1};
  return {rows:[],rowCount:1};
 }});
 try{
  const response=await f.app.inject({method:'POST',url:path+'/tasks/'+task+'/deployment/resolve',
   payload:{outcome:'manual_confirmed',reason:'Owner verified environment manually'}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),{stage:'documentation',deployment_status:'manual_confirmed'});
  const statements=f.transactions.map(x=>x.sql);
  assert.equal(statements[0],'BEGIN');
  assert.ok(statements.some(x=>x.includes("UPDATE tasks SET stage='documentation'")));
  assert.ok(statements.some(x=>x.includes('INSERT INTO task_events')));
  assert.equal(statements.at(-2),'COMMIT');
 }finally{await f.app.close();}
});
test('deployment cannot be confirmed if a task is no longer in the deployment stage',async()=>{
 const f=fixture({handler:async sql=>{
  if(sql.startsWith('SELECT stage FROM tasks'))return {rows:[{stage:'testing'}],rowCount:1};
  return {rows:[],rowCount:0};
 }});
 try{
  const res=await f.app.inject({method:'POST',url:path+'/tasks/'+task+'/deployment/resolve',
   payload:{outcome:'skipped',reason:'Owner approved alternative'}});
  assert.equal(res.statusCode,409);
  assert.ok(f.transactions.some(x=>x.sql==='ROLLBACK'));
  assert.equal(f.transactions.some(x=>x.sql.includes('UPDATE tasks')),false);
 }finally{await f.app.close();}
});

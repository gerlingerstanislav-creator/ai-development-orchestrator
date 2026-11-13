import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerProjectCoreRoutes} from '../dist/modules/projects/api.js';
import {workflowDefaults,workflowStageDescriptions} from '../dist/modules/projects/domain/workflow-defaults.js';

const project='123e4567-e89b-42d3-a456-426614174000';
const user='123e4567-e89b-42d3-a456-426614174001';
const projectData={id:project,name:'Coffee project',owner_id:user,deleted_at:null};

function fixture({onQuery=async()=>({rows:[],rowCount:0}),allowed=true,admin=true}={}){
 const statements=[];
 const query=async(sql,args)=>{
  statements.push({sql,args});
  return onQuery(sql,args);
 };
 let released=0;
 const pool={query,connect:async()=>({query,release:()=>released++})};
 const app=Fastify();
 registerProjectCoreRoutes(app,{pool,uid:()=>user,access:async(_req,reply)=>{
  if(!allowed){reply.code(403).send({error:'No access'});return false;}
  return true;
 },requireAdmin:async(_req,reply)=>{
  if(!admin){reply.code(403).send({error:'Admin only'});return false;}
  return true;
 }});
 return {app,statements,released:()=>released};
}

test('shared workflow defaults keep eight ordered stages and their existing policies',()=>{
 assert.deepEqual(workflowDefaults.map(x=>x[0]),
  ['backlog','analysis','development','testing','merge_queue','deployment','documentation','done']);
 assert.equal(workflowStageDescriptions.testing.includes('QA'),true);
});

test('new project is provisioned atomically with membership, stages and agents',async()=>{
 const f=fixture();
 try{
  const res=await f.app.inject({method:'POST',url:'/api/projects',
   payload:{name:' Coffee ',description:'A coffee app'}});
  assert.equal(res.statusCode,201,JSON.stringify(res.json()));
  const id=res.json().id;
  assert.match(id,/^[0-9a-f-]{36}$/);
  assert.equal(res.json().name,'Coffee');
  const statements=f.statements;
  assert.equal(statements[0].sql,'BEGIN');
  assert.equal(statements.at(-1).sql,'COMMIT');
  assert.equal(statements.filter(s=>s.sql.includes('INSERT INTO workflow_stages')).length,8);
  assert.ok(statements.some(s=>s.sql.includes('INSERT INTO memberships')&&s.args[0]===id&&s.args[1]===user));
  assert.ok(statements.some(s=>s.sql.includes('INSERT INTO project_specialist_agents')));
  assert.ok(statements.some(s=>s.sql.includes('INSERT INTO project_conversation_agents')));
  assert.ok(statements.some(s=>s.sql.includes('INSERT INTO project_deployment_settings')));
  assert.equal(f.released(),1);
 }finally{await f.app.close();}
});

test('project listing remains membership filtered and excludes deleted projects',async()=>{
 const f=fixture({onQuery:async sql=>{
  assert.match(sql,/JOIN memberships/);
  assert.match(sql,/p.deleted_at IS NULL/);
  return {rows:[{id:project,name:'Coffee project'}],rowCount:1};
 }});
 try{
  const res=await f.app.inject({url:'/api/projects'});
  assert.equal(res.statusCode,200);
  assert.equal(res.json()[0].id,project);
  assert.deepEqual(f.statements[0].args,[user]);
 }finally{await f.app.close();}
});

test('soft deletion refuses projects with active processing and rolls back',async()=>{
 const f=fixture({onQuery:async sql=>{
  if(sql.includes('SELECT id,name,owner_id,deleted_at FROM projects'))return {rows:[projectData],rowCount:1};
  if(sql.includes('FROM ai_task_runs WHERE project_id'))return {rows:[{one:1}],rowCount:1};
  return {rows:[],rowCount:0};
 }});
 try{
  const res=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/trash'});
  assert.equal(res.statusCode,409);
  assert.equal(f.statements[0].sql,'BEGIN');
  assert.equal(f.statements.at(-1).sql,'ROLLBACK');
  assert.equal(f.statements.some(s=>s.sql.includes('UPDATE projects SET deleted_at=now()')),false);
  assert.equal(f.released(),1);
 }finally{await f.app.close();}
});

test('permanent deletion requires exact confirmation and never deletes GitHub data',async()=>{
 const f=fixture({onQuery:async sql=>{
  if(sql.includes('SELECT id,name,owner_id,deleted_at FROM projects'))
   return {rows:[{...projectData,deleted_at:new Date().toISOString()}],rowCount:1};
  return {rows:[],rowCount:0};
 }});
 try{
  const rejected=await f.app.inject({method:'DELETE',url:'/api/projects/'+project+'/permanent',
   payload:{confirmation:'wrong'}});
  assert.equal(rejected.statusCode,400);
  assert.equal(f.statements.some(s=>s.sql.includes('DELETE FROM projects')),false);
  const removed=await f.app.inject({method:'DELETE',url:'/api/projects/'+project+'/permanent',
   payload:{confirmation:'Coffee project'}});
  assert.equal(removed.statusCode,200);
  assert.deepEqual(removed.json(),{deleted:true,project_id:project,github_untouched:true});
  assert.ok(f.statements.some(s=>s.sql.includes('DELETE FROM projects WHERE id=$1')));
  assert.equal(f.statements.some(s=>s.sql.includes('DELETE FROM connections')),false,'Personal credentials must survive project deletion');
  assert.equal(f.statements.filter(s=>s.sql==='COMMIT').length,1);
  assert.equal(f.statements.filter(s=>s.sql==='ROLLBACK').length,1);
 }finally{await f.app.close();}
});

test('project specialist pause control requires both membership and admin rights',async()=>{
 const f=fixture({admin:false});
 try{
  const res=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/agents/state',
   payload:{running:true}});
  assert.equal(res.statusCode,403);
  assert.equal(f.statements.length,0);
 }finally{await f.app.close();}
});

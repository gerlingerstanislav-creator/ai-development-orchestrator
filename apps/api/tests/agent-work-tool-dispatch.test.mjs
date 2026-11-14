import test from 'node:test';
import assert from 'node:assert/strict';
import {executeAgentWorkTool,isAgentWorkTool} from '../dist/modules/agents/infrastructure/agent-work-tools.js';

const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const other='00000000-0000-4000-8000-000000000003';
const assignment='00000000-0000-4000-8000-000000000004';
const manager={project_id:projectId,actor_id:'actor',role:'manager',id:'session'};
const specialist={...manager,role:'testing',task_id:taskId,process_id:assignment};
const attempt=async(db,session,name,params)=>executeAgentWorkTool(db,session,name,params);
const never={query:async()=>{throw Error('Unauthorized query');}};
test('only the explicit work tool catalog delegates to the work service',async()=>{
 for(const name of ['work.artifacts','work.list','work.plan','work.delegate','work.report','work.review','work.grant'])
  assert.equal(isAgentWorkTool(name),true,name);
 for(const name of ['agents.consult','work.other','documents.update','pm.orders.watch_task'])
  assert.equal(isAgentWorkTool(name),false,name);
 await assert.rejects(attempt(never,manager,'work.other',{}),error=>error.statusCode===404);
});
test('a specialist cannot read artifacts or work items of another task',async()=>{
 await assert.rejects(attempt(never,specialist,'work.artifacts',{task_id:other}),error=>error.statusCode===403);
 await assert.rejects(attempt(never,specialist,'work.list',{task_id:other}),error=>error.statusCode===403);
});
test('artifact reader rejects unowned task before any work artifacts query',async()=>{
 const calls=[];
 const db={query:async(sql,params)=>{
  calls.push({sql,params});return {rows:[],rowCount:0};
 }};
 await assert.rejects(attempt(db,manager,'work.artifacts',{task_id:taskId}),error=>error.statusCode===404);
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].params,[taskId,projectId]);
});
test('work planning is limited to manager/analyst and its own task',async()=>{
 const step={key:'review',role:'testing',objective:'Review all required behavior',
  acceptance:'Prove each test with actual execution',needs:[],tools:[]};
 const params={task_id:taskId,steps:[step]};
 await assert.rejects(attempt(never,specialist,'work.plan',params),error=>error.statusCode===403);
 await assert.rejects(attempt(never,{...manager,task_id:other},'work.plan',params),error=>error.statusCode===403);
});
test('delegation requires an active specialist assignment or another live task run',async()=>{
 const payload={task_id:taskId,role:'development',objective:'Fix the verified defects',
  acceptance:'Changes verified by independent QA'};
 const calls=[];
 const db={query:async(sql,params=[])=>{
  calls.push({sql,params});
  if(sql.includes('SELECT id FROM agent_work_assignments'))return {rowCount:0,rows:[]};
  if(sql.includes('SELECT note_id AS id'))return {rowCount:0,rows:[]};
  throw Error('Unexpected write: '+sql);
 }};
 await assert.rejects(attempt(db,specialist,'work.delegate',payload),error=>error.statusCode===403);
 assert.equal(calls.length,2);
 assert.deepEqual(calls[0].params,[assignment,projectId,taskId,'testing',null]);
 assert.deepEqual(calls[1].params,[assignment,projectId,taskId,'testing']);
});
test('live peer specialist can delegate in same task and cannot create unauthorized grants',async()=>{
 const payload={task_id:taskId,role:'development',objective:'Fix the verified defects',
  acceptance:'Changes verified by independent QA'};
 const statements=[];
 const db={query:async(sql,params=[])=>{
  statements.push({sql,params});
  if(sql.includes('SELECT id FROM agent_work_assignments'))return {rowCount:0,rows:[]};
  if(sql.includes('SELECT note_id AS id'))return {rowCount:1,rows:[{id:assignment}]};
  if(sql.includes('SELECT id,stage,spec_version FROM tasks'))return {rowCount:1,rows:[{id:taskId,stage:'testing',spec_version:3}]};
  if(sql.includes('count(*)::int AS n'))return {rowCount:1,rows:[{n:0}]};
  if(sql.includes('SELECT id,status,granted_tools FROM agent_work_assignments'))
   return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[]};
 }};
 const result=await attempt(db,specialist,'work.delegate',payload);
 assert.equal(result.status,'queued');
 assert.equal(result.role,'development');
 assert.ok(statements.some(x=>x.sql.startsWith('INSERT INTO agent_work_assignments')));
 assert.equal(statements.filter(x=>/UPDATE tasks SET stage|INSERT INTO ai_task_runs/.test(x.sql)).length,0);
 await assert.rejects(attempt(db,specialist,'work.delegate',{...payload,tools:['documents.update']}),error=>error.statusCode===403);
});
test('work.report requires the exact active task-bound process',async()=>{
 await assert.rejects(attempt(never,manager,'work.report',{
  status:'submitted',result:'Everything was executed successfully',evidence:'Proven with test artifact'
 }),error=>error.statusCode===403);
 const calls=[];
 const db={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:0,rows:[]};}};
 await assert.rejects(attempt(db,specialist,'work.report',{
  status:'submitted',result:'All scenarios were executed successfully',
  evidence:'An external test report exists'
 }),/не активно/);
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].params.slice(0,4),[assignment,projectId,taskId,'testing']);
 assert.deepEqual(calls[0].params.slice(4),['submitted','All scenarios were executed successfully','An external test report exists']);
});
test('only project manager can review or grant, without bypassing QA or stage changes',async()=>{
 await assert.rejects(attempt(never,specialist,'work.review',{
  assignment_id:assignment,action:'accept',reason:'Evidence is complete and verified'
 }),error=>error.statusCode===403);
 await assert.rejects(attempt(never,specialist,'work.grant',{
  assignment_id:assignment,tools:['documents.update'],reason:'Approved by product owner'
 }),error=>error.statusCode===403);
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('SELECT a.*,COALESCE(t.spec_version'))return {rowCount:1,rows:[{
   id:assignment,task_id:taskId,status:'submitted',evidence:'',
   spec_version:4,actual_version:4
  }]};
  return {rowCount:0,rows:[]};
 }};
 await assert.rejects(attempt(db,manager,'work.review',{
  assignment_id:assignment,action:'accept',reason:'Evidence was examined and accepted'
 }),/Нельзя принять/);
 assert.equal(calls.filter(x=>x.sql.includes('UPDATE tasks SET stage')).length,0);
});

test('goal screenshot reader enforces a single scope and the active specialist assignment',async()=>{
 const goalId='00000000-0000-4000-8000-000000000006';
 const goalSpecialist={...specialist,task_id:null};
 await assert.rejects(attempt(never,manager,'work.artifacts',{task_id:taskId,goal_id:goalId}),error=>error.statusCode===400);
 await assert.rejects(attempt(never,manager,'work.artifacts',{}),error=>error.statusCode===400);
 const denied=[];
 const noAssignedGoal={query:async(sql,args)=>{
  denied.push({sql,args});
  return {rowCount:0,rows:[]};
 }};
 await assert.rejects(attempt(noAssignedGoal,goalSpecialist,'work.artifacts',{goal_id:goalId}),error=>error.statusCode===403);
 assert.equal(denied.length,1);
 assert.match(denied[0].sql,/FROM agent_work_assignments/);
 assert.deepEqual(denied[0].args,[assignment,projectId,goalId,'testing']);
 const calls=[];
 const ownGoal={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('FROM agent_work_artifacts'))return {rowCount:1,rows:[{
   id:'00000000-0000-4000-8000-000000000007',
   source_sha:'a'.repeat(40),sha256:'b'.repeat(64)
  }]};
  return {rowCount:1,rows:[{id:goalId}]};
 }};
 const result=await attempt(ownGoal,goalSpecialist,'work.artifacts',{goal_id:goalId});
 assert.equal(calls.length,3);
 assert.deepEqual(calls[1].args,[goalId,projectId]);
 assert.deepEqual(calls[2].args,[projectId,goalId]);
 assert.equal(result.artifacts[0].url,
  '/api/projects/'+projectId+'/goals/'+goalId+'/work-artifacts/00000000-0000-4000-8000-000000000007');
 await assert.rejects(attempt(never,specialist,'work.artifacts',{goal_id:goalId}),error=>error.statusCode===403);
});

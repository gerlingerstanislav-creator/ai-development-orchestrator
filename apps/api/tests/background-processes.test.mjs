import test from 'node:test';
import assert from 'node:assert/strict';
import {listBackgroundProcesses} from '../dist/modules/processes/application/background-processes.js';

test('process center reads are scoped to the user and never write task or job state',async()=>{
 const queries=[];
 const development={
  id:'dev-1',project_id:'project-1',project_name:'Coffee',task_id:'task-1',
  task_title:'Checkout',display_number:12,status:'running',
  message:'Codex изменяет код',created_at:'2026-11-12T10:00:00Z',cycle_id:null
 };
 const pool={query:async(sql,args)=>{
  queries.push({sql,args});
  return {rows:sql.includes('FROM ai_task_runs a')?[development]:[]};
 }};
 const output=await listBackgroundProcesses(pool,'member-1');
 assert.equal(output.count,1);
 assert.deepEqual(output.processes[0],{
  id:'development:dev-1',kind:'development',role:'development',
  projectId:'project-1',projectName:'Coffee',taskId:'task-1',
  title:'Разработка #12 · Checkout',detail:'Изменяет код',
  status:'running',createdAt:'2026-11-12T10:00:00Z',
  url:'/projects/project-1/processes?process=dev-1'
 });
 assert.equal(queries.length,8);
 for(const {sql,args} of queries){
  assert.match(sql.trim(),/^SELECT /i);
  assert.match(sql,/m\.user_id=\$1/);
  assert.deepEqual(args,['member-1']);
 }
 assert.ok(Number.isFinite(Date.parse(output.checkedAt)));
});
test('process center does not trust unfiltered global process rows',async()=>{
 const pool={query:async(sql,args)=>{
  assert.ok(args?.[0]==='member-2');
  assert.match(sql,/JOIN memberships/);
  return {rows:[]};
 }};
 assert.deepEqual((await listBackgroundProcesses(pool,'member-2')).processes,[]);
});

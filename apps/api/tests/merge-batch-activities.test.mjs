import test from 'node:test';
import assert from 'node:assert/strict';
import {createMergeBatchActivities} from '../dist/modules/integrations/github/application/merge-batch-activities.js';

const batch={project_id:'project',actor_id:'actor',task_ids:['taskA','taskB'],results:[{taskId:'taskA',status:'merged'}]};
function harness(mergeTaskPr=async()=>{},runner=async()=>({status:'running'}),dbExtra=async()=>({rows:[],rowCount:0})){
 const commands=[];
 const pool={query:async(sql,params=[])=>{
  commands.push({sql,params});
  if(sql.includes('SELECT project_id,actor_id,task_ids,results FROM merge_process_runs'))return {rows:[batch],rowCount:1};
  return dbExtra(sql,params);
 }};
 const service=createMergeBatchActivities({pool,decrypt:()=>'<token>',runner,dispatch:async()=>true,mergeTaskPr});
 return {service,commands};
}
test('merge batch skips tasks outside immutable batch and computes pending only from saved results',async()=>{
 const {service,commands}=harness();
 assert.deepEqual(await service.pendingMergeTasks('batch'),['taskB']);
 assert.deepEqual(await service.tryMergeBatchTask('batch','taskZ'),{status:'skipped',reason:'Задача отсутствует в очереди'});
 assert.equal(commands.filter(x=>x.sql.includes('UPDATE merge_process_runs')).length,0);
});
test('merge provider conflicts and eventual consistency remain distinct from transient errors',async()=>{
 for(const [message,expected] of [
  ['merge conflicts on branch','conflict'],
  ['GitHub ещё вычисляет mergeability','pending'],
  ['Forbidden to merge','skipped']
 ]){
  const {service}=harness(async()=>{throw Object.assign(Error(message),{statusCode:409});});
  const result=await service.tryMergeBatchTask('batch','taskB');
  assert.equal(result.status,expected);
  assert.equal(result.reason,message);
 }
 const {service}=harness(async()=>{throw Object.assign(Error('GitHub 503'),{statusCode:503});});
 await assert.rejects(service.tryMergeBatchTask('batch','taskB'),/GitHub 503/);
});
test('conflict polling accepts durable Runner checkpoint without redeploying duplicate job',async()=>{
 let polls=0;
 const {service,commands}=harness(async()=>{},async path=>{polls++;assert.match(path,/^\/jobs\//);return {status:'completed',message:'PR resolved'};});
 assert.deepEqual(await service.pollMergeConflict('batch','taskB',1),{status:'completed',message:'PR resolved'});
 assert.equal(polls,1);
 assert.equal(commands.filter(x=>x.sql.includes('SELECT t.title')).length,0);
});
test('Runner temporary outage leaves conflict process recoverable; terminal 409 stays terminal',async()=>{
 const temporary=harness(async()=>{},async()=>{throw Object.assign(Error('bad gateway'),{statusCode:502});});
 assert.deepEqual(await temporary.service.pollMergeConflict('batch','taskB',2),{status:'running',message:'Ожидается восстановление связи с Codex Runner'});
 const forbidden=harness(async()=>{},async()=>{throw Object.assign(Error('not authorized'),{statusCode:403});});
 await assert.rejects(forbidden.service.pollMergeConflict('batch','taskB',2),/not authorized/);
});

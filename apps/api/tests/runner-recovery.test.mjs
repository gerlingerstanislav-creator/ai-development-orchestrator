import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunnerRecovery,runnerUnavailable} from '../dist/modules/execution/application/runner-recovery.js';

function fixture(rowCount=1){
 const queries=[],events=[];
 const db={query:async(sql,args)=>{queries.push({sql,args});return {rowCount}}};
 const recordEvent=async(...args)=>events.push(args);
 return {...createRunnerRecovery(db,recordEvent),queries,events};
}
test('runner HTTP 4xx remains a terminal error, while 5xx is transient',()=>{
 const invalid=Object.assign(new Error('job not found'),{statusCode:404});
 assert.throws(()=>runnerUnavailable(invalid),error=>error===invalid);
 const conflict=Object.assign(new Error('job busy'),{statusCode:409});
 assert.throws(()=>runnerUnavailable(conflict),error=>error===conflict);
 assert.deepEqual(runnerUnavailable(Object.assign(new Error('unavailable'),{statusCode:503})),
  {status:'running',message:'Ожидается восстановление связи с Codex Runner'});
});
test('4xx job failures update the correct development table and persist a failure event',async()=>{
 const f=fixture();
 const error=Object.assign(new Error('Runner rejected the job'),{statusCode:404});
 assert.deepEqual(await f.trackRunnerWait('development','project-1','run-1',error),
  {status:'failed',message:error.message});
 assert.match(f.queries[0].sql,/UPDATE ai_task_runs SET status='failed'/);
 assert.deepEqual(f.queries[0].args,['run-1',error.message]);
 assert.deepEqual(f.events[0],['project-1','run-1','development','failed',error.message,'error']);
});
test('5xx and connection failures preserve the running state and deduplicate process events',async()=>{
 const f=fixture();
 const fail=Object.assign(new Error('temporary'),{statusCode:502});
 const result=await f.trackRunnerWait('testing','project-2','run-2',fail);
 assert.equal(result.status,'running');
 assert.equal(result.message,'Ожидается восстановление связи с Codex Runner');
 assert.match(f.queries[0].sql,/UPDATE ai_test_runs SET message=\$2/);
 assert.deepEqual(f.events[0],['project-2','run-2','testing','runner_recovery',result.message]);
 const quiet=fixture(0);
 assert.equal((await quiet.trackRunnerWait('testing','project-2','run-2',fail)).status,'running');
 assert.equal(quiet.events.length,0);
});
test('recovery checkpoint messages are truncated and do not mark the process complete',async()=>{
 const f=fixture();
 const result=await f.trackRunnerWait('development','project-3','run-3',undefined,'a'.repeat(2000));
 assert.equal(result.status,'running');
 assert.equal(result.message.length,1200);
 assert.equal(f.queries.length,1);
 assert.equal(f.events.length,1);
 assert.match(f.queries[0].sql,/status IN \('queued','running'\)/);
});
test('explicit failed testing run preserves error-level history',async()=>{
 const f=fixture();
 assert.deepEqual(await f.failRunnerRun('testing','project-4','run-4','QA failed'),
  {status:'failed',message:'QA failed'});
 assert.match(f.queries[0].sql,/UPDATE ai_test_runs SET status='failed'/);
 assert.deepEqual(f.events[0],['project-4','run-4','testing','failed','QA failed','error']);
});

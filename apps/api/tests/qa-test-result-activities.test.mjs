import test from 'node:test';
import assert from 'node:assert/strict';
import {createQaTestResultActivities} from '../dist/modules/quality/infrastructure/qa-test-result-activities.js';

const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const testId='00000000-0000-4000-8000-000000000003';
const run={projectId,taskId,testId};

function harness({row,remote={status:'running',message:'QA progressing'},runnerError,
 currentSpec={spec_version:3,spec_review_status:'current',spec_reviewed_version:3,
  spec_reviewed_commit:'a'.repeat(40),execution_mode:'code'},taskUpdated=true}={}){
 const calls={runner:[],recover:[],fail:[],start:[],events:[],learning:[],notes:[],sql:[],tx:[],inbox:[]};
 const client={query:async(sql,args=[])=>{
  calls.tx.push({sql,args});
  if(sql.includes('UPDATE tasks SET stage='))return {rowCount:taskUpdated?1:0,rows:[]};
  return {rowCount:1,rows:[]};
 },release:()=>{}};
 const pool={
  query:async(sql,args=[])=>{
   calls.sql.push({sql,args});
   if(sql.includes('FROM ai_test_runs WHERE id=$1 AND project_id=$2 AND task_id=$3'))return {rowCount:row?1:0,rows:row?[row]:[]};
   if(sql.includes('FROM ai_test_runs WHERE id=$1 AND project_id=$2'))return {rowCount:row?1:0,rows:row?[row]:[]};
   if(sql.startsWith('SELECT verdict FROM ai_test_runs'))return {rowCount:1,rows:[{verdict:row?.verdict}]};
   if(sql.includes('FROM tasks WHERE id=$1 AND project_id=$2'))return {rowCount:1,rows:[currentSpec]};
   throw Error('Unexpected SQL: '+sql);
  },
  connect:async()=>client
 };
 const qa=createQaTestResultActivities({
  pool,
  runner:async path=>{calls.runner.push(path);if(runnerError)throw runnerError;return remote;},
  trackRunnerWait:async(...args)=>{calls.recover.push(args);return {status:'running',message:'Waiting for Runner recovery'};},
  failRunnerRun:async(...args)=>{calls.fail.push(args);return {status:'failed',message:args[3]};},
  startTesting:async args=>{calls.start.push(args);return testId;},
  recordLearning:async entry=>{calls.learning.push(entry);},
  recordNote:async note=>{calls.notes.push(note);return true;},
  event:async(...args)=>{calls.events.push(args);},
  syncManagerInbox:async(...args)=>{calls.inbox.push(args);}
 });
 return {qa,calls};
}

test('QA activity refuses nonexistent runs without contacting Runner',async()=>{
 const {qa,calls}=harness();
 await assert.rejects(qa.checkTesting(run),/Запуск тестирования не найден/);
 assert.equal(calls.runner.length,0);
});

test('cancelled and previously finished tests return stored facts without re-execution',async()=>{
 for(const state of ['cancelled','completed']){
  const {qa,calls}=harness({row:{status:state,message:'Stored QA',verdict:'blocked'}});
  const result=await qa.checkTesting(run);
  assert.equal(result.status,state==='cancelled'?'failed':'completed');
  assert.equal(calls.runner.length,0);
  assert.equal(calls.start.length,0);
 }
});

test('Runner outage waits without converting a transient error into failed QA',async()=>{
 const unavailable=Object.assign(Error('Runner HTTP 503'),{statusCode:503});
 const {qa,calls}=harness({row:{status:'running'},runnerError:unavailable});
 const result=await qa.checkTesting(run);
 assert.equal(result.status,'running');
 assert.deepEqual(calls.recover[0],['testing',projectId,testId,unavailable]);
 assert.equal(calls.fail.length,0);
 assert.equal(calls.events.length,0);
});

test('interrupted QA resumes same attempt and cycle instead of creating a new execution',async()=>{
 const {qa,calls}=harness({row:{status:'running',task_id:taskId,cycle_id:'cycle',attempt:2,
   qa_plan_snapshot:{simplified:true}},remote:{status:'interrupted',message:'Runner restarted'}});
 const result=await qa.checkTesting(run);
 assert.equal(result.status,'running');
 assert.deepEqual(calls.start,[{projectId,taskId,cycleId:'cycle',attempt:2,recovery:true,simplified:true}]);
 assert.equal(calls.recover.length,1);
 assert.equal(calls.fail.length,0);
});

test('a single-pass QA run without execution proof fails rather than passing a fabricated test',async()=>{
 const {qa,calls}=harness({row:{status:'running',qa_plan_snapshot:{singlePass:true}},
  remote:{status:'completed',message:'Done',executionVerified:false}});
 const result=await qa.checkTesting(run);
 assert.equal(result.status,'failed');
 assert.match(result.message,/не подтвердил исполнение проверок/);
 assert.equal(calls.fail.length,1);
 assert.equal(calls.tx.length,0);
});

test('blocked QA does not route the task back to development or lose prior test evidence',async()=>{
 const row={
  status:'completed',verdict:'blocked',
  report:{summary:'Visual tool unavailable',caseResults:[
   {case_id:'qa-1',result:'passed',evidence:'Observed behavior'},
   {case_id:'qa-2',result:'blocked',reason:'tool_unavailable'}
  ]},
  qa_plan_snapshot:{cases:[{id:'qa-1',title:'Working flow'},{id:'qa-2',title:'Browser check'}]}
 };
 const {qa,calls}=harness({row});
 await qa.noteBlockedTests(run);
 assert.equal(calls.inbox.length,1);
 assert.ok(calls.tx.some(x=>x.sql.includes("UPDATE tasks SET stage=$4")));
 const update=calls.tx.find(x=>x.sql.includes("UPDATE tasks SET stage=$4"));
 assert.deepEqual(update.args[3],'testing');
 assert.ok(calls.tx.some(x=>x.sql.includes('INSERT INTO task_events')));
 assert.ok(calls.tx.some(x=>x.sql.includes('INSERT INTO process_events')));
 assert.ok(calls.tx.some(x=>x.sql==='COMMIT'));
});

test('simplified blocked QA records the limitation without notifying the legacy task manager',async()=>{
 const row={status:'completed',verdict:'blocked',report:{summary:'Missing test environment'},
   qa_plan_snapshot:{cases:[]}};
 const {qa,calls}=harness({row});
 await qa.noteBlockedTests({...run,simplified:true});
 assert.equal(calls.inbox.length,0);
 assert.ok(calls.tx.some(x=>x.sql==='COMMIT'));
});

test('unblocked or unfinished QA cannot issue a manual QA approval record',async()=>{
 for(const row of [{status:'running',verdict:'blocked'},{status:'completed',verdict:'passed'},undefined]){
  const {qa,calls}=harness({row});
  await assert.rejects(qa.noteBlockedTests(run),/Нельзя согласовать/);
  assert.equal(calls.tx.length,0);
  assert.equal(calls.inbox.length,0);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createQaOutcomeActivities} from '../dist/modules/quality/infrastructure/qa-outcome-activities.js';

const projectId='00000000-0000-4000-8000-000000000101';
const taskId='00000000-0000-4000-8000-000000000102';
const testId='00000000-0000-4000-8000-000000000103';
const cycleId='00000000-0000-4000-8000-000000000104';
const sha='a'.repeat(40);
const args={projectId,taskId,testId,simplified:true};
function fixture(query){
 const calls=[],events=[];
 const pool={query:async(sql,values=[])=>{
  calls.push({sql,values});
  return query(sql,values,calls);
 }};
 const gates=createQaOutcomeActivities({
  pool,
  event:async(...info)=>events.push(info),
  jobSettings:async()=>{throw Error('No GitHub lookup required for this test');},
  nonRetryable:message=>Object.assign(Error(message),{nonRetryable:true}),
  http:async()=>{throw Error('No GitHub HTTP request required for this test');}
 });
 return {calls,events,gates};
}
test('a missing or stale independent QA approval cannot advance a task',async()=>{
 const f=fixture(async()=>({rowCount:0,rows:[]}));
 await assert.rejects(f.gates.approveTestedTask(args),error=>error.nonRetryable===true&&/успешного независимого QA/.test(error.message));
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].values,[testId,projectId,taskId]);
 assert.match(f.calls[0].sql,/r.verdict='passed'/);
 assert.equal(f.events.length,0);
});
test('browser evidence is blocked without immutable verified screenshots and SHA',async()=>{
 const f=fixture(async()=>({rowCount:1,rows:[{
  implementation_kind:'artifact',execution_mode:'browser_evidence',
  evidence_source_sha:sha,report:{commit:sha,caseResults:[]}
 }]}));
 await assert.rejects(f.gates.approveTestedTask(args),error=>error.nonRetryable===true&&/артефакты/.test(error.message));
 assert.equal(f.calls.length,1,'Unsafe screenshots must not trigger task transitions');
 assert.equal(f.events.length,0);
});
test('normal PR is enqueued only after passed independent QA and a current testing-stage update',async()=>{
 const f=fixture(async sql=>{
  if(sql.includes('SELECT t.implementation_kind'))return {rowCount:1,rows:[{
   implementation_kind:'pr',execution_mode:'code',report:{commit:sha}
  }]};
  if(sql.includes("UPDATE tasks SET stage='merge_queue'"))return {rowCount:1,rows:[{id:taskId}]};
  if(sql.includes('INSERT INTO task_events'))return {rowCount:1,rows:[]};
  throw Error('Unexpected SQL: '+sql);
 });
 await f.gates.approveTestedTask(args);
 const transition=f.calls.find(x=>x.sql.includes("stage='merge_queue'"));
 assert.ok(transition);
 assert.deepEqual(transition.values,[taskId,projectId]);
 assert.match(transition.sql,/stage='testing' RETURNING id/);
 assert.equal(f.events.length,1);
 assert.equal(f.events[0][3],'approved');
 assert.ok(f.calls.some(x=>x.sql.includes("'tests_passed'")));
});
test('concurrent task-stage movement cannot create a false QA approved event',async()=>{
 const f=fixture(async sql=>{
  if(sql.includes('SELECT t.implementation_kind'))return {rowCount:1,rows:[{
   implementation_kind:'pr',execution_mode:'code',report:{commit:sha}
  }]};
  if(sql.includes("UPDATE tasks SET stage='merge_queue'"))return {rowCount:0,rows:[]};
  throw Error('Must not write successful audit on outdated stage');
 });
 await assert.rejects(f.gates.approveTestedTask(args),error=>error.nonRetryable===true&&/Задача изменилась/.test(error.message));
 assert.equal(f.events.length,0);
 assert.equal(f.calls.length,2);
});
test('QA failure from a foreign task or nonfailed run cannot reopen development',async()=>{
 const f=fixture(async()=>({rowCount:0,rows:[]}));
 await assert.rejects(f.gates.rejectTestedTask({projectId,taskId,testId,cycleId,attempt:1,allowFix:true}),
  error=>error.nonRetryable===true&&/нет завершённого/i.test(error.message));
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].values,[testId,projectId,taskId]);
 assert.match(f.calls[0].sql,/status='completed' AND verdict='failed'/);
});
test('developer/QA disagreement on same unchanged SHA requires PM, not another Codex attempt',async()=>{
 const f=fixture(async sql=>{
  if(sql.includes('SELECT report FROM ai_test_runs'))return {rowCount:1,rows:[{report:{commit:sha,findings:[{description:'Failure'}]}}]};
  if(sql.includes('SELECT result_kind,result_commit'))return {rowCount:1,rows:[{result_kind:'no_changes_needed',result_commit:sha}]};
  if(sql.startsWith('UPDATE tasks SET stage='))return {rowCount:1,rows:[]};
  if(sql.includes('INSERT INTO task_events'))return {rowCount:1,rows:[]};
  throw Error('Unexpected SQL: '+sql);
 });
 const result=await f.gates.rejectTestedTask({projectId,taskId,testId,cycleId,attempt:1,allowFix:true});
 assert.equal(result,null);
 assert.equal(f.calls.filter(x=>x.sql.includes('INSERT INTO ai_task_runs')).length,0);
 assert.ok(f.calls.some(x=>x.sql.includes("'qa_dev_disagreement'")));
 assert.equal(f.events[0][3],'needs_attention');
});

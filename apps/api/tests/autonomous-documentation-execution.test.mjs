import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceDocumentationAgent,recoverableDocumentAgentError,documentationAgentHistory} from '../dist/autonomous-documentation-execution.js';

test('a timed out Codex step resumes with durable MCP writes instead of failing the import',async()=>{
 const state={status:'running',message:'working'};
 const events=[];
 const stages=[],history=[];
 await advanceDocumentationAgent({
  readState:async()=>({...state}),
  readEvents:async()=>[...events].reverse(),
  runRound:async(step,previous)=>{
   history.push(previous);
   if(step===1){
    events.push({id:'1',tool:'documents.create',success:true,result:{id:'page-1'}});
    throw Error('Агент Codex: codex превысил ограничение времени');
   }
   assert.match(previous,/documents.create/);
   state.status='completed';
   return 'Завершено';
  },
  onProgress:async(stage)=>{stages.push(stage);}
 });
 assert.equal(history.length,2);
 assert.deepEqual(stages,['retrying','verified']);
 assert.equal(state.status,'completed');
});
test('a terminal MCP commit wins even if Codex returns a non-retryable transport error',async()=>{
 let state='running',reports=[];
 await advanceDocumentationAgent({
  readState:async()=>({status:state}),
  readEvents:async()=>[],
  runRound:async()=>{state='completed';throw Error('HTTP 500');},
  onProgress:async(stage)=>{reports.push(stage);}
 });
 assert.deepEqual(reports,['verified']);
});
test('a PM question stops the rounds without treating the agent as failed',async()=>{
 let state='running',calls=0;
 await advanceDocumentationAgent({
  readState:async()=>({status:state,message:'Нужен доступ к репозиторию'}),
  readEvents:async()=>[],
  runRound:async()=>{calls++;state='waiting_input';return 'Вопрос направлен ПМ';},
  onProgress:async(stage,detail)=>{assert.equal(stage,'waiting_input');assert.match(detail,/репозиторию/);}
 });
 assert.equal(calls,1);
});
test('retries from prior sessions include their evidence, with bounded timeouts and no infinite loops',async()=>{
 const events=[{id:'old-1',tool:'project.source',success:true,result:{commit:'abc'}}];
 let calls=0;
 await assert.rejects(advanceDocumentationAgent({
  readState:async()=>({status:'running'}),
  readEvents:async()=>events,
  runRound:async(step,history)=>{
   calls++;
   assert.match(history,/project.source/);
   throw Error('Агент Codex: codex превысил ограничение времени');
  },
  onProgress:async()=>{}
 }),/3 последовательных шага/);
 assert.equal(calls,3);
});
test('permanent errors are not retried, and past results are size bounded',async()=>{
 assert.equal(recoverableDocumentAgentError(Error('Агент Codex: codex превысил ограничение времени')),true);
 assert.equal(recoverableDocumentAgentError(Error('Invalid session token')),false);
 let calls=0;
 await assert.rejects(advanceDocumentationAgent({
  readState:async()=>({status:'running'}),
  readEvents:async()=>[],
  runRound:async()=>{calls++;throw Error('HTTP 403: Forbidden');},
  onProgress:async()=>{}
 }),/403/);
 assert.equal(calls,1);
 assert.ok(documentationAgentHistory(Array.from({length:100},(_,i)=>({id:String(i),tool:'documents.read',success:true,result:{body:'x'.repeat(20000)}}))).length<=5700);
});

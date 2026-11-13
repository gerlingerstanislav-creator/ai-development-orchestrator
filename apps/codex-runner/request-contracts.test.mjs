import test from 'node:test';
import assert from 'node:assert/strict';
import {validAgentRequest,assistantRequestError,runnerJobRequestError} from './request-contracts.mjs';

const validAgent={
 prompt:'Summarize task',model:'gpt-6-luna',reasoning:'low',session_token:'a'.repeat(64)
};
const validJob={
 id:'a'.repeat(36),taskId:'b'.repeat(36),repository:'acme/checkout',
 baseBranch:'main',model:'gpt-6-sol',reasoning:'medium',
 maxRuntimeSeconds:180,token:'token-value'.repeat(4),title:'Implement feature',description:'Requirements'
};

test('agent conversations accept exactly the supported subscription models and bounded prompts',()=>{
 for(const model of ['gpt-6-luna','gpt-6-sol','gpt-6.1-sol']){
  for(const reasoning of ['low','medium']){
   assert.equal(validAgentRequest({...validAgent,model,reasoning}),true);
  }
 }
 assert.equal(validAgentRequest({...validAgent,prompt:'p'.repeat(24000)}),true);
 for(const change of [
  {prompt:''},{prompt:'p'.repeat(24001)},{prompt:null},
  {model:'gpt-7'},{model:'gpt-6'},{reasoning:'high'},
  {session_token:'a'.repeat(63)},{session_token:'G'.repeat(64)},
  {session_token:'a'.repeat(65)},{session_token:undefined}
 ]){
  assert.equal(validAgentRequest({...validAgent,...change}),false,JSON.stringify(change).slice(0,80));
 }
});

test('assistant request validation preserves precise oversize error and existing model restrictions',()=>{
 assert.equal(assistantRequestError({prompt:'Hello',model:'gpt-6.1-sol',reasoning:'medium'}),null);
 assert.equal(assistantRequestError({prompt:'x'.repeat(24000),model:'gpt-6-sol',reasoning:'low'}),null);
 assert.equal(assistantRequestError({prompt:'x'.repeat(24001),model:'gpt-6-sol',reasoning:'low'}),
  'AI-запрос слишком большой: 24001 символов при лимите 24000');
 for(const request of [
  {prompt:''},{prompt:undefined},{prompt:15},{prompt:'okay',model:'nope'},
  {prompt:'okay',reasoning:'high'}
 ]){
  assert.equal(assistantRequestError({...validAgent,...request}),'Некорректные параметры AI-запроса');
 }
 assert.equal(assistantRequestError({...validAgent,model:'unsupported',prompt:'x'.repeat(24001)}),
  'AI-запрос слишком большой: 24001 символов при лимите 24000',
  'oversize error keeps priority even when the model is invalid');
});

test('Runner jobs keep the existing accepted kinds, bounds and basic identity',()=>{
 assert.equal(runnerJobRequestError(validJob),null);
 assert.equal(runnerJobRequestError({...validJob,maxRuntimeSeconds:90}),null);
 assert.equal(runnerJobRequestError({...validJob,maxRuntimeSeconds:7200}),null);
 for(const kind of [undefined,'test','resolve-conflict','review','ci']){
  const input={...validJob,kind,...(['review','ci'].includes(kind)?{expectedCommit:'a'.repeat(40)}:{})};
  assert.equal(runnerJobRequestError(input),null,kind);
 }
 for(const model of ['gpt-6-luna','gpt-6-sol','gpt-6.1-sol'])
  assert.equal(runnerJobRequestError({...validJob,model}),null);
});

test('only test jobs can pin browser evidence checkouts, with matching verified commit',()=>{
 const sha='f'.repeat(40);
 assert.equal(runnerJobRequestError({...validJob,kind:'test',expectedCommit:sha,checkoutCommit:sha}),null);
 assert.equal(runnerJobRequestError({...validJob,kind:'test',expectedCommit:sha,checkoutCommit:'0'.repeat(40)}),'Некорректные параметры задачи');
 assert.equal(runnerJobRequestError({...validJob,kind:'review',expectedCommit:sha,checkoutCommit:sha}),'Некорректные параметры задачи');
 assert.equal(runnerJobRequestError({...validJob,kind:'test',checkoutCommit:'main'}),'Некорректные параметры задачи');
});

test('unsupported kind retains distinct 400 error, not generic malformed job error',()=>{
 assert.equal(runnerJobRequestError({...validJob,kind:'destroy-everything'}),'Недопустимый тип задания');
 assert.equal(runnerJobRequestError({...validJob,kind:'ci',expectedCommit:'wrong'}),'Некорректные параметры задачи');
});

test('Runner rejects malformed job fields and injection-shaped repository/branch strings',()=>{
 const invalid=[
  {id:'wrong'},{id:'A'.repeat(36)},{taskId:'b'.repeat(35)},
  {repository:'../secrets'},{repository:'./repo'},{repository:'org/..'},{repository:'org/.'},
  {repository:'org/repo/extra'},{repository:'org/repo\nAuthorization: attack'},
  {baseBranch:'-bad'},{baseBranch:'bad branch'},{baseBranch:''},
  {branch:'-unsafe'},{branch:'foo bar'},{branch:'foo\nbar'},{branch:'../main'},{branch:'feature/../main'},
  {baseBranch:'../main'},{baseBranch:'feature/./main'},
  {model:'unsupported'},{reasoning:'high'},
  {maxRuntimeSeconds:89},{maxRuntimeSeconds:7201},{maxRuntimeSeconds:180.2},
  {token:'short'},{roleCapacity:0},{roleCapacity:11},{roleCapacity:1.5},
  {title:123},{title:'t'.repeat(301)},{description:123},
  {kind:'review',expectedCommit:'abc'},{kind:'ci',baseCommit:'bad',expectedCommit:'a'.repeat(40)}
 ];
 for(const patch of invalid){
  const error=runnerJobRequestError({...validJob,...patch});
  // Legacy policy intentionally allows '-' in baseBranch, unlike a new working branch.
  if(patch.baseBranch==='-bad'){assert.equal(error,null);continue;}
  assert.equal(error,'Некорректные параметры задачи','unexpected acceptance for '+JSON.stringify(patch));
 }
});

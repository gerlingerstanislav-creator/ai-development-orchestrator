import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantCompletionClient} from '../dist/infrastructure/assistant-completion-client.js';

const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
const config={model:'gpt-test',reasoning:'low'};
test('runner assistant adapter preserves role context, images, timeout and authenticated payload',async()=>{
 const requests=[];
 const fetchImpl=async(url,init)=>{
  requests.push({url,init});
  return response(200,{message:'  Verified answer  ',usage:{input_tokens:6,cached_input_tokens:1,output_tokens:4}});
 };
 const complete=createAssistantCompletionClient({codexUrl:'http://runner:4300',runnerKey:'secret-value',fetchImpl});
 const context={projectId:'project',role:'manager',taskId:'task'};
 const result=await complete('Check scope',config,{timeoutMs:3500,images:[],context});
 assert.equal(result.text,'Verified answer');
 assert.equal(result.usage.input_tokens,6);
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,'http://runner:4300/assistant');
 assert.equal(requests[0].init.headers['X-Runner-Secret'],'secret-value');
 assert.deepEqual(JSON.parse(requests[0].init.body),{model:'gpt-test',reasoning:'low',prompt:'Check scope',images:[],context});
 assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test('429 retry resumes once and records exact retry; no duplicate success calls',async()=>{
 const delays=[],retries=[];let count=0;
 const complete=createAssistantCompletionClient({
  codexUrl:'http://runner',runnerKey:'secret',
  fetchImpl:async()=>++count===1?response(429,{error:'rate limited'}):response(200,{message:'Recovered'}),
  sleep:async ms=>{delays.push(ms);}
 });
 const result=await complete('Task',config,{maxAttempts:3,onRetry:async(...args)=>{retries.push(args);}});
 assert.equal(result.text,'Recovered');
 assert.equal(count,2);
 assert.deepEqual(delays,[3000]);
 assert.deepEqual(retries,[[1,3,'rate limited']]);
});

test('nonretryable HTTP errors retain status; transient timeout exhausted as error',async()=>{
 let badCalls=0;
 const failed=createAssistantCompletionClient({codexUrl:'http://runner',runnerKey:'secret',
  fetchImpl:async()=>{badCalls++;return response(403,{error:'forbidden'});},sleep:async()=>{}});
 await assert.rejects(failed('Test',config,{maxAttempts:3}),error=>error.message==='forbidden'&&error.statusCode===403);
 assert.equal(badCalls,1);
 let timeoutCalls=0;
 const transient=createAssistantCompletionClient({codexUrl:'http://runner',runnerKey:'secret',
  fetchImpl:async()=>{timeoutCalls++;return response(503,{error:'Runner timeout'});},sleep:async()=>{}});
 await assert.rejects(transient('Test',config,{maxAttempts:2}),/Runner timeout/);
 assert.equal(timeoutCalls,2);
});

test('empty or oversized assistant output does not masquerade as success',async()=>{
 for(const message of ['  ','x'.repeat(120001)]){
  const complete=createAssistantCompletionClient({codexUrl:'http://runner',runnerKey:'secret',fetchImpl:async()=>response(200,{message})});
  await assert.rejects(complete('Test',config),/пустой ответ|безопасный объём/);
 }
});

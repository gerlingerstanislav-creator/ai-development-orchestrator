import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunnerHttpClient,RunnerHttpError} from '../dist/infrastructure/runner-http-client.js';

test('runner transport preserves auth, JSON request and response',async()=>{
 let request;
 const runner=createRunnerHttpClient({
  baseUrl:'http://codex:4300',secret:'test-secret',timeoutMs:25000,
  fetchImpl:async(url,options)=>{
   request={url,options};
   return new Response(JSON.stringify({status:'running',id:'job-1'}),{status:200});
  }
 });
 assert.deepEqual(await runner('/jobs','POST',{id:'job-1'}),{status:'running',id:'job-1'});
 assert.equal(request.url,'http://codex:4300/jobs');
 assert.equal(request.options.method,'POST');
 assert.equal(request.options.headers['X-Runner-Secret'],'test-secret');
 assert.equal(request.options.headers['Content-Type'],'application/json');
 assert.equal(request.options.body,JSON.stringify({id:'job-1'}));
 assert.equal(request.options.signal.aborted,false);
});

test('runner transport preserves HTTP status for caller-specific recovery',async()=>{
 for(const status of [404,409,500,503]){
  const runner=createRunnerHttpClient({
   baseUrl:'http://codex',secret:'x',
   fetchImpl:async()=>new Response(JSON.stringify({error:'runner unavailable'}),{status})
  });
  await assert.rejects(runner('/jobs/job-1'),error=>
   error instanceof RunnerHttpError &&
   error.statusCode===status &&
   error.message==='runner unavailable'
  );
 }
});

test('malformed non-OK responses use a stable error without claiming success',async()=>{
 const runner=createRunnerHttpClient({
  baseUrl:'http://codex',secret:'x',
  fetchImpl:async()=>new Response('not json',{status:502})
 });
 await assert.rejects(runner('/jobs/job-1'),error=>
  error instanceof RunnerHttpError &&
  error.statusCode===502 &&
  error.message==='Codex runner error'
 );
});

test('GET requests omit body and preserve unknown successful JSON',async()=>{
 let options;
 const runner=createRunnerHttpClient({
  baseUrl:'http://codex',secret:'x',
  fetchImpl:async(_url,init)=>{
   options=init;
   return new Response(JSON.stringify(['a','b']),{status:200});
  }
 });
 assert.deepEqual(await runner('/jobs/job-1'),['a','b']);
 assert.equal(options.method,'GET');
 assert.equal(options.body,undefined);
});

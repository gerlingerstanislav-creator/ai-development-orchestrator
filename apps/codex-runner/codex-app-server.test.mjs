import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCodexThreadStore,createCodexAppExecutor,threadStorageKey,asCodexExecResult} from './codex-app-server.mjs';

function mockAppServer(record,delay=0){
 return (_cmd,args,options)=>{
  const child=new EventEmitter();
  child.pid=undefined;child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin={destroyed:false,write(data){
   for(const line of data.split('\n').filter(Boolean)){
    const request=JSON.parse(line);
    if(request.id===undefined)continue;
    record.push({method:request.method,params:request.params,args,env:options.env});
    let result={};
    if(request.method==='initialize')result={userAgent:'test'};
    if(request.method==='thread/start')result={thread:{id:'thread_12345678'}};
    if(request.method==='thread/resume')result={thread:{id:request.params.threadId}};
    if(request.method==='turn/start')result={turn:{id:'turn_12345678',status:'inProgress'}};
    queueMicrotask(()=>{
     child.stdout.write(JSON.stringify({id:request.id,result})+'\n');
     if(request.method==='turn/start'){
      setTimeout(()=>{
       child.stdout.write(JSON.stringify({method:'item/reasoning/summaryTextDelta',
        params:{delta:'Checking the task plan'}})+'\n');
       child.stdout.write(JSON.stringify({method:'item/started',params:{
        item:{type:'mcpToolCall',tool:'work.list'}}})+'\n');
       child.stdout.write(JSON.stringify({method:'item/completed',params:{
        item:{type:'agentMessage',text:'Task completed '+request.params.input[0].text.slice(0,30)}}})+'\n');
       child.stdout.write(JSON.stringify({method:'thread/tokenUsage/updated',params:{
        tokenUsage:{last:{inputTokens:100,cachedInputTokens:75,outputTokens:30}}}})+'\n');
       child.stdout.write(JSON.stringify({method:'turn/completed',params:{
        turn:{id:'turn_12345678',status:'completed'}}})+'\n');
      },delay);
     }
    });
   }
  }};
  child.kill=()=>{child.stdout.end();queueMicrotask(()=>child.emit('close',0));};
  return child;
 };
}

test('same developer thread is resumed after QA rework and after Runner restart',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'ado-thread-test-'));
 t.after(async()=>rm(folder,{recursive:true,force:true}));
 const calls=[];
 const firstStore=createCodexThreadStore(folder);
 const scope={projectId:'project-1',taskId:'task-34',role:'development'};
 const executor=createCodexAppExecutor({store:firstStore,spawnImpl:mockAppServer(calls)});
 const opts={scope,requestId:'run-1',prompt:'Implement feature',model:'gpt-6-sol',effort:'low',
  cwd:folder,sandboxPolicy:{type:'workspaceWrite',writableRoots:[folder],networkAccess:false}};
 const first=await executor(opts);
 assert.equal(first.threadId,'thread_12345678');
 assert.equal(first.usage.cached_input_tokens,75);
 const secondStore=createCodexThreadStore(folder);
 const resumed=createCodexAppExecutor({store:secondStore,spawnImpl:mockAppServer(calls)});
 const second=await resumed({...opts,requestId:'qa-rework-1',prompt:'Fix the actual QA findings'});
 assert.equal(second.threadId,first.threadId);
 assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
 assert.equal(calls.filter(call=>call.method==='thread/resume').length,1);
 assert.equal(calls.filter(call=>call.method==='turn/start').length,2);
 assert.equal((await secondStore.read(scope)).turnId,'turn_12345678');
 assert.ok(asCodexExecResult(second).stdout.includes('"turn.completed"'));
});

test('distinct tasks and QA use isolated threads; keys contain no sensitive identifiers',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'ado-thread-test-'));
 t.after(async()=>rm(folder,{recursive:true,force:true}));
 const store=createCodexThreadStore(folder);
 const a={projectId:'one',taskId:'task-1',role:'development'};
 const b={projectId:'one',taskId:'task-2',role:'development'};
 const qa={projectId:'one',taskId:'task-1',role:'testing'};
 assert.notEqual(threadStorageKey(a),threadStorageKey(b));
 assert.notEqual(threadStorageKey(a),threadStorageKey(qa));
 await store.save(a,'thread_abcdefgh');
 assert.equal((await store.read(b)),null);
 assert.equal((await store.read(qa)),null);
 assert.equal((await readdir(folder)).length,1);
 const file=(await readdir(folder))[0];
 assert.ok(!file.includes('task'));
});

test('repeated HTTP delivery joins the running turn, not two Codex calls',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'ado-thread-test-'));
 t.after(async()=>rm(folder,{recursive:true,force:true}));
 const calls=[],store=createCodexThreadStore(folder);
 const execute=createCodexAppExecutor({store,spawnImpl:mockAppServer(calls,20)});
 const options={scope:{projectId:'p',taskId:'t',role:'development'},requestId:'same-run',
  prompt:'Continue once',model:'gpt-6-sol',effort:'low',cwd:folder,
  sandboxPolicy:{type:'workspaceWrite',writableRoots:[folder],networkAccess:false}};
 const results=await Promise.all([execute(options),execute(options)]);
 assert.equal(results[0].turnId,results[1].turnId);
 assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
});

test('App Server forwards notifications to progress observer without altering turn outcome',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'ado-progress-app-'));
 t.after(async()=>rm(folder,{recursive:true,force:true}));
 const calls=[],events=[];
 const store=createCodexThreadStore(folder);
 const run=createCodexAppExecutor({store,spawnImpl:mockAppServer(calls)});
 const result=await run({
  scope:{projectId:'project',role:'manager',processId:'owner-chat'},
  requestId:'pm-turn-1',prompt:'Review issue',model:'gpt-6-sol',effort:'low',cwd:folder,
  onEvent:event=>{events.push(event.method);},
  sandboxPolicy:{type:'readOnly',access:{type:'fullAccess'}}
 });
 assert.match(result.message,/Task completed/);
 assert.ok(events.includes('item/reasoning/summaryTextDelta'));
 assert.ok(events.includes('item/started'));
 assert.ok(events.includes('item/completed'));
 assert.ok(events.includes('turn/completed'));
});

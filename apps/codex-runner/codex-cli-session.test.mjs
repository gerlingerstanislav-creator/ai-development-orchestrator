import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {conversationThreadScope} from './codex-thread-scope.mjs';
import {createCodexThreadStore} from './codex-app-server.mjs';
import {createPersistentCliExecutor} from './codex-cli-session.mjs';

const owner='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const other='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

test('PM owner chat reuses one thread across turns, including internal Temporal follow-ups',()=>{
 const first=conversationThreadScope({project_id:'p1',agent_role:'manager',actor_id:owner,session_token:'temporary-1',request_id:'message-1'});
 const next=conversationThreadScope({project_id:'p1',agent_role:'manager',actor_id:owner,session_token:'temporary-2',request_id:'message-2',process_id:'background-process'});
 assert.deepEqual(first,next);
 assert.notDeepEqual(conversationThreadScope({project_id:'p2',agent_role:'manager',actor_id:owner}),first);
 assert.notDeepEqual(conversationThreadScope({project_id:'p1',agent_role:'manager',actor_id:other}),first);
 const task=conversationThreadScope({project_id:'p1',agent_role:'manager',actor_id:owner,task_id:'task-24'});
 assert.notDeepEqual(task,first,'PM task-specific work must not mutate owner chat history');
});
test('anonymous or global assistant requests never share a thread accidentally',()=>{
 const a=conversationThreadScope({},'assistant'),b=conversationThreadScope({},'assistant');
 assert.notDeepEqual(a,b);
 const scoped=conversationThreadScope({context:{projectId:'p',role:'analysis',processId:'analysis-run'}});
 assert.deepEqual(scoped,conversationThreadScope({context:{projectId:'p',role:'analysis',processId:'analysis-run'}}));
});
test('QA Codex CLI uses the same thread on a second test cycle and preserves sandbox args',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'codex-qa-resume-'));
 t.after(()=>rm(folder,{recursive:true,force:true}));
 const calls=[],store=createCodexThreadStore(folder);
 const command=async(name,args,opts)=>{
  assert.equal(name,'codex');
  calls.push(args);
  if(calls.length===1)opts.onStdout('{"type":"thread.started","thread_id":"12345678-1234-4234-8234-123456789abc"}\n');
  return {stdout:'{"type":"turn.completed","usage":{}}\n',stderr:'',exitCode:0};
 };
 const run=createPersistentCliExecutor(store,command);
 const scope={projectId:'p',taskId:'task-34',role:'testing'};
 const options={scope,model:'gpt-6-sol',reasoning:'low',cwd:folder,
  env:{ADO_AGENT_SESSION_TOKEN:'rotates'},
  policyArgs:['--strict-config','-c','permissions.ado-qa.network.enabled=true'],
  mcpArgs:['-c','mcp_servers.orchestrator.command="node"'],
  outputSchema:join(folder,'qa-report.schema.json'),timeout:10000,jobId:'test-1'};
 await run({...options,requestId:'qa-first',prompt:'Run QA first'});
 const stored=await store.read(scope);
 assert.equal(stored.threadId,'12345678-1234-4234-8234-123456789abc');
 const resume=createPersistentCliExecutor(createCodexThreadStore(folder),command);
 await resume({...options,requestId:'qa-second',prompt:'Recheck updated SHA'});
 assert.equal(calls.length,2);
 assert.ok(!calls.flat().includes('--ephemeral'));
 assert.ok(calls[0].includes('--output-schema'));
 assert.ok(calls[1].includes('--output-schema'));
 assert.ok(calls[1].includes('resume'));
 assert.ok(calls[1].includes(stored.threadId));
 assert.ok(calls[1].includes('--strict-config'));
 assert.ok(calls[1].includes(folder));
 assert.ok(!(await readFile(join(folder, (await import('./codex-app-server.mjs')).threadStorageKey(scope)+'.json'),'utf8')).includes('rotates'));
});
test('a timeout after the first Codex CLI event still persists the recoverable thread ID',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'codex-qa-failed-'));
 t.after(()=>rm(folder,{recursive:true,force:true}));
 const store=createCodexThreadStore(folder);
 const command=async(_name,_args,options)=>{
  options.onStdout('{"type":"thread.started","thread_id":"12345678-1234-4234-8234-123456789abc"}\n');
  throw Error('codex превысил ограничение времени');
 };
 const run=createPersistentCliExecutor(store,command);
 await assert.rejects(run({scope:{projectId:'p',taskId:'t',role:'testing'},requestId:'first',
  model:'gpt-6-sol',reasoning:'low',prompt:'Test',cwd:folder,command,
  env:{},timeout:100,jobId:'test'}),/времени/);
 assert.equal((await store.read({projectId:'p',taskId:'t',role:'testing'}))?.threadId,
 '12345678-1234-4234-8234-123456789abc');
});

test('delegated specialist resume uses compact context instead of repeating the full role prompt',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'codex-delegated-resume-'));
 t.after(()=>rm(folder,{recursive:true,force:true}));
 const calls=[];
 const execute=createPersistentCliExecutor(createCodexThreadStore(folder),async(_name,args,opts)=>{
  calls.push(args);
  if(calls.length===1)opts.onStdout('{"type":"thread.started","thread_id":"12345678-1234-4234-8234-123456789abc"}\n');
  return {stdout:'',stderr:'',exitCode:0};
 });
 const scope={projectId:'project',taskId:'task',role:'delegated:testing:assignment'};
 const args={scope,model:'gpt-6-sol',reasoning:'low',cwd:folder,env:{},timeout:10000,
  prompt:'Full role instructions and task history',resumePrompt:'Only new SHA and current task state'};
 await execute({...args,requestId:'first'});
 await execute({...args,requestId:'second'});
 assert.equal(calls.length,2);
 assert.equal(calls[0].at(-1),'Full role instructions and task history');
 assert.equal(calls[1].at(-1),'Only new SHA and current task state');
 assert.ok(calls[1].includes('resume'));
});

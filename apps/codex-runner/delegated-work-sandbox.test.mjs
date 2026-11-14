import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createDelegatedWorkSandbox,validateDelegatedSandboxRequest} from './delegated-work-sandbox.mjs';

const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const assignmentId='00000000-0000-4000-8000-000000000003';
const actorId='00000000-0000-4000-8000-000000000004';
const sourceSha='a'.repeat(40);
const token='test-gh-token-not-forwarded';
const base={projectId,taskId,assignmentId,actorId,role:'testing',repository:'owner/source',
 branch:'main',sourceSha,token,prompt:'Inspect the actual website via browser',model:'gpt-6',reasoning:'high'};

test('delegated sandbox validates project identity, role and repository without task-name routing',()=>{
 assert.deepEqual(validateDelegatedSandboxRequest(base),base);
 assert.throws(()=>validateDelegatedSandboxRequest({...base,role:'manager'}),/Некорректное поручение/);
 assert.throws(()=>validateDelegatedSandboxRequest({...base,taskId:'other'}),/Некорректное поручение/);
 assert.equal(validateDelegatedSandboxRequest({...base,taskId:null}).taskId,null);
 assert.throws(()=>validateDelegatedSandboxRequest({...base,taskId:undefined}),/Некорректное поручение/);
 assert.throws(()=>validateDelegatedSandboxRequest({...base,repository:'https://localhost:3001'}),/GitHub source/);
 assert.throws(()=>validateDelegatedSandboxRequest({...base,sourceSha:'branch'}),/GitHub source/);
});

test('generic specialist runs in isolated workspace and uploads only verified browser captures',async()=>{
 const workspacesRoot=await mkdtemp(join(tmpdir(),'ado-work-runtime-'));
 const bytes=Buffer.concat([Buffer.from([255,216]),Buffer.alloc(104,65),Buffer.from([255,217])]);
 const digest=createHash('sha256').update(bytes).digest('hex');
 const name='390x844-00000000-0000-4000-8000-000000000005.jpg';
 const calls=[], uploads=[], closed=[];
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  assert.match(url,/\/internal\/agent-tools\/work-artifacts$/);
  assert.equal(options.headers['X-Runner-Secret'],'trusted-runner-secret');
  const payload=JSON.parse(options.body);
  uploads.push(payload);
  return {ok:true,json:async()=>({saved:payload.artifacts.length})};
 };
 try{
  const run=createDelegatedWorkSandbox({
   workspacesRoot,cliEnv:{PATH:'/usr/bin'},runnerSecret:'trusted-runner-secret',
   agentApi:'http://api:3001/internal/agent-tools',
   command:async(binary,args,opts)=>{
    calls.push({binary,args,opts});
    if(binary==='git'&&args[0]==='rev-parse')return {stdout:sourceSha+'\n'};
    if(binary==='codex')return {stdout:'{"ok":true,"bridge":"connected"}\n'};
    return {stdout:''};
   },
   isolatedTaskPolicy:async()=>({sandboxArgs:['sandbox'],execArgs:['--strict-config']}),
   browser:{
    health:async()=>true,open:()=>({session:assignmentId,token:'browser-secret'}),
    close:async id=>{closed.push(id);},
    screenshots:()=>[{name,sha256:digest,viewport:{width:390,height:844},
     origin:'isolated-local-browser'}]
   },
   withReaderContext:async(_api,_key,scope,cb)=>{
    assert.equal(scope.processId,assignmentId);
    assert.equal(scope.role,'testing');
    return cb({args:['-c','mcp-test'],env:{ADO_AGENT_SESSION_TOKEN:'valid'}});
   },
   persistentCli:async job=>{
    assert.equal(job.cwd.startsWith(workspacesRoot),true);
    assert.equal(job.env.ADO_AGENT_SESSION_TOKEN,'valid');
    assert.ok(!job.prompt.includes(token));
    await mkdir(join(job.cwd,'.ado-qa-evidence'),{recursive:true});
    await writeFile(join(job.cwd,'.ado-qa-evidence',name),bytes);
    return {stdout:'pretend-codex-execution'};
   },
   decodeCodex:()=>({message:'Browser evidence captured',usage:{input_tokens:1}})
  });
  const result=await run(base);
  assert.equal(result.source_sha,sourceSha);
  assert.equal(result.browser_available,true);
  assert.equal(result.screenshots_saved,1);
  assert.equal(uploads.length,1);
  assert.equal(uploads[0].artifacts[0].sha256,digest);
  assert.deepEqual(uploads[0].artifacts[0].viewport,{width:390,height:844});
  assert.ok(calls.some(call=>call.binary==='git'&&call.args[0]==='clone'));
  assert.ok(calls.some(call=>call.binary==='codex'));
  assert.equal(closed.length,1);
 }finally{globalThis.fetch=oldFetch;await rm(workspacesRoot,{recursive:true,force:true});}
});

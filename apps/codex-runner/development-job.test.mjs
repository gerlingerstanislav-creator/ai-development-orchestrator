import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevelopmentJobRunner} from './development-job.mjs';
import {recoveryAction} from './job-journal.mjs';

const taskId='123e4567-e89b-42d3-a456-426614174000';
const previous='a'.repeat(40),commit='b'.repeat(40),other='c'.repeat(40);
const job={
 id:'123e4567-e89b-42d3-a456-426614174001',taskId,projectId:'project',
 token:'github-credential-not-in-log',repository:'owner/repo',baseBranch:'main',
 title:'Implement feature',description:'Make tests pass',model:'gpt-model',
 reasoning:'medium',maxRuntimeSeconds:35
};
function fixture({checkpoint,remoteHead=commit,existing=true,remoteStatus=404,
 cancelled=false,prFails=false,codexAnswer='UNVERIFIED'}={}){
 const events={commands:[],prs:[],prompts:[],cli:[],saved:[],http:[],scopes:[]};
 const state={status:'running',message:'',...(checkpoint?{checkpoint}:{})};
 const command=async(binary,args,options={})=>{
  events.commands.push({binary,args,options});
  assert.ok(!JSON.stringify(args).includes(job.token),'GitHub secret must not appear in git argv');
  if(binary==='git'&&args[0]==='remote')return {stdout:'https://github.com/owner/repo.git\n'};
  if(binary==='git'&&args[0]==='ls-remote')return {stdout:remoteHead+'\trefs/heads/'+taskId+'\n'};
  if(binary==='git'&&args[0]==='branch')return {stdout:'main\n'};
  if(binary==='git'&&args[0]==='show-ref')return {exitCode:1,stdout:''};
  if(binary==='git'&&args[0]==='status')return {stdout:''};
  if(binary==='git'&&args[0]==='rev-parse')return {stdout:commit+'\n'};
  if(binary==='git'&&args[0]==='ls-files')return {stdout:'index.ts\n'};
  return {stdout:'',exitCode:0};
 };
 const service=createDevelopmentJobRunner({
  runnerStateDir:'/isolated-journal',
  command,assertJobActive:id=>{assert.equal(id,job.id);if(cancelled)throw Error('Выполнение остановлено');},
  saveJob:(_job,s)=>{events.saved.push({...s});},
  ensureTaskPullRequest:async(...params)=>{
   events.prs.push(params);
   if(prFails)throw Error('GitHub PR 502');
   return 'https://github.com/owner/repo/pull/17';
  },
  isolatedTaskPolicy:async()=>({execArgs:['--sandbox']}),
  threadStore:{read:async scope=>{events.scopes.push(scope);return null;}},
  persistentCli:async input=>{events.cli.push(input);return {stdout:'codex events',threadId:'thread-from-Codex'};},
  auditCodexPrompt:async(...args)=>events.prompts.push(args),
  codexJsonResult:()=>({message:codexAnswer,usage:{input_tokens:7,cached_input_tokens:0,output_tokens:3}}),
  addUsage:(a,b)=>Object.fromEntries(['input_tokens','cached_input_tokens','output_tokens'].map(k=>[k,(a[k]||0)+(b[k]||0)])),
  cliEnv:{HOME:'/home/node'},
  resumePublishedCommit:async(_job,s,git)=>{
   if(!s.checkpoint)return false;
   const remote=(await git('ls-remote','origin','refs/heads/'+taskId)).stdout.trim().split(/\s+/)[0];
   const action=recoveryAction(s.checkpoint,remote);
   if(action==='changed')throw Error('Ветка GitHub изменилась после прерывания');
   return action==='published';
  },
  isCancelled:()=>cancelled,
  http:async url=>{events.http.push(url);return {status:remoteStatus,ok:remoteStatus===200};},
  mkdirWorkdir:async()=>{},
  checkAccess:async()=>{if(!existing)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});}
 });
 return {state,events,run:()=>service(job,state,{args:[],env:{}})};
}
test('recovers published checkpoint without repeating Codex, commit or push',async()=>{
 const f=fixture({checkpoint:{previous,commit},remoteHead:commit});
 await f.run();
 assert.equal(f.state.status,'completed');
 assert.equal(f.state.prUrl,'https://github.com/owner/repo/pull/17');
 assert.equal(f.state.branch,taskId);
 assert.equal(f.events.cli.length,0);
 assert.deepEqual(f.events.prs.map(x=>[x[1],x[2]]),[[taskId,commit]]);
 assert.equal(f.events.commands.filter(x=>x.args.includes('push')).length,0);
 assert.equal(f.events.commands.some(x=>x.args.includes('clone')),false);
});
test('changed published SHA does not overwrite remote branch or accept a PR',async()=>{
 const f=fixture({checkpoint:{previous,commit},remoteHead:other});
 await f.run();
 assert.equal(f.state.status,'failed');
 assert.match(f.state.message,/Ветка GitHub изменилась/);
 assert.equal(f.events.cli.length,0);
 assert.equal(f.events.prs.length,0);
});
test('published SHA with GitHub PR failure is never reported completed',async()=>{
 const f=fixture({checkpoint:{previous,commit},remoteHead:commit,prFails:true});
 await f.run();
 assert.equal(f.state.status,'failed');
 assert.match(f.state.message,/GitHub PR 502/);
 assert.equal(f.events.cli.length,0);
});
test('incorrect remote repository is refused before any model or PR operations',async()=>{
 const f=fixture();
 const svc=createDevelopmentJobRunner({
  runnerStateDir:'/isolated-journal',
  command:async(binary,args)=>{
   f.events.commands.push({binary,args});
   if(args[0]==='remote')return {stdout:'https://github.com/attacker/repo.git\n'};
   return {stdout:''};
  },assertJobActive:()=>{},saveJob:()=>{},ensureTaskPullRequest:async()=>{throw Error('never');},
  isolatedTaskPolicy:async()=>{throw Error('never');},threadStore:{read:async()=>null},
  persistentCli:async()=>{throw Error('never');},auditCodexPrompt:async()=>{},
  codexJsonResult:()=>({}),addUsage:()=>({}),cliEnv:{},resumePublishedCommit:async()=>false,
  mkdirWorkdir:async()=>{},checkAccess:async()=>{}
 });
 const state={status:'running',message:''};
 await svc(job,state,{args:[],env:{}});
 assert.equal(state.status,'failed');
 assert.match(state.message,/другому репозиторию/);
 assert.equal(f.events.commands.length,1);
});
test('new branch without modifications or evidence is blocked, not a false success',async()=>{
 const f=fixture({existing:false});
 await f.run();
 assert.equal(f.state.status,'failed');
 assert.match(f.state.message,/не представлены ни изменения, ни подтверждение/);
 assert.equal(f.state.branch,taskId);
 assert.equal(f.events.cli.length,1);
 assert.equal(f.events.prs.length,0);
 assert.equal(f.events.scopes[0].role,'development');
 assert.equal(f.events.scopes[0].taskId,taskId);
 assert.equal(f.events.cli[0].cwd,'/isolated-journal/workspaces/'+taskId+'/repo');
 assert.equal(f.state.usage.input_tokens,7);
});
test('GitHub branch-read error prevents Codex execution and hides token',async()=>{
 const f=fixture({existing:false,remoteStatus:403});
 await f.run();
 assert.equal(f.state.status,'failed');
 assert.match(f.state.message,/GitHub HTTP 403/);
 assert.ok(!f.state.message.includes(job.token));
 assert.equal(f.events.cli.length,0);
 assert.equal(f.events.prs.length,0);
});
test('cancellation does not overwrite an already-cancelled durable status',async()=>{
 const f=fixture({existing:false,remoteStatus:403,cancelled:true});
 f.state.status='cancelled';
 await f.run();
 assert.equal(f.state.status,'cancelled');
 assert.equal(f.events.prs.length,0);
});

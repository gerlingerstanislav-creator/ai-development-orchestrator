import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQaJobRunner} from './qa-job.mjs';

const SHA='a'.repeat(40);
const report={
 verdict:'passed',summary:'Read-only API test passes',handoffNote:'Verified response',
 learningSuggestion:'',findings:[],checks:[],
 caseResults:[{case_id:'qa-1',result:'passed',reason:'executed',evidence:'npm test exit 0',command:'npm test'}]
};
const reportEvents=withCommand=>[
 ...(withCommand?[{type:'item.completed',item:{type:'command_execution',command:'npm test',exit_code:0}}]:[]),
 {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report)}},
 {type:'turn.completed',usage:{input_tokens:15,cached_input_tokens:2,output_tokens:4}}
].map(x=>JSON.stringify(x)).join('\n');

async function harness(t,{remoteSha=SHA,withCommand=false,cloneFailure=false,cancelled=false}={}){
 const root=await mkdtemp(join(tmpdir(),'ado-qa-unit-'));
 const previous=process.env.QA_BROWSER_WORKSPACES_DIR;
 process.env.QA_BROWSER_WORKSPACES_DIR=root;
 t.after(async()=>{
  if(previous===undefined)delete process.env.QA_BROWSER_WORKSPACES_DIR;
  else process.env.QA_BROWSER_WORKSPACES_DIR=previous;
  await rm(root,{recursive:true,force:true});
 });
 const commands=[],closed=[],saved=[];
 const command=async(binary,args,options)=>{
  commands.push({binary,args,options});
  if(binary==='git'&&args[0]==='clone'){
   if(cloneFailure)throw Error('The remote token github-secret-12345 was rejected');
   await mkdir(args.at(-1),{recursive:true});
   return {stdout:''};
  }
  if(binary==='git'&&args[0]==='rev-parse')return {stdout:remoteSha+'\n'};
  if(binary==='git'&&args[0]==='ls-files')return {stdout:'README.md\n'};
  if(binary==='codex'&&args.includes('sh'))return {stdout:'node: available\nnpm: available\npython3_runtime: ok',exitCode:0};
  if(binary==='codex'&&args.includes('exec'))return {stdout:reportEvents(withCommand),exitCode:0};
  throw Error('Unexpected invocation '+binary+' '+args.join(' '));
 };
 const parse=output=>{
  let message='',usage={input_tokens:0,cached_input_tokens:0,output_tokens:0};
  for(const line of output.split('\n')){
   const event=JSON.parse(line);
   if(event.type==='item.completed'&&event.item?.type==='agent_message')message=event.item.text;
   if(event.type==='turn.completed')usage=event.usage;
  }
  return {message,usage};
 };
 const qa=createQaJobRunner({
  command,assertJobActive:id=>{if(cancelled)throw Error('Выполнение остановлено');},
  saveJob:(job,state)=>saved.push({id:job.id,status:state.status}),
  isolatedTaskPolicy:async()=>({sandboxArgs:[],execArgs:[]}),
  cliEnv:{HOME:'/test-home'},
  auditCodexPrompt:async()=>{},codexJsonResult:parse,
  addUsage:(a,b)=>({input_tokens:a.input_tokens+b.input_tokens,
   cached_input_tokens:a.cached_input_tokens+b.cached_input_tokens,output_tokens:a.output_tokens+b.output_tokens}),
  browser:{health:async()=>false,open:()=>{throw Error('browser unavailable')},
   evidence:()=>[],close:async id=>{closed.push(id);}},
  isCancelled:()=>cancelled
 });
 const job={id:randomUUID(),projectId:randomUUID(),taskId:randomUUID(),
  repository:'example/repo',branch:'main',token:'github-secret-12345',
  expectedCommit:SHA,maxRuntimeSeconds:30,model:'gpt-6-luna',reasoning:'low',
  title:'Check API response',description:'Verify JSON output with npm test',
  testPlan:{simplified:true,cases:[{id:'qa-1',title:'JSON API returns response'}]}};
 const state={status:'running',message:'Ready'};
 const run=async()=>qa(job,state,{args:[],env:{},prefix:''});
 return {run,root,commands,closed,saved,job,state};
}

test('QA must reject a branch SHA change, preserve pinned evidence and remove workspace',async t=>{
 const h=await harness(t,{remoteSha:'b'.repeat(40)});
 await h.run();
 assert.equal(h.state.status,'failed');
 assert.match(h.state.message,/Ветка PR изменилась/);
 assert.equal(h.saved.length,0,'do not persist changed commit as tested');
 assert.equal(h.closed.length,1,'release the unique browser identity even before session startup');
 assert.equal(h.commands.filter(c=>c.binary==='codex').length,0,'do not spend Codex tokens on wrong SHA');
 const all=await import('node:fs/promises').then(fs=>fs.readdir(h.root));
 assert.deepEqual(all,[],'remove the checkout after failure');
});

test('failed QA clone redacts GitHub token and always releases browser resources',async t=>{
 const h=await harness(t,{cloneFailure:true});
 await h.run();
 assert.equal(h.state.status,'failed');
 assert.doesNotMatch(h.state.message,/github-secret-12345/);
 assert.match(h.state.message,/\[REDACTED\]/);
 assert.equal(h.closed.length,1);
 assert.equal(h.commands.length,1);
 assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(h.root)),[]);
});

test('QA refuses a fabricated passed report without an executed test command',async t=>{
 const h=await harness(t,{withCommand:false});
 await h.run();
 assert.equal(h.state.status,'completed',h.state.message);
 assert.equal(h.state.testedCommit,SHA,'report always tied to immutable commit');
 assert.equal(h.state.executionVerified,true);
 assert.notEqual(h.state.verdict,'passed','model claim alone is not test evidence');
 assert.ok(h.state.caseResults.every(c=>c.result!=='passed'));
 assert.equal(h.closed.length,1);
 assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(h.root)),[]);
});

test('QA accepts a report only when actual Codex command execution proves the case',async t=>{
 const h=await harness(t,{withCommand:true});
 await h.run();
 assert.equal(h.state.status,'completed',h.state.message);
 assert.equal(h.state.testedCommit,SHA);
 assert.equal(h.state.verdict,'passed',JSON.stringify(h.state.caseResults));
 assert.equal(h.state.caseResults[0].result,'passed');
 assert.equal(h.state.usage.input_tokens,15);
 assert.equal(h.closed.length,1);
 assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(h.root)),[]);
});

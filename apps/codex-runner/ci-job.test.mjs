import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createDeterministicCiJobRunner} from './ci-job.mjs';

const sha='a'.repeat(40);
function harness({files=[],packageJson=null,exitCode=0,head=sha}={}){
 const calls=[],saved=[];
 const command=async(name,args)=>{
  calls.push({name,args});
  if(name==='git'&&args[0]==='clone'){
   const dest=args.at(-1);
   await mkdir(dest,{recursive:true});
   if(packageJson)await writeFile(join(dest,'package.json'),JSON.stringify(packageJson));
   return {stdout:'',stderr:'',exitCode:0};
  }
  if(name==='git'&&args[0]==='rev-parse')return {stdout:head+'\n',stderr:'',exitCode:0};
  if(name==='git'&&args[0]==='ls-files')return {stdout:files.join('\n'),stderr:'',exitCode:0};
  if(name==='codex')return {stdout:exitCode?'test failure':'test passed',stderr:'',exitCode};
  throw Error('Unexpected test command '+name+' '+args.join(' '));
 };
 const runner=createDeterministicCiJobRunner({
  command,assertJobActive:()=>{},saveJob:(_job,state)=>saved.push({...state}),
  isolatedTaskPolicy:async()=>({sandboxArgs:['--sandbox','workspace-write']}),
  cliEnv:{HOME:'/tmp/isolated'}
 });
 const job={id:'ci-test',taskId:'task-1',repository:'owner/repo',branch:'fix',expectedCommit:sha,token:'secret-for-test'};
 return {runner,job,calls,saved};
}
test('deterministic CI runs project tests in isolated checkout, reports checked SHA',async()=>{
 const ctx=harness({files:['package.json'],packageJson:{scripts:{test:'node --test'}}});
 const state={status:'running'};
 await ctx.runner(ctx.job,state);
 assert.equal(state.status,'completed');
 assert.equal(state.testedCommit,sha);
 assert.equal(state.ciVerdict,'passed');
 assert.ok(ctx.calls.some(c=>c.name==='codex'&&c.args.includes('npm')&&c.args.includes('test')));
 assert.ok(ctx.saved.length>=1);
});
test('absence of available project-owned tests remains blocked rather than passing',async()=>{
 const ctx=harness();
 const state={status:'running'};
 await ctx.runner(ctx.job,state);
 assert.equal(state.ciVerdict,'blocked');
 assert.equal(state.status,'completed');
 assert.match(state.ciChecks[0].output,/CI_UNSUPPORTED_TESTS/);
});
test('changed PR head is rejected before sandbox commands run',async()=>{
 const ctx=harness({head:'b'.repeat(40)});
 const state={status:'running'};
 await assert.rejects(ctx.runner(ctx.job,state),/SHA PR изменился/);
 assert.equal(ctx.calls.filter(c=>c.name==='codex').length,0);
});
test('nonzero npm test result is not converted to successful CI',async()=>{
 const ctx=harness({files:['package.json'],packageJson:{scripts:{test:'node --test'}},exitCode:1});
 const state={status:'running'};
 await ctx.runner(ctx.job,state);
 assert.equal(state.status,'completed');
 assert.equal(state.ciVerdict,'failed');
});

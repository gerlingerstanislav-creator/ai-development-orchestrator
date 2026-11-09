import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {closeGitHubArtifacts,needsGitHubCleanup} from '../dist/task-cancellation.js';

function fakeResponse(value,status=200){
 return new Response(status===204?null:JSON.stringify(value),{status,headers:status===204?{}:{'Content-Type':'application/json'}});
}
async function withFakeGitHub({branch,prNumber=null,merged=false,foreignHead=false,dependent=false,defaultBranch='main'},run){
 const calls=[];
 const original=globalThis.fetch;
 globalThis.fetch=async (url,options={})=>{
  const u=new URL(String(url)),path=u.pathname,method=String(options.method||'GET');
  calls.push(method+' '+path+u.search);
  if(path==='/repos/example/repo')return fakeResponse({default_branch:defaultBranch});
  if(path==='/repos/example/repo/pulls'&&u.searchParams.get('base')===branch)
   return fakeResponse(dependent?[{number:99,base:{ref:branch}}]:[]);
  if(path==='/repos/example/repo/pulls'&&u.searchParams.get('head')==='example:'+branch)
   return fakeResponse(prNumber?[{number:prNumber}]:[]);
  if(path==='/repos/example/repo/pulls/'+prNumber&&method==='GET')
   return fakeResponse({number:prNumber,state:merged?'closed':'open',merged,head:{ref:foreignHead?'other-branch':branch,repo:{full_name:'example/repo'}}});
  if(path==='/repos/example/repo/pulls/'+prNumber&&method==='PATCH')
   return fakeResponse({number:prNumber,state:'closed'});
  if(path==='/repos/example/repo/git/ref/heads/'+branch&&method==='GET')
   return fakeResponse({ref:'refs/heads/'+branch});
  if(path==='/repos/example/repo/git/refs/heads/'+branch&&method==='DELETE')
   return fakeResponse(null,204);
  throw Error('Unexpected GitHub request: '+method+' '+u.toString());
 };
 try{await run(calls);}finally{globalThis.fetch=original;}
}

test('orphan UUID branch after a failed runner is cleaned up even if task.git_branch is empty',async()=>{
 const id=randomUUID();
 assert.equal(needsGitHubCleanup({git_branch:null,pr_number:null},true),true);
 await withFakeGitHub({branch:id},async calls=>{
  await closeGitHubArtifacts('example/repo','test-token',{id,git_branch:null,pr_number:null});
  assert.ok(calls.includes('DELETE /repos/example/repo/git/refs/heads/'+id));
  assert.equal(calls.filter(c=>c.startsWith('PATCH ')).length,0);
 });
});
test('only matching unmerged PR is closed, then its task UUID branch is removed',async()=>{
 const id=randomUUID(),prNumber=42;
 await withFakeGitHub({branch:id,prNumber},async calls=>{
  await closeGitHubArtifacts('example/repo','test-token',{id,git_branch:id,pr_number:prNumber});
  const closed=calls.indexOf('PATCH /repos/example/repo/pulls/42');
  const deleted=calls.indexOf('DELETE /repos/example/repo/git/refs/heads/'+id);
  assert.ok(closed>=0&&deleted>closed,'PR is closed before branch is removed');
 });
});
test('merged pull requests cannot be cleaned up by task cancellation',async()=>{
 const id=randomUUID();
 await withFakeGitHub({branch:id,prNumber:42,merged:true},async calls=>{
  await assert.rejects(closeGitHubArtifacts('example/repo','test-token',{id,git_branch:id,pr_number:42}),/уже слит/);
  assert.equal(calls.some(c=>c.startsWith('DELETE ')||c.startsWith('PATCH ')),false);
 });
});
test('foreign, protected or dependent branches are never deleted',async()=>{
 const id=randomUUID();
 await withFakeGitHub({branch:id},async calls=>{
  await assert.rejects(closeGitHubArtifacts('example/repo','test-token',{id,git_branch:'feature-other',pr_number:null}),/чужой ветки/);
  assert.equal(calls.length,0);
 });
 await withFakeGitHub({branch:id,defaultBranch:id},async calls=>{
  await assert.rejects(closeGitHubArtifacts('example/repo','test-token',{id,git_branch:id}),/основной ветки/);
  assert.equal(calls.some(c=>c.startsWith('DELETE ')),false);
 });
 await withFakeGitHub({branch:id,dependent:true},async calls=>{
  await assert.rejects(closeGitHubArtifacts('example/repo','test-token',{id,git_branch:id}),/база других открытых PR/);
  assert.equal(calls.some(c=>c.startsWith('DELETE ')),false);
 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskPullRequestService} from './task-pull-request.mjs';

const commit='a'.repeat(40);
const otherCommit='b'.repeat(40);
const job={id:'run',repository:'owner/repo',taskId:'00000000-0000-4000-8000-000000000001',baseBranch:'main',title:'Fix issue',model:'gpt-6',token:'private-token'};
const branch=job.taskId;
const pr=(number,base='main',sha=commit)=>({number,base:{ref:base},head:{sha},html_url:'https://github.com/owner/repo/pull/'+number});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const service=(handler,cancel=()=>{})=>createTaskPullRequestService({fetchImpl:handler,assertJobActive:cancel});

test('reuses a task PR with the exact base and published SHA',async()=>{
 const calls=[];
 const url=await service(async(u,opts)=>{
  calls.push({u,opts});
  assert.equal(opts.headers.Authorization,'Bearer private-token');
  return response([pr(17)]);
 }).ensureTaskPullRequest(job,branch,commit,'summary');
 assert.equal(url,'https://github.com/owner/repo/pull/17');
 assert.equal(calls.length,1);
 assert.match(calls[0].u,/state=open/);
 assert.match(calls[0].u,/head=owner%3A/);
});
test('retargets an already-open task PR instead of creating a duplicate',async()=>{
 const calls=[];
 const url=await service(async(u,opts)=>{
  calls.push({u,opts});
  if(u.includes('state=open'))return response([pr(18,'release')]);
  if(u.endsWith('/pulls/18')&&opts.method==='PATCH'){
   assert.deepEqual(JSON.parse(opts.body),{base:'main'});
   return response(pr(18));
  }
  throw Error('Unexpected '+u);
 }).ensureTaskPullRequest(job,branch,commit,'summary');
 assert.equal(url,'https://github.com/owner/repo/pull/18');
 assert.deepEqual(calls.map(x=>x.opts.method||'GET'),['GET','PATCH']);
});
test('reopens a closed but unmerged task PR and preserves its review history',async()=>{
 const calls=[];
 const url=await service(async(u,opts)=>{
  calls.push({u,opts});
  if(u.includes('state=open'))return response([]);
  if(u.includes('state=closed'))return response([{...pr(19),merged_at:null}]);
  if(u.endsWith('/pulls/19')&&opts.method==='PATCH'){
   assert.deepEqual(JSON.parse(opts.body),{state:'open'});
   return response(pr(19));
  }
  throw Error('Unexpected '+u);
 }).ensureTaskPullRequest(job,branch,commit,'summary');
 assert.equal(url,'https://github.com/owner/repo/pull/19');
 assert.equal(calls.filter(x=>x.opts.method==='POST').length,0);
});
test('accepts a concurrent GitHub PR creator only when its SHA matches',async()=>{
 let lists=0,posts=0;
 const url=await service(async(u,opts)=>{
  if(u.includes('state=open'))return response(++lists===1?[]:[pr(20)]);
  if(u.includes('state=closed'))return response([]);
  if(u.endsWith('/pulls')&&opts.method==='POST'){
   posts++;
   const body=JSON.parse(opts.body);
   assert.equal(body.head,branch);
   assert.equal(body.base,'main');
   assert.equal(body.draft,false);
   return response({message:'already exists'},422);
  }
  throw Error('Unexpected '+u);
 }).ensureTaskPullRequest(job,branch,commit,'summary');
 assert.equal(url,'https://github.com/owner/repo/pull/20');
 assert.equal(posts,1);
 assert.equal(lists,2);
});
test('never accepts a task PR pointing to an unexpected commit',async()=>{
 await assert.rejects(service(async(u)=>{
  if(u.includes('state=open'))return response([pr(21,'main',otherCommit)]);
  if(u.endsWith('/pulls/21'))return response(pr(21,'main',otherCommit));
  throw Error('Unexpected '+u);
 }).ensureTaskPullRequest(job,branch,commit,'summary'),/SHA ветки не совпадает/);
});
test('does not make GitHub calls after cancellation',async()=>{
 let sent=false;
 await assert.rejects(service(async()=>{sent=true;return response([]);},()=>{throw Error('cancelled');})
  .ensureTaskPullRequest(job,branch,commit,'summary'),/cancelled/);
 assert.equal(sent,false);
});

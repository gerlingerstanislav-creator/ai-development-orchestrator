import test from 'node:test';
import assert from 'node:assert/strict';
import {createExistingTaskPrRecovery} from '../dist/modules/integrations/github/application/existing-task-pr-recovery.js';
import {saveRecoveredTaskPr} from '../dist/modules/integrations/github/infrastructure/recovered-task-pr-store.js';

const sha='a'.repeat(40),changed='b'.repeat(40);
const id='00000000-0000-4000-8000-000000000001';
const args={projectId:'project',taskId:id,runId:'run',actorId:'owner',
 repository:'owner/repo',baseBranch:'main',token:'secret',title:'Fix problem'};
const pr=(number=17,base='main',commit=sha)=>({
 number,state:'open',base:{ref:base},head:{ref:id,sha:commit},
 html_url:'https://github.com/owner/repo/pull/'+number,merged_at:null
});
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
function fixture({ahead=1,branchSha=sha,open=[pr()],closed=[],getPr=null,createResult=null}={}){
 const calls=[],saved=[];
 const http=async(url,options={})=>{
  const path=new URL(url).pathname+new URL(url).search;
  calls.push({path,options});
  assert.equal(options.headers.Authorization,'Bearer secret');
  if(path.includes('/branches/'))return response({commit:{sha:branchSha}});
  if(path.includes('/compare/'))return response({ahead_by:ahead,head_commit:{sha:branchSha}});
  if(path.includes('state=open'))return response(typeof open==='function'?open():open);
  if(path.includes('state=closed'))return response(closed);
  if(path.endsWith('/pulls')&&options.method==='POST')return createResult||response(pr(19));
  if(/\/pulls\/\d+$/.test(path)&&options.method==='PATCH'){
   const body=JSON.parse(options.body);
   assert.ok(body.base==='main'||body.state==='open');
   return response(pr(Number(path.split('/').at(-1))));
  }
  if(/\/pulls\/\d+$/.test(path))return response(getPr||pr(Number(path.split('/').at(-1))));
  throw Error('Unexpected GitHub route '+path);
 };
 return {calls,saved,recover:createExistingTaskPrRecovery({http,save:async x=>saved.push(x)})};
}
test('missing or not-ahead branch cannot complete a development run',async()=>{
 const missing=createExistingTaskPrRecovery({
  http:async()=>response({message:'Not Found'},404),
  save:async()=>{throw Error('Unexpected write');}
 });
 assert.equal(await missing(args),false);
 const f=fixture({ahead:0});
 assert.equal(await f.recover(args),false);
 assert.equal(f.saved.length,0);
 assert.equal(f.calls.some(x=>x.path.includes('/pulls')),false);
});
test('reuses exact PR and saves only after branch and current head are verified',async()=>{
 const f=fixture();
 assert.equal(await f.recover(args),true);
 assert.deepEqual(f.saved,[{
  projectId:'project',taskId:id,runId:'run',actorId:'owner',
  branch:id,headSha:sha,url:'https://github.com/owner/repo/pull/17',
  number:17,baseBranch:'main'
 }]);
 assert.equal(f.calls.filter(x=>x.path.includes('/branches/')).length,2);
 assert.equal(f.calls.some(x=>x.options.method==='POST'),false);
});
test('retargets a PR rather than creating a duplicate',async()=>{
 const f=fixture({open:[pr(18,'release')],getPr:pr(18)});
 assert.equal(await f.recover(args),true);
 assert.equal(f.saved[0].number,18);
 assert.deepEqual(JSON.parse(f.calls.find(x=>x.options.method==='PATCH').options.body),{base:'main'});
});
test('reopens an unmerged closed PR with the same review identity',async()=>{
 const f=fixture({open:[],closed:[{...pr(23),state:'closed'}],getPr:pr(23)});
 assert.equal(await f.recover(args),true);
 assert.equal(f.saved[0].number,23);
 assert.deepEqual(JSON.parse(f.calls.find(x=>x.options.method==='PATCH').options.body),{state:'open'});
});
test('creates a PR only once for code already ahead of base',async()=>{
 const f=fixture({open:[],closed:[]});
 assert.equal(await f.recover(args),true);
 assert.equal(f.saved[0].number,19);
 const post=f.calls.find(x=>x.options.method==='POST');
 assert.equal(JSON.parse(post.options.body).head,id);
 assert.equal(JSON.parse(post.options.body).base,'main');
});
test('422 concurrent create race resolves through the current PR listing',async()=>{
 let listed=0;
 const f=fixture({open:()=>++listed===1?[]:[pr(42)],
  createResult:response({message:'already exists'},422),getPr:pr(42)});
 assert.equal(await f.recover(args),true);
 assert.equal(f.saved[0].number,42);
 assert.equal(listed,2);
});
test('mismatched PR SHA, base, branch or closed state never writes completed',async()=>{
 for(const getPr of [pr(17,'main',changed),pr(17,'release'),
  {...pr(),head:{ref:'foreign',sha}}, {...pr(),state:'closed'}]){
  const f=fixture({getPr});
  await assert.rejects(f.recover(args),err=>err.statusCode===409);
  assert.equal(f.saved.length,0);
 }
});
test('a branch changing during proof invalidates the recovery',async()=>{
 let branchReads=0;
 const http=async(url)=>{
  const path=new URL(url).pathname+new URL(url).search;
  if(path.includes('/branches/'))return response({commit:{sha:++branchReads===1?sha:changed}});
  if(path.includes('/compare/'))return response({ahead_by:1,head_commit:{sha}});
  if(path.includes('state=open'))return response([pr()]);
  if(path.endsWith('/pulls/17'))return response(pr());
  throw Error('Unexpected '+path);
 };
 let saved=false;
 await assert.rejects(createExistingTaskPrRecovery({http,save:async()=>{saved=true;}})(args),
  err=>err.statusCode===409);
 assert.equal(saved,false);
});
test('database failure never masquerades as recovered success',async()=>{
 const http=async(url)=>{
  const path=new URL(url).pathname+new URL(url).search;
  if(path.includes('/branches/'))return response({commit:{sha}});
  if(path.includes('/compare/'))return response({ahead_by:1,head_commit:{sha}});
  if(path.includes('state=open'))return response([pr()]);
  if(path.endsWith('/pulls/17'))return response(pr());
  throw Error('Unexpected '+path);
 };
 await assert.rejects(createExistingTaskPrRecovery({
  http,save:async()=>{throw Error('database failed');}
 })(args),/database failed/);
});
test('atomic persistence rolls back cancelled or replaced runs',async()=>{
 const logs=[];
 const pool={connect:async()=>({
  query:async(sql,params=[])=>{
   logs.push({sql,params});
   if(sql.includes('UPDATE ai_task_runs'))return {rowCount:0};
   return {rowCount:1};
  },release:()=>logs.push({sql:'RELEASE'})
 })};
 await assert.rejects(saveRecoveredTaskPr(pool,{
  projectId:'project',taskId:id,runId:'run',actorId:'owner',
  branch:id,headSha:sha,url:'https://github.com/owner/repo/pull/17',
  number:17,baseBranch:'main'
 }),/изменился/);
 assert.deepEqual(logs.map(x=>x.sql.trim().split(/\s+/)[0]),
  ['BEGIN','UPDATE','ROLLBACK','RELEASE']);
 assert.deepEqual(logs[1].params,['run','https://github.com/owner/repo/pull/17',id,'project']);
});
test('atomic persistence commits only after task update and audit',async()=>{
 const events=[];
 const pool={connect:async()=>({
  query:async(sql)=>{events.push(sql.trim().split(/\s+/)[0]);return {rowCount:1};},
  release:()=>events.push('RELEASE')
 })};
 await saveRecoveredTaskPr(pool,{
  projectId:'project',taskId:id,runId:'run',actorId:'owner',
  branch:id,headSha:sha,url:'https://github.com/owner/repo/pull/17',
  number:17,baseBranch:'main'
 });
 assert.deepEqual(events,['BEGIN','UPDATE','UPDATE','INSERT','COMMIT','RELEASE']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {requireMergeCi} from '../dist/merge-ci.js';

const headSha='a'.repeat(40),mergeSha='b'.repeat(40);
const input={base:'https://api.github.com/repos/example/repo',headers:{Authorization:'Bearer test'},branch:'release/v1',headSha,mergeSha};
const check=(name,conclusion='success',appId)=>({name,conclusion,status:conclusion?'completed':'in_progress',app:{id:appId}});

test('branch and ruleset CI diagnostics use current commit evidence and expected sources',async t=>{
 const original=globalThis.fetch;
 t.after(()=>{globalThis.fetch=original;});
 let headChecks=[check('build'),check('lint','success',8)];
 let candidateChecks=[];
 let headStatuses=[];
 let candidateStatuses=[];
 let hideStatuses=false;
 const readPages=[];
 globalThis.fetch=async raw=>{
  const url=new URL(raw);
  const path=url.pathname;
  if(path.endsWith('/branches/release%2Fv1')&&!path.includes('/rules/'))return Response.json({
   name:input.branch,protection:{required_status_checks:{contexts:['build']}}
  });
  if(path.endsWith('/protection/required_status_checks'))return new Response(null,{status:403});
  if(path.includes('/rules/branches/'))return Response.json([
   {type:'required_status_checks',parameters:{required_status_checks:[{context:'lint',integration_id:7}]}}
  ]);
  const isHead=path.includes(headSha);
  if(path.endsWith('/statuses')){
   if(hideStatuses)return new Response(null,{status:403});
   return Response.json(isHead?headStatuses:candidateStatuses);
  }
  if(path.endsWith('/check-runs')){
   const page=Number(url.searchParams.get('page'));
   readPages.push([isHead,page]);
   const all=isHead?headChecks:candidateChecks;
   return Response.json({total_count:all.length,check_runs:all.slice((page-1)*100,page*100)});
  }
  assert.fail(raw);
 };
 await assert.rejects(requireMergeCi(input),/lint \(GitHub App 7\) — источник не подтверждён/);
 headChecks=[check('build',null),check('lint','success',7)];
 await assert.rejects(requireMergeCi(input),/build — in_progress/);
 headChecks=[check('build'),check('lint','success',7)];
 candidateChecks=[check('lint','success',7)];
 await assert.rejects(requireMergeCi(input),/build — результат отсутствует/);
 candidateChecks=[check('build'),check('lint','success',7)];
 candidateStatuses=[{context:'lint',state:'failure'}];
 await assert.rejects(requireMergeCi(input),/lint \(GitHub App 7\) — failure/);
 candidateStatuses=[{context:'lint',state:'success'},{context:'lint',state:'failure'}];
 await requireMergeCi(input);
 hideStatuses=true;
 await assert.rejects(requireMergeCi(input),/build — данные CI недоступны/);
 hideStatuses=false;
 candidateChecks=[];
 candidateStatuses=[];
 headStatuses=[];
 headChecks=[...Array.from({length:100},(_,i)=>check('optional-'+i)),check('build'),check('lint','success',7)];
 await requireMergeCi(input);
 assert.ok(readPages.some(([isHead,page])=>isHead&&page===2));
});

test('unprotected main avoids inaccessible branch rules but still checks reported CI failures',async t=>{
 const original=globalThis.fetch;
 t.after(()=>{globalThis.fetch=original;});
 let reads=[],conclusion='success';
 globalThis.fetch=async url=>{
  const path=new URL(url).pathname;
  reads.push(path);
  if(path.endsWith('/branches/main'))return Response.json({name:'main',protected:false});
  if(path.endsWith('/check-runs'))return Response.json({total_count:1,check_runs:[check('build',conclusion)]});
  if(path.endsWith('/statuses'))return Response.json([]);
  assert.fail('Rules API must not be called on an unprotected branch: '+path);
 };
 await requireMergeCi({...input,branch:'main'});
 assert.equal(reads.filter(path=>path.includes('/rules/')).length,0);
 conclusion='failure';
 await assert.rejects(requireMergeCi({...input,branch:'main'}),/build — failure/);
});
test('protected branches still fail closed when required CI rules cannot be read',async t=>{
 const original=globalThis.fetch;
 t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,opts)=>{
  const path=new URL(url).pathname;
  if(path.includes('/rules/branches/main'))return new Response(null,{status:403});
  if(path.endsWith('/branches/main'))return Response.json({name:'main',protected:true});
  assert.fail('Unexpected GitHub API call '+path);
 };
 await assert.rejects(requireMergeCi({...input,branch:'main'}),/Недостаточно прав GitHub для чтения обязательных проверок/);
});

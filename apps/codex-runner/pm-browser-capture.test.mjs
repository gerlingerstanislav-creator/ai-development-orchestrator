import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPmBrowserCapture,validatePmBrowserCaptureRequest} from './pm-browser-capture.mjs';

test('only scoped project repository, branch and verified pinned SHA reach PM browser',()=>{
 const job={captureId:randomUUID(),projectId:randomUUID(),taskId:randomUUID(),
  repository:'example/web',branch:'main',token:'x'.repeat(35),sourceSha:null};
 assert.equal(validatePmBrowserCaptureRequest(job),job);
 assert.throws(()=>validatePmBrowserCaptureRequest({...job,branch:'../secret'}));
 assert.throws(()=>validatePmBrowserCaptureRequest({...job,repository:'https://evil.test'}));
 assert.throws(()=>validatePmBrowserCaptureRequest({...job,sourceSha:'HEAD'}));
});
test('PM directly captures two receipts from isolated Chromium without starting another agent or changing code',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ado-pm-browser-')),sha='a'.repeat(40);
 const job={captureId:randomUUID(),projectId:randomUUID(),taskId:randomUUID(),
  repository:'example/web',branch:'main',token:'x'.repeat(40),sourceSha:null};
 let sessionId=null,viewport={width:1280,height:800},closed=false,uploads=0;
 const received=[],executed=[];
 const jpeg=Buffer.concat([Buffer.from([255,216,255,224]),Buffer.alloc(210,120),Buffer.from([255,217])]);
 const command=async(exe,args,opts)=>{
  executed.push({exe,args});
  if(exe==='git'&&args[0]==='clone'){
   await mkdir(args.at(-1),{recursive:true});
   await writeFile(join(args.at(-1),'index.html'),'<main>Rendered site</main>');
  }
  return {stdout:exe==='git'&&args[0]==='rev-parse'?sha:'',stderr:'',exitCode:0};
 };
 const fetchImpl=async(url,init)=>{
  const body=JSON.parse(init.body);
  if(url.includes(':4311/action')){
   if(body.action==='start')return {ok:true,json:async()=>({ok:true})};
   if(body.action==='viewport'){viewport={width:body.width,height:body.height};return {ok:true,json:async()=>({ok:true})};}
   if(body.action==='screenshot'){
    const name=viewport.width+'x'+viewport.height+'-'+randomUUID()+'.jpg',
     checksum=createHash('sha256').update(jpeg).digest('hex');
    const out=join(root,'ado-qa-'+sessionId,'repo','.ado-qa-evidence');
    await mkdir(out,{recursive:true});await writeFile(join(out,name),jpeg);
    const receipt={ok:true,screenshot:'.ado-qa-evidence/'+name,sha256:checksum,
     viewport:{...viewport},origin:'isolated-local-browser',name};
    received.push(receipt);
    return {ok:true,json:async()=>receipt};
   }
  }
  if(url.includes('/pm-browser-artifacts')){
   uploads++;
   assert.equal(body.sourceSha,sha);
   assert.equal(body.artifacts.length,2);
   assert.deepEqual(body.artifacts.map(x=>x.viewport.width),[1440,390]);
   return {ok:true,json:async()=>({saved:2,artifact_ids:[randomUUID(),randomUUID()]})};
  }
  throw Error('Unexpected external URL '+url);
 };
 const browser={
  health:async()=>true,open:id=>{sessionId=id;return {session:id,token:'t'.repeat(64)};},
  screenshots:()=>received,close:async()=>{closed=true;}
 };
 try{
  const runner=createPmBrowserCapture({command,isolatedTaskPolicy:async()=>({sandboxArgs:['sandbox']}),cliEnv:{},
   browser,agentApi:'http://api:3001/internal/agent-tools',runnerSecret:'y'.repeat(48),
   workspacesRoot:root,fetchImpl});
  const result=await runner(job);
  assert.equal(result.source_sha,sha);assert.equal(result.screenshots_saved,2);
  assert.equal(uploads,1);assert.equal(closed,true);
  assert.deepEqual(executed.map(x=>x.exe),['git','git']);
  assert.ok(!(await readFile(join(root,'ado-qa-'+sessionId,'repo','index.html')).catch(()=>null)));
 }finally{await rm(root,{recursive:true,force:true});}
});

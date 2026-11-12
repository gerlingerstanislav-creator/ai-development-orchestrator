// Real Chromium integration smoke: one-file HTML project, no index.html,
// no Docker socket, no external network. Runs inside the production QA image.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=await mkdtemp(join(tmpdir(),'ado-qa-browser-smoke-'));
const id=randomUUID(),token=randomBytes(32).toString('hex');
const repo=join(root,'ado-qa-'+id,'repo');
const url='http://127.0.0.1:4301';
let stderr='',stdout='';
let child;
async function request(action,more={}){
 const response=await fetch(url+'/action',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({session:id,token,action,...more}),signal:AbortSignal.timeout(70000)
 });
 const payload=await response.json();
 assert.equal(response.status,200,action+': '+JSON.stringify(payload));
 return payload;
}
try{
 await mkdir(repo,{recursive:true,mode:0o700});
 const lines=Array.from({length:8},(_,i)=>
  '<div class="line" style="width:100px;height:3px;background-color:hsl('+
  (i*43)+' 85% 50%);transform:rotate('+(i*9)+'deg)"></div>').join('');
 await writeFile(join(repo,'lines.html'),
  '<!doctype html><meta charset="utf-8"><title>Eight lines</title><main>'+lines+'</main>');
 // Intentionally no index.html: the original browser host rejected such apps.
 child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{
  env:{...process.env,QA_WORKSPACES_DIR:root},stdio:['ignore','pipe','pipe']
 });
 child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
 child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
 let healthy=false;
 for(let i=0;i<35;i++){
  if(child.exitCode!==null)break;
  try{
   const res=await fetch(url+'/health',{signal:AbortSignal.timeout(15000)});
   if(res.ok&&(await res.json()).ok){healthy=true;break;}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,300));
 }
 assert.equal(healthy,true,'Playwright service health failed: '+stderr+' '+stdout);
 const started=await request('start');
 assert.equal(started.ok,true);
 assert.equal(started.path,'/lines.html','standalone HTML must be the actual opening page');
 assert.equal(started.browser,'Chromium / Playwright');
 const count=await request('assert',{expression:'document.querySelectorAll(".line").length === 8'});
 assert.equal(count.assertion,'passed','real Chromium must evaluate the DOM');
 const colors=await request('assert',{expression:'new Set(Array.from(document.querySelectorAll(".line"),el=>getComputedStyle(el).backgroundColor)).size === 8'});
 assert.equal(colors.assertion,'passed','real Chromium must compute eight unique colors');
 await request('viewport',{width:390,height:844});
 assert.equal((await request('assert',{expression:'innerWidth === 390 && document.querySelectorAll(".line").length === 8'})).assertion,'passed');
 assert.equal((await request('goto',{path:'/lines.html'})).path,'/lines.html');
 const screenshot=await request('screenshot');
 assert.ok((await stat(join(repo,screenshot.screenshot))).size>100,'Chromium screenshot must exist');
 assert.equal((await request('assert',{expression:'document.querySelectorAll(".line").length === 7'})).assertion,'failed',
  'false assertions must never be accepted');
 await request('close');
 // Regression: a failed navigation can be retried using the same scoped
 // session ID/token after cleanup, without leaking any browser state.
 const retryFailed=await fetch(url+'/action',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({session:id,token,action:'start',path:'/missing.html'}),signal:AbortSignal.timeout(25000)});
 assert.equal(retryFailed.status,422);
 const retryBody=await retryFailed.json();
 assert.match(retryBody.error,/HTTP 404/);
 assert.equal((await request('start',{path:'/lines.html'})).path,'/lines.html');
 await request('close');
 console.log('PASS: real isolated Chromium loaded lines.html, asserted count/colors/mobile, saved screenshot, rejected false assertion and recovered after failed navigation');
}finally{
 if(child&&child.exitCode===null){
  child.kill('SIGTERM');
  await Promise.race([
   new Promise(resolve=>child.once('exit',resolve)),
   new Promise(resolve=>setTimeout(resolve,5000))
  ]);
  if(child.exitCode===null)child.kill('SIGKILL');
 }
 await rm(root,{recursive:true,force:true}).catch(()=>{});
}

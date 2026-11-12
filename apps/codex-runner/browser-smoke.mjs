// Runs inside Codex Runner against the real isolated Chromium service in CI.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createTaskPolicy,runnerEnvironment} from './execution-policy.mjs';
import {mkdir,writeFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {browserHealth,startQaBrowserGateway,openQaBrowserSession,getQaBrowserEvidence,closeQaBrowserSession} from './browser-gateway.mjs';
import {verifyQaExecution} from './qa-run-evidence.mjs';
const base=process.env.QA_BROWSER_WORKSPACES_DIR||'/var/lib/ado-qa-workspaces';
const id=randomUUID(),root=join(base,'ado-qa-'+id),repo=join(root,'repo');
const caseIds=Array.from({length:6},()=>randomUUID());
const gateway=startQaBrowserGateway();
const fixture=Array.from({length:10},(_,i)=>'<div class="circle" style="width:'+(i+20)+'px;height:'+(i+20)+'px;background:hsl('+(i*30)+',80%,55%)"></div>').join('');
async function call(session,action,fields={}){
 const r=await fetch('http://127.0.0.1:4311/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...session,action,...fields}),signal:AbortSignal.timeout(35000)});
 return r.json();
}
try{
 await mkdir(repo,{recursive:true,mode:0o700});
 await writeFile(join(repo,'index.html'),'<!doctype html><title>QA browser smoke</title>'+fixture);
 assert.equal(await browserHealth(),true,'Chromium must actually launch, not just exist in PATH');
 const session=openQaBrowserSession(id,caseIds);
 const started=await call(session,'start');
 assert.equal(started.ok,true,'Browser start failed: '+JSON.stringify(started));
 await writeFile(join(repo,'.ado-browser-session.json'),JSON.stringify(session));
 const policy=await createTaskPolicy(root,{qa:true});
 const command=spawn('codex',[...policy.sandboxArgs,'--','node','/opt/codex-runner/browser-client.mjs','assert','--case',caseIds[0],'document.querySelectorAll(".circle").length === 10'],{
  cwd:repo,env:{...runnerEnvironment(),HOME:'/home/node',CODEX_HOME:process.env.CODEX_HOME||'/home/node/.codex'},stdio:['ignore','pipe','pipe']
 });
 let output='',errors='';command.stdout.on('data',x=>output+=x.toString());command.stderr.on('data',x=>errors+=x.toString());
 const code=await new Promise((ok,fail)=>{command.once('error',fail);command.once('close',ok);});
 assert.equal(code,0,'Codex QA sandbox must reach the loopback browser client: '+output+' '+errors);
 assert.match(output,/"assertion":"passed"/);
 const exact=await call(session,'assert',{expression:'document.querySelectorAll(".circle").length === 10'});
 assert.equal(exact.ok,true);
 const unique=await call(session,'assert',{qaKind:'case',qaId:caseIds[3],expression:'new Set([...document.querySelectorAll(".circle")].map(e=>getComputedStyle(e).backgroundColor)).size === 10 && new Set([...document.querySelectorAll(".circle")].map(e=>getComputedStyle(e).width)).size === 10'});
 assert.equal(unique.ok,true);
 assert.equal((await call(session,'viewport',{width:390,height:844})).ok,true);
 assert.equal((await call(session,'assert',{qaKind:'case',qaId:caseIds[1],expression:'innerWidth===390 && document.documentElement.scrollWidth<=390'})).ok,true);
 assert.equal((await call(session,'assert',{qaKind:'case',qaId:caseIds[2],expression:'document.querySelectorAll(".circle").length===10 && [...document.querySelectorAll(".circle")].every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth})'})).ok,true);
 assert.equal((await call(session,'viewport',{width:844,height:390})).ok,true);
 assert.equal((await call(session,'assert',{qaKind:'case',qaId:caseIds[4],expression:'innerWidth===844 && document.documentElement.scrollWidth<=844'})).ok,true);
 assert.equal((await call(session,'goto',{path:'/'})).ok,true);
 assert.equal((await call(session,'assert',{qaKind:'case',qaId:caseIds[5],expression:'document.querySelectorAll(".circle").length===10'})).ok,true);
 const screenshot=await call(session,'screenshot');
 assert.equal(screenshot.ok,true);
 assert.ok((await stat(join(repo,screenshot.screenshot))).size>100);
 assert.equal((await call(session,'assert',{expression:'document.querySelectorAll(".circle").length === 9'})).ok,false,'False assertions must not pass');
 const plan=caseIds.map(case_id=>({case_id,title:'Browser case '+case_id,result:'passed',reason:'executed',command:'',evidence:'Checked by browser'}));
 const audited=verifyQaExecution({verdict:'passed',caseResults:plan,checks:[],findings:[]},[],[],{browserEvidence:getQaBrowserEvidence(id)});
 assert.equal(audited.caseResults.length,6);
 assert.ok(audited.caseResults.every(x=>x.result==='passed'&&x.browserVerified));
 assert.equal(audited.verdict,'passed');
 await closeQaBrowserSession(id);
 console.log('PASS: real Chromium verified six QA cases by ID, CSS, mobile/desktop, reload, screenshot, negative assertion and Runner receipts');
}finally{
 await closeQaBrowserSession(id);
 await rm(root,{recursive:true,force:true}).catch(()=>{});
 await new Promise(resolve=>gateway.close(resolve));
}

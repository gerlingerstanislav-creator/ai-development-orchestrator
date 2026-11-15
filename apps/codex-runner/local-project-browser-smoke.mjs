// End-to-end regression: build the real Vue/Vite site from the project's
// test branch INSIDE the Orchestrator Runner; serve it solely through the
// isolated Chromium service. A public deployment URL is never involved.
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile as execFileCb} from 'node:child_process';
import {browserHealth,startQaBrowserGateway,openQaBrowserSession,
 getQaScreenshotEvidence,closeQaBrowserSession} from './browser-gateway.mjs';

const execFile=promisify(execFileCb);
const site='gerlingerstanislav-creator/put-bez-pregrad';
const branch='test';
const expectedSha=process.env.PBP_TEST_SHA||'389c612e8cd6c131890154606c19410c4a76bdce';
const workspaceRoot=process.env.QA_BROWSER_WORKSPACES_DIR||'/var/lib/ado-qa-workspaces';
const id=randomUUID(),workspace=join(workspaceRoot,'ado-qa-'+id),repo=join(workspace,'repo');
const output=process.env.LOCAL_SCREENSHOTS_DIR||'/qa-artifacts';
let gateway,session;
async function action(name,props={}){
 const response=await fetch('http://127.0.0.1:4311/action',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({...session,action:name,...props}),
  signal:AbortSignal.timeout(name==='start'?75000:30000)
 });
 const data=await response.json();
 if(!response.ok||data.ok!==true)throw Error(name+': '+JSON.stringify(data));
 return data;
}
async function command(exe,args,options={}){
 const result=await execFile(exe,args,{
  cwd:options.cwd||repo,timeout:options.timeout||110000,
  maxBuffer:300000,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',npm_config_update_notifier:'false'}
 });
 return (result.stdout||'').trim();
}
try{
 await mkdir(workspace,{recursive:true});
 await command('git',['clone','--depth','1','--branch',branch,
  'https://github.com/'+site+'.git',repo],{cwd:workspace,timeout:85000});
 // Keep the CI fixture reproducible even when the active test branch
 // advances. Production browser.capture deliberately uses the latest branch.
 let sha=await command('git',['rev-parse','HEAD']);
 if(sha!==expectedSha){
  await command('git',['fetch','--depth','1','origin',expectedSha],{timeout:85000});
  await command('git',['checkout','--detach',expectedSha]);
  sha=await command('git',['rev-parse','HEAD']);
 }
 if(sha!==expectedSha)throw Error('Cannot verify pinned source SHA '+expectedSha);
 await command('npm',['install','--no-package-lock','--no-audit','--no-fund'],{timeout:125000});
 await command('npm',['run','build'],{timeout:110000});
 await readFile(join(repo,'dist','index.html'));
 if(!await browserHealth())throw Error('Isolated Chromium failed health check');
 gateway=startQaBrowserGateway();
 session=openQaBrowserSession(id,[]);
 const started=await action('start');
 if(started.path!=='/')throw Error('Unexpected local preview page: '+started.path);
 const manifest={environment:'local-isolated-preview',repository:site,branch,
  revisionMode:'pinned-ci-regression',
  sourceSha:sha,build:'npm install && npm run build',screenshots:[]};
 await mkdir(output,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  await action('viewport',viewport);
  await action('assert',{expression:
   'document.querySelector("#app .accessible-taxi") !== null && document.body.innerText.trim().length > 100'});
  const receipt=await action('screenshot');
  const name=viewport.width===1440?'desktop-1440x900.jpg':'mobile-390x844.jpg';
  const trusted=getQaScreenshotEvidence(id).some(x=>x.sha256===receipt.sha256&&
   x.name===receipt.screenshot.split('/').at(-1));
  if(!trusted)throw Error('Chromium did not verify '+name);
  const jpeg=await readFile(join(repo,receipt.screenshot));
  const sum=createHash('sha256').update(jpeg).digest('hex');
  if(sum!==receipt.sha256||jpeg.length<100)throw Error('Screenshot checksum mismatch: '+name);
  await writeFile(join(output,name),jpeg);
  manifest.screenshots.push({name,viewport,sha256:sum,bytes:jpeg.length});
 }
 // Real local full-page screenshot: verifies the new browser path, rather
 // than only the old desktop/mobile viewport snapshots.
 await action('viewport',{width:1920,height:1080});
 const pages=await action('list_pages');
 if(!pages.ok||!Array.isArray(pages.paths)||!pages.paths.includes('/'))
  throw Error('Cannot enumerate actual locally rendered project pages');
 const entirePage=await action('screenshot',{fullPage:true});
 if(entirePage.fullPage!==true||entirePage.viewport?.width!==1920||
  entirePage.pixelWidth<1920||entirePage.pixelHeight<1080)
  throw Error('Chromium did not confirm a full-resolution full-page screenshot');
 const verified=getQaScreenshotEvidence(id).some(x=>x.sha256===entirePage.sha256&&
  x.name===entirePage.screenshot.split('/').at(-1));
 if(!verified)throw Error('Full page screenshot has no trusted Chromium receipt');
 const fullJpeg=await readFile(join(repo,entirePage.screenshot));
 const fullSha=createHash('sha256').update(fullJpeg).digest('hex');
 if(fullSha!==entirePage.sha256||fullJpeg.length<100)
  throw Error('Full page screenshot failed SHA-256 verification');
 const fullName='full-page-1920-wide.jpg';
 await writeFile(join(output,fullName),fullJpeg);
 manifest.screenshots.push({name:fullName,fullPage:true,
  viewport:entirePage.viewport,pixelWidth:entirePage.pixelWidth,
  pixelHeight:entirePage.pixelHeight,sha256:fullSha,bytes:fullJpeg.length});
 await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
 console.log('PASS: real local Vue build, desktop/mobile and full-page Chromium screenshots at SHA '+sha);
}finally{
 if(session)await closeQaBrowserSession(id);
 if(gateway)await new Promise(resolve=>gateway.close(resolve));
 await rm(workspace,{recursive:true,force:true}).catch(()=>{});
}

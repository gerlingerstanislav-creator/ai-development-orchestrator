import {randomUUID,createHash} from 'node:crypto';
import {mkdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gitEnvironment} from './execution-policy.mjs';

const shaPattern=/^[a-f0-9]{40}$/i,uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const repoPattern=/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const branchPattern=/^[a-z0-9_.\/-]{1,120}$/i;
export function validatePmBrowserCaptureRequest(job){
 if(!job||![job.captureId,job.projectId].every(v=>uuid.test(v))||
  (job.projectCapture===true
   ?(job.taskId!=null||!['full_page','all_pages'].includes(job.mode))
   :!uuid.test(job.taskId))||
  !repoPattern.test(job.repository||'')||!branchPattern.test(job.branch||'')||
  job.branch.split('/').some(x=>x==='.'||x==='..')||job.branch.startsWith('-')||
  typeof job.token!=='string'||job.token.length<20||
  !(job.sourceSha===null||job.sourceSha===undefined||shaPattern.test(job.sourceSha)))
  throw Error('Некорректная или неподтверждённая заявка ПМ на скриншоты');
 return job;
}
/** Deterministic PM browser action. The manager model selects the desired
 * revision via MCP; it NEVER gets a shell or a GitHub token. Git clone and
 * dependency installation remain in the existing isolated Runner boundary.
 */
export function createPmBrowserCapture({command,isolatedTaskPolicy,cliEnv,
 browser,agentApi,runnerSecret,workspacesRoot,fetchImpl=fetch}){
 return async function capturePmBrowser(raw){
  const job=validatePmBrowserCaptureRequest(raw);
  const id=randomUUID(),workspace=join(workspacesRoot||'/var/lib/ado-qa-workspaces','ado-qa-'+id),
   dir=join(workspace,'repo'),gitEnv=gitEnvironment(job.token);
  let session=null;
  const action=async(name,payload={})=>{
   const res=await fetchImpl('http://127.0.0.1:4311/action',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...session,...payload,action:name}),
    signal:AbortSignal.timeout(name==='start'?80000:name==='screenshot'&&payload.fullPage===true?60000:25000)
   });
   const value=await res.json().catch(()=>({}));
   if(!res.ok||value.ok!==true)throw Error('Chromium '+name+': '+String(value.error||res.status).slice(0,1000));
   return value;
  };
  await mkdir(dir,{recursive:true,mode:0o700});
  try{
   await command('git',['clone','--depth','1','--branch',job.branch,
    'https://github.com/'+job.repository+'.git',dir],{cwd:workspace,env:gitEnv,timeout:85000,maxOutputChars:1500});
   if(job.sourceSha){
    await command('git',['fetch','--depth','1','origin',job.sourceSha],{
     cwd:dir,env:gitEnv,timeout:85000,maxOutputChars:1500});
    await command('git',['checkout','--detach',job.sourceSha],{
     cwd:dir,env:gitEnv,timeout:15000,maxOutputChars:1500});
   }
   const sha=(await command('git',['rev-parse','HEAD'],{cwd:dir,timeout:12000,maxOutputChars:150})).stdout.trim();
   if(!shaPattern.test(sha)||(job.sourceSha&&sha!==job.sourceSha.toLowerCase()))
    throw Error('Git checkout не соответствует требуемой ревизии');
   const pkg=await readFile(join(dir,'package.json'),'utf8').then(JSON.parse).catch(()=>null);
   const policy=await isolatedTaskPolicy(workspace,dir,undefined,true,true);
   const install=async(args,limit)=>{
    const result=await command('codex',[...policy.sandboxArgs,'--',...args],{
     cwd:dir,env:cliEnv,timeout:limit,maxOutputChars:2400
    });
    if(result.exitCode!==undefined&&result.exitCode!==0)
     throw Error(args.join(' ')+' завершилось с кодом '+result.exitCode+': '+String(result.stderr||result.stdout||'').slice(-1000));
   };
   if(pkg){
    const lock=await readFile(join(dir,'package-lock.json'),'utf8').then(()=>true).catch(()=>false);
    await install(['npm',lock?'ci':'install',...(lock?[]:['--no-package-lock']),'--no-audit','--no-fund'],105000);
    if(pkg.scripts?.build)await install(['npm','run','build'],85000);
   }
   if(!await browser.health())throw Error('Изолированный Chromium недоступен');
   session=browser.open(id,[],{adHoc:true});
   await action('start',job.projectCapture?{deviceScaleFactor:1.5}:{});
   const receipts=[];
   if(job.projectCapture){
    const viewport={width:1920,height:1080};
    await action('viewport',viewport);
    const routes=['/'],visited=new Set();
    for(let i=0;i<routes.length&&receipts.length<8;i++){
     const path=routes[i];
     if(visited.has(path))continue;
     visited.add(path);
     let page={title:'Главная страница'};
     if(path!=='/'){
      try{page=await action('goto',{path});}
      catch{continue;} // Unavailable internal links are not fabricated screenshots.
     }
     const links=await action('list_pages');
     if(job.mode==='all_pages'){
      for(const link of links.paths||[]){
       if(typeof link==='string'&&link.startsWith('/')&&!link.startsWith('//')&&
        !/[%?#\\]/.test(link)&&link.length<=180&&
        !visited.has(link)&&!routes.includes(link)&&routes.length<20)routes.push(link);
      }
     }
     const shot=await action('screenshot',{fullPage:true});
     if(shot.origin!=='isolated-local-browser'||shot.fullPage!==true||
      shot.viewport?.width!==viewport.width||shot.viewport?.height!==viewport.height||
      !Number.isInteger(shot.pixelWidth)||shot.pixelWidth<1920||
      !Number.isInteger(shot.pixelHeight)||shot.pixelHeight<=0)
      throw Error('Chromium не подтвердил полноразмерный снимок страницы');
     receipts.push({...shot,pagePath:path,title:String(page.title||path).slice(0,160)});
     if(job.mode==='full_page')break;
    }
    if(!receipts.length)throw Error('Не найдено доступных локальных страниц для снимков');
   }else{
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
     await action('viewport',viewport);
     const shot=await action('screenshot');
     if(shot.origin!=='isolated-local-browser'||shot.viewport?.width!==viewport.width||
      shot.viewport?.height!==viewport.height)throw Error('Chromium не подтвердил viewport');
     receipts.push(shot);
    }
   }
   const trusted=browser.screenshots(id);
   const artifacts=[];
   let totalBytes=0;
   for(const receipt of receipts){
    const name=String(receipt.screenshot||'').split('/').at(-1)||'';
    if(!trusted.some(saved=>saved.name===name&&saved.sha256===receipt.sha256))
     throw Error('Скриншот отсутствует в журнале доверенного браузера');
    const bytes=await readFile(join(dir,'.ado-qa-evidence',name));
    const checksum=createHash('sha256').update(bytes).digest('hex');
    totalBytes+=bytes.length;
    if(checksum!==receipt.sha256||bytes.length<100||
     bytes.length>(job.projectCapture?12_000_000:320000)||
     totalBytes>(job.projectCapture?45_000_000:640000))
     throw Error('Браузерный файл не прошёл проверку SHA256 или лимита размера');
    artifacts.push({name,mime:'image/jpeg',data:bytes.toString('base64'),
     sha256:checksum,viewport:receipt.viewport,origin:receipt.origin,
     ...(job.projectCapture?{fullPage:true,pagePath:receipt.pagePath,title:receipt.title,
      pixelWidth:receipt.pixelWidth,pixelHeight:receipt.pixelHeight}:{})});
   }
   const saved=await fetchImpl(agentApi+(job.projectCapture?'/pm-project-artifacts':'/pm-browser-artifacts'),{
    method:'POST',headers:{'X-Runner-Secret':runnerSecret,'Content-Type':'application/json'},
    body:JSON.stringify({captureId:job.captureId,projectId:job.projectId,
     taskId:job.taskId,sourceSha:sha,mode:job.projectCapture?job.mode:undefined,artifacts}),signal:AbortSignal.timeout(25000)
   });
   const result=await saved.json().catch(()=>({}));
   if(!saved.ok||Number(result.saved)!==artifacts.length)
    throw Error('Не удалось сохранить снимки в хранилище: '+String(result.error||saved.status).slice(0,350));
   return {source_sha:sha,screenshots_saved:artifacts.length,artifact_ids:result.artifact_ids||[],
    ...(job.projectCapture?{pages:receipts.map(shot=>({path:shot.pagePath,
     title:shot.title,pixelWidth:shot.pixelWidth,pixelHeight:shot.pixelHeight}))}:{})};
  }finally{
   if(session)await browser.close(id);
   await rm(workspace,{recursive:true,force:true}).catch(()=>{});
  }
 };
}

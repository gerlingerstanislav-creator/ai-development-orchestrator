import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {gitEnvironment} from './execution-policy.mjs';

const idPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const repoPattern=/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const shaPattern=/^[a-f0-9]{40}$/i;
const safeBranch=/^[a-z0-9_.\/-]{1,120}$/i;
export function validateDelegatedSandboxRequest(job){
 if(!job||!['analysis','development','testing','documentation','devops','architect'].includes(job.role)||
  ![job.assignmentId,job.projectId,job.actorId].every(x=>idPattern.test(x))||
  !(job.taskId===null||idPattern.test(job.taskId))||
  typeof job.prompt!=='string'||job.prompt.length<12||job.prompt.length>55000||
  typeof job.model!=='string'||job.model.length>90||
  !['minimal','low','medium','high','extra_high','xhigh'].includes(job.reasoning))
  throw new Error('Некорректное поручение для изолированного исполнителя');
 if(job.repository!==undefined&&job.repository!==null){
  if(!repoPattern.test(job.repository)||!safeBranch.test(job.branch||'main')||
   (job.sourceSha&&!shaPattern.test(job.sourceSha))||
   typeof job.token!=='string'||job.token.length<8)
   throw new Error('Некорректный или неавторизованный GitHub source');
 }
 return job;
}
/** Shared execution environment for ANY delegated specialist.
 * Code and browser are sandboxed; no GitHub credential or Docker socket is
 * available to the model. No task-name heuristics or fake browser evidence.
 */
export function createDelegatedWorkSandbox({
 command,isolatedTaskPolicy,persistentCli,cliEnv,
 withReaderContext,agentApi,runnerSecret,browser,decodeCodex,workspacesRoot
}){
 return async function runDelegatedSandbox(raw){
  const job=validateDelegatedSandboxRequest(raw);
  const attemptId=randomUUID();
  const workspace=join(workspacesRoot||'/var/lib/ado-qa-workspaces','ado-qa-'+attemptId);
  const dir=join(workspace,'repo');
  let browserSession=null,sourceSha=null,browserConnected=false;
  await mkdir(dir,{recursive:true,mode:0o700});
  try{
   if(job.repository){
    // Git credentials remain restricted to the host Git command environment.
    const gitEnv=gitEnvironment(job.token);
    await command('git',['clone','--depth','1','--branch',job.branch||'main',
     'https://github.com/'+job.repository+'.git',dir],{
     cwd:workspace,env:gitEnv,timeout:90000,maxOutputChars:1200
    });
    if(job.sourceSha){
     await command('git',['fetch','--depth','1','origin',job.sourceSha],{
      cwd:dir,env:gitEnv,timeout:90000,maxOutputChars:1200
     });
     await command('git',['checkout','--detach',job.sourceSha],{
      cwd:dir,env:gitEnv,timeout:15000,maxOutputChars:1200
     });
    }
    sourceSha=(await command('git',['rev-parse','HEAD'],{cwd:dir,timeout:15000})).stdout.trim();
    if(!shaPattern.test(sourceSha)||(job.sourceSha&&sourceSha!==job.sourceSha.toLowerCase()))
     throw new Error('Репозиторий не находится на запрошенном закреплённом SHA');
   }
   const policy=await isolatedTaskPolicy(workspace,dir,undefined,true,true);
   if(job.repository&&job.taskId&&await browser.health()){
    browserSession=browser.open(attemptId,[],{adHoc:true});
    await writeFile(join(dir,'.ado-browser-session.json'),JSON.stringify(browserSession),{mode:0o600});
    try{
     const probe=await command('codex',[...policy.sandboxArgs,'--',
      'node','/opt/codex-runner/browser-client.mjs','ping'],{
       cwd:dir,env:cliEnv,timeout:20000,maxOutputChars:1000
      });
     browserConnected=/"ok":true/.test(probe.stdout)&&/"bridge":"connected"/.test(probe.stdout);
    }catch{/* A live host does not imply a working sandbox browser. */}
    if(!browserConnected){
     await browser.close(attemptId);
     browserSession=null;
     await rm(join(dir,'.ado-browser-session.json'),{force:true});
    }
   }
   if(job.repository){
    const instructions=await readFile(new URL('./qa-tools.md',import.meta.url),'utf8');
    await writeFile(join(dir,'.ado-qa-tools.md'),instructions,{mode:0o600});
   }
   // Work prompts are still controlled by the project agents. This section
   // describes available mechanisms, not a route chosen by matching task text.
   const prefix=[
    'Ты выполняешь самостоятельное поручение в изолированной копии проекта.',
    'Текущая проверенная ревизия исходников: '+(sourceSha||'репозиторий не подключён')+'.',
    'Браузер Chromium/Playwright из этой песочницы: '+(browserConnected?'доступен':'недоступен')+'.',
    browserConnected
     ?'Доступны node /opt/codex-runner/browser-client.mjs start, viewport WIDTH HEIGHT, screenshot, assert и другие операции из .ado-qa-tools.md. Сначала подготовь реальное приложение, затем снимай проверяемые артефакты. Браузер открывает только локальное приложение из рабочего дерева.'
     :'Если для результата нужен браузер, сообщи точную блокировку: инструмент сейчас не доступен.',
    'Команды внутри рабочей копии допускаются только через действующую sandbox policy; не пытайся обойти сетевые ограничения.',
    'Это рабочая копия без автоматического push/PR. Запрещено выдавать локальные изменения за доставленные пользователю.',
    'Для результатов используй MCP work.report, не объявляй работу завершённой без подтверждения фактических действий.',
    !job.taskId?'Это поручение связано с целью ПМ, а не с карточкой Kanban. Сохранение браузерных снимков в task work.artifacts для него недоступно.':'Артефакты привязаны к задаче и закреплённой ревизии.'
   ].join('\n');
   const result=await withReaderContext(agentApi,runnerSecret,{
    projectId:job.projectId,taskId:job.taskId,processId:job.assignmentId,
    role:job.role,actorId:job.actorId
   },async context=>persistentCli({
    scope:{projectId:job.projectId,taskId:job.taskId,role:'delegated:'+job.role+':'+job.assignmentId},
    requestId:job.assignmentId+':'+attemptId,
    model:job.model,reasoning:job.reasoning,
    prompt:prefix+'\n\n'+job.prompt,
    cwd:dir,env:{...cliEnv,...context.env},policyArgs:policy.execArgs,
    mcpArgs:context.args,timeout:190000,maxOutputChars:250000
   }));
   const output=decodeCodex(result.stdout);
   // Browser gateway receipts, not model text or arbitrary repo files, are the
   // only acceptable source of immutable screenshot evidence.
   const trusted=browserSession?browser.screenshots(attemptId):[];
   const verified=[];
   for(const receipt of trusted.slice(0,10)){
    if(!/^[0-9]{3,4}x[0-9]{3,4}-[a-f0-9-]{36}\.jpg$/i.test(receipt.name))continue;
    const bytes=await readFile(join(dir,'.ado-qa-evidence',receipt.name)).catch(()=>null);
    if(!bytes||bytes.length<100||bytes.length>320000)continue;
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(hash!==receipt.sha256)continue;
    verified.push({name:receipt.name,mime:'image/jpeg',data:bytes.toString('base64'),
     sha256:hash,viewport:receipt.viewport,origin:receipt.origin});
   }
   let saved=0;
   if(verified.length){
    const res=await fetch(agentApi+'/work-artifacts',{
     method:'POST',
     headers:{'X-Runner-Secret':runnerSecret,'Content-Type':'application/json'},
     body:JSON.stringify({projectId:job.projectId,taskId:job.taskId,
      assignmentId:job.assignmentId,sourceSha,artifacts:verified}),
     signal:AbortSignal.timeout(20000)
    });
    if(!res.ok)throw Error('Результаты браузера не сохранены в проекте: HTTP '+res.status);
    saved=Number((await res.json()).saved)||0;
   }
   return {message:output.message||'',source_sha:sourceSha,
    browser_available:browserConnected,screenshots_saved:saved,usage:output.usage||null};
  }finally{
   if(browserSession)await browser.close(attemptId);
   await rm(workspace,{recursive:true,force:true}).catch(()=>{});
  }
 };
}

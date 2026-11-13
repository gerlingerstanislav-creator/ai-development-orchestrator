import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {gitEnvironment} from './execution-policy.mjs';
import {qaPrerequisiteError} from './qa-preflight.mjs';
import {qaBaselineCommands,readQaCommands,readQaReceipts,verifyQaExecution} from './qa-run-evidence.mjs';
import {incompleteQaCases,qaCompletionPrompt,completedQaSummary,applyVisualEvidenceGate} from './qa-completion.mjs';
import {assembleAgentPrompt} from '../api/src/prompt-assembler.mjs';
import {buildQaPrompt} from './qa-prompt.mjs';
import {scopedAgentPrompt} from './agent-context.mjs';

/**
 * QA application service. The HTTP dispatcher owns scheduling, credentials and
 * worker capacity; this service owns one isolated QA attempt and the evidence
 * gate. Impure operations are provided through explicit narrow ports.
 *
 * The same task can be returned to the developer after QA rejection. Every QA
 * attempt starts with a fresh, pinned worktree and Chromium identity; there is
 * no shared browser state or unverified "passed" verdict.
 */
export function createQaJobRunner({
 command,assertJobActive,saveJob,isolatedTaskPolicy,cliEnv,
 auditCodexPrompt,codexJsonResult,addUsage,browser,isCancelled,persistentCli
}){
 const {
  health:browserHealth,open:openQaBrowserSession,
  evidence:getQaBrowserEvidence,close:closeQaBrowserSession
 }=browser;

async function runTestJob(job,state,context){
 // Every attempt gets a fresh browser identity, even when the durable QA job ID
 // is retried. The browser host may still hold an orphan from an earlier run.
 const qaBrowserSessionId=randomUUID();
 const workdir=join(process.env.QA_BROWSER_WORKSPACES_DIR||'/var/lib/ado-qa-workspaces','ado-qa-'+qaBrowserSessionId);
 await mkdir(workdir,{recursive:true,mode:0o700});
 const dir=join(workdir,'repo');
 const gitEnv=gitEnvironment(job.token);
 const singlePass=job.testPlan?.singlePass===true;
 const adHoc=singlePass&&job.testPlan.adHoc===true;
 try{
  state.message='Получение ветки для независимой проверки';
  await command('git',['clone','--depth','1','--branch',job.branch||job.taskId,'https://github.com/'+job.repository+'.git',dir],
   {cwd:workdir,env:gitEnv,timeout:90000,jobId:job.id});
  const rev=await command('git',['rev-parse','HEAD'],{cwd:dir,timeout:10000,jobId:job.id});
  const commit=rev.stdout.trim();
  if((job.expectedCommit&&commit!==job.expectedCommit)||(state.testedCommit&&commit!==state.testedCommit))
   throw Error('Ветка PR изменилась. Требуется сверка нового коммита перед QA.');
  assertJobActive(job.id);
  state.testedCommit=commit;
  saveJob(job,state);
  // Probe from INSIDE the actual QA sandbox; a tool installed on the host may
  // not be runnable under bubblewrap. A browser is "available" only when a
  // headless process really starts, not just when "which chromium" succeeds.
  const policy=await isolatedTaskPolicy(workdir,dir,job.id,true,true);
  const probeScript=[
   'for tool in node npm npx python3 pytest git; do if command -v "$tool" >/dev/null 2>&1; then echo "$tool: available"; else echo "$tool: unavailable"; fi; done',
   'for tool in chromium chromium-browser google-chrome playwright; do if command -v "$tool" >/dev/null 2>&1; then echo "$tool: installed but not validated"; else echo "$tool: unavailable"; fi; done',
   'if test -d node_modules; then echo "node_modules: available"; else echo "node_modules: unavailable"; fi',
   'if python3 -c "import sqlite3" >/dev/null 2>&1; then echo "python3_runtime: ok"; else echo "python3_runtime: unavailable"; fi',
   'echo "network_policy: npm/PyPI registries and loopback only"'
  ].join('; ');
  const probe=await command('codex',[...policy.sandboxArgs,'--','sh','-c',probeScript],{
   cwd:dir,env:cliEnv,timeout:25000,maxOutputChars:6000,jobId:job.id
  });
  let browserAvailable=await browserHealth();
  let browserSession=null;
  let browserStartupEvidence='';
  if(browserAvailable){
   browserSession=openQaBrowserSession(qaBrowserSessionId,(job.testPlan?.cases||[]).map(test=>test.id),{adHoc});
   await writeFile(join(dir,'.ado-browser-session.json'),JSON.stringify(browserSession),{mode:0o600});
   // A host-side /health or /start is not proof that Codex commands can
   // reach the loopback bridge through the real QA permission profile.
   // Probe the *same* client and sandbox that the agent will use.
   let bridgeReady=false,bridgeError='';
   for(let attempt=0;attempt<2&&!bridgeReady;attempt++){
    try{
     const result=await command('codex',[...policy.sandboxArgs,'--',
      'node','/opt/codex-runner/browser-client.mjs','ping'],{
      cwd:dir,env:cliEnv,timeout:20000,maxOutputChars:2500,jobId:job.id
     });
     if(!/"ok":true/.test(result.stdout)||!/"bridge":"connected"/.test(result.stdout))
      throw Error('Browser bridge ping did not confirm an authenticated session: '+result.stdout.slice(-400));
     bridgeReady=true;
    }catch(error){
     assertJobActive(job.id);
     bridgeError=String(error.message||error).slice(0,650);
    }
   }
   if(!bridgeReady){
    browserAvailable=false;
    browserStartupEvidence='Браузерный мост недоступен из песочницы Codex после двух проверок: '+bridgeError;
    state.browserStartup=browserStartupEvidence;
    await closeQaBrowserSession(qaBrowserSessionId);
    browserSession=null;
   }
  }
  const capabilities=(probe.stdout.trim()+'\nqa_browser: '+(browserAvailable?'playwright chromium available':'unavailable')).slice(0,2500);
  state.capabilities=capabilities;
  const tracked=(await command('git',['ls-files'],{cwd:dir,env:gitEnv,timeout:10000,maxOutputChars:100000,jobId:job.id})).stdout.split(/\r?\n/);
  const prerequisite=qaPrerequisiteError(tracked,capabilities);
  if(prerequisite&&!job.testPlan?.simplified)throw Error(prerequisite);
  const baseline=[];
  if(singlePass){
   const packageJson=tracked.includes('package.json')
    ? await readFile(join(dir,'package.json'),'utf8').then(JSON.parse).catch(()=>null)
    : null;
   for(const check of qaBaselineCommands(tracked,packageJson,capabilities)){
    state.message='Запускает '+check.name;
    try{
     const result=await command('codex',[...policy.sandboxArgs,'--','env',
      'NO_PROXY=localhost,127.0.0.1,::1','no_proxy=localhost,127.0.0.1,::1','sh','-c',check.command],{
      cwd:dir,env:cliEnv,timeout:60000,maxOutputChars:5000,jobId:job.id,allowNonzero:true
     });
     baseline.push({...check,exitCode:result.exitCode,output:(result.stdout+'\n'+result.stderr).trim().slice(-2200)});
    }catch(error){
     assertJobActive(job.id);
     baseline.push({...check,exitCode:null,output:String(error.message||error).slice(-1000)});
    }
   }
  }
  // For standalone HTML (including pages without index.html), prove the real
  // browser can open the application before asking the model to test it.
  // Rich frontend projects may need npm install/build, so leave their setup
  // to the QA agent and let it start Chromium after preparing dependencies.
  if(browserSession&&tracked.some(name=>/\.html?$/i.test(name))){
   const pkg=tracked.includes('package.json')
    ?await readFile(join(dir,'package.json'),'utf8').then(JSON.parse).catch(()=>null):null;
   if(!pkg?.scripts?.dev&&!pkg?.scripts?.build){
    state.message='Открывает HTML-страницу в настоящем Chromium';
    try{
     const started=await fetch('http://127.0.0.1:4311/action',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...browserSession,action:'start'}),
      signal:AbortSignal.timeout(85000)
     });
     const report=await started.json();
     browserStartupEvidence=started.ok&&report.ok
      ?'Runner открыл страницу '+String(report.path||'/')+' через реальный Chromium; readyState='+String(report.readyState||'unknown')+'.'
      :'Начальная загрузка Chromium не удалась: '+String(report.error||started.status).slice(0,900)+'. QA может подготовить среду и повторить start.';
    }catch(error){
     browserStartupEvidence='Начальная загрузка Chromium не удалась: '+String(error.message||error).slice(0,900)+'. QA может повторить start.';
    }
    state.browserStartup=browserStartupEvidence;
   }
  }
  // Keep complete case data in the isolated workspace instead of embedding a huge JSON in the prompt.
  await writeFile(join(dir,'.ado-qa-plan.json'),JSON.stringify(job.testPlan||{}),{mode:0o600});
  // Tool recipes are workspace documentation, not model instructions.
  // Codex reads relevant sections on demand, avoiding unrelated technology.
  const qaHandbook=await readFile(new URL('./qa-tools.md',import.meta.url),'utf8');
  await writeFile(join(dir,'.ado-qa-tools.md'),qaHandbook,{mode:0o600});
  const prompt=buildQaPrompt(job,{singlePass,adHoc,browserAvailable,
   browserStartupEvidence,capabilities,baseline,prerequisite,testedCommit:state.testedCommit});
  state.message='Проверяет код и запускает доступные тесты';
  const commandField={command:{type:'string'}};
  const titleField=singlePass?{title:{type:'string'}}:{};
  const reportSchema={
   type:'object',additionalProperties:false,
   required:['verdict','summary','handoffNote','learningSuggestion','findings','checks','caseResults'],
   properties:{
    verdict:{type:'string',enum:['passed','failed','blocked']},
    summary:{type:'string'},
    handoffNote:{type:'string'},
     learningSuggestion:{type:'string'},
    findings:{type:'array',items:{type:'object',additionalProperties:false,required:['severity','description','steps','expected','actual'],properties:{
     severity:{type:'string',enum:['critical','major','minor']},description:{type:'string'},steps:{type:'string'},expected:{type:'string'},actual:{type:'string'}}}},
    checks:{type:'array',items:{type:'object',additionalProperties:false,required:['name','result','details','evidenceId',...Object.keys(commandField)],properties:{evidenceId:{type:'string'},...commandField,
     name:{type:'string'},result:{type:'string',enum:['passed','failed','not_run']},details:{type:'string'}}}},
    caseResults:{type:'array',items:{type:'object',additionalProperties:false,required:['case_id','result','reason','evidence',...Object.keys(commandField),...Object.keys(titleField)],properties:{...commandField,...titleField,
     case_id:{type:'string'},result:{type:'string',enum:['passed','failed','blocked','not_run']},
     reason:{type:'string',enum:['executed','tool_unavailable','environment_unavailable','manual_only','unknown']},evidence:{type:'string'}}}}
   }
  };
  const schemaPath=join(workdir,'qa-report.schema.json');
  await writeFile(schemaPath,JSON.stringify(reportSchema),{mode:0o600});
  const verifyReport=message=>{
   const fenced=message.match(/```(?:json)?\s*([\s\S]*?)```/i);
   const source=fenced?.[1]||message;
   const first=source.indexOf('{'),last=source.lastIndexOf('}');
   if(first<0||last<=first)throw Error('AI-тестировщик не вернул JSON');
   let data;
   try{data=JSON.parse(source.slice(first,last+1));}catch{throw Error('AI-тестировщик вернул некорректный JSON');}
   if(!['passed','failed','blocked'].includes(data.verdict)||typeof data.summary!=='string'||!Array.isArray(data.findings)||!Array.isArray(data.checks)||!Array.isArray(data.caseResults))
    throw Error('AI-тестировщик вернул недопустимую структуру отчёта');
   const required=(job.testPlan?.cases||[]).map(c=>c.id);
   if(data.caseResults.some(c=>!c||typeof c.case_id!=='string'||!['passed','failed','blocked','not_run'].includes(c.result)||typeof c.evidence!=='string'||typeof c.reason!=='string'))
    throw Error('Некорректные результаты отдельных тест-кейсов');
   if(required.some(id=>!data.caseResults.some(c=>c.case_id===id)))
    throw Error('В отчёте отсутствуют результаты части тест-кейсов');
   if(adHoc&&(!data.caseResults.length||data.caseResults.length>20||
    new Set(data.caseResults.map(c=>c.case_id)).size!==data.caseResults.length||
    data.caseResults.some(c=>!/^qa-[1-9][0-9]?$/.test(c.case_id)||typeof c.title!=='string'||c.title.trim().length<3||c.title.length>240)))
    throw Error('Отчёт должен содержать уникальные сценарии проверки с названиями');
   return data;
  };
  const qaScope={projectId:job.projectId,taskId:job.taskId,role:'testing'};
  let qaTurn=0;
  const args=['exec','-m',job.model,'-c','model_reasoning_effort="'+job.reasoning+'"',
   '--json','--skip-git-repo-check',...policy.execArgs,'--output-schema',schemaPath];
  const runQaCodex=async(instruction,{limit=900000,maxOutputChars=350000,useMcp=true}={})=>{
   if(!persistentCli)return command('codex',[...args,...(useMcp?context.args:[]),instruction],{
    cwd:dir,env:{...cliEnv,...(useMcp?context.env:{})},timeout:Math.min(limit,job.maxRuntimeSeconds*1000),maxOutputChars,jobId:job.id
   });
   const response=await persistentCli({
    scope:qaScope,requestId:job.id+':qa:'+ ++qaTurn,
    model:job.model,reasoning:job.reasoning,prompt:instruction,
    cwd:dir,env:{...cliEnv,...(useMcp?context.env:{})},
    policyArgs:policy.execArgs,mcpArgs:useMcp?context.args:[],
    outputSchema:schemaPath,timeout:Math.min(limit,job.maxRuntimeSeconds*1000),
    maxOutputChars,jobId:job.id
   });
   state.threadId=response.threadId;
   return response;
  };
  await auditCodexPrompt(job,'testing',prompt);
  const firstRun=await runQaCodex(prompt);
  let parsed=codexJsonResult(firstRun.stdout);
  state.usage=parsed.usage;
  let report,correctionOutput='';
  try{report=verifyReport(parsed.message||'');}
  catch(error){
   state.message='AI-тестировщик завершил проверки, но отчёт некорректен. Повторное форматирование отчёта';
   // The second attempt must not invent successful checks. It only reformats
   // the prior agent's actual evidence into the strict machine-readable schema.
   const correction=assembleAgentPrompt({
    identity:'QA, форматирование отчёта по уже выполненным тестам',
    objective:'Исправь структуру уже полученного отчёта без повторного выполнения тестов.',
    policy:'Не изобретай новые результаты. Для отсутствующих доказательств ставь blocked/not_run с reason=unknown; сбой форматирования не означает недоступность инструмента.',
    tools:'Используй только прежний ответ и сохранённые доказательства текущей попытки.',
    protocol:'Сопоставь case_id с планом и ранее выполненными действиями. Исправь только JSON и недостающие поля.',
    output:'Только валидный JSON в соответствии с тем же --output-schema, включая caseResults по всем case_id.',
    runtime:'Ошибка формата: '+String(error.message||error)+'. Case IDs: '+JSON.stringify((job.testPlan?.cases||[]).map(c=>c.id)),
    context:String(parsed.message||'').slice(0,6000),
    budget:9000
   });
   await auditCodexPrompt(job,'testing',correction);
   const second=await runQaCodex(correction,{limit:150000,maxOutputChars:200000,useMcp:false});
   correctionOutput=second.stdout;
   const corrected=codexJsonResult(second.stdout);
   state.usage=addUsage(state.usage,corrected.usage);
   report=verifyReport(corrected.message||'');
  }
  assertJobActive(job.id);
  const executedCommands=[...baseline.filter(c=>Number.isInteger(c.exitCode)),...readQaCommands(firstRun.stdout),...readQaCommands(correctionOutput)];
  const verifyActualExecution=async()=>{
   const receiptText=await readFile(join(dir,'.ado-qa-executions.jsonl'),'utf8').catch(()=>'');
   const receipts=readQaReceipts(receiptText.slice(0,250000),executedCommands);
   return verifyQaExecution(report,executedCommands,baseline,{
    receipts,browserEvidence:getQaBrowserEvidence(qaBrowserSessionId)
   });
  };
  let verified=await verifyActualExecution();
  // A command may prove a structural test, but not its visual/geometry case.
  // Enforce the exact same browser evidence requirement as the API, BEFORE
  // calculating missing cases or final counts. Never report "2/2" if API
  // will reject both cases as unverified.
  const plannedCases=(job.testPlan?.cases||[]).length?job.testPlan.cases:verified.cases;
  verified=applyVisualEvidenceGate(verified,plannedCases,{browserAvailable});
  // A successfully formatted JSON report is not the end of QA. The model can
  // overlook one case ID even when it verified overlapping cases in Chromium.
  // Give it one small, focused opportunity to collect the MISSING evidence.
  // The second model response is never trusted; only new gateway/receipt
  // events may change results.
  const gaps=incompleteQaCases(verified,plannedCases,{browserAvailable,maxCases:8});
  if(gaps.length){
   state.message='Допроверяет '+gaps.length+' сценариев без подтверждённых доказательств';
   const focus=qaCompletionPrompt(gaps,{taskTitle:job.title,taskDescription:job.description});
   await auditCodexPrompt(job,'testing',focus);
   try{
    const extra=await runQaCodex(scopedAgentPrompt(context,focus),{limit:180000,maxOutputChars:170000});
    executedCommands.push(...readQaCommands(extra.stdout));
    try{
     const parsedExtra=codexJsonResult(extra.stdout);
     state.usage=addUsage(state.usage,parsedExtra.usage);
    }catch{ /* We audit executed evidence, never rely on the follow-up prose. */ }
    verified=applyVisualEvidenceGate(await verifyActualExecution(),plannedCases,{browserAvailable});
   }catch(error){
    // A failed follow-up never invalidates previous genuine checks nor
    // silently waives the missing ones.
    state.qaFollowUpError=String(error.message||error).slice(0,650);
   }finally{
    // Browser assertions may have been executed before a Codex CLI failure.
    // Preserve their real results, including confirmed failures, rather than
    // converting them back into generic blocked status.
    verified=applyVisualEvidenceGate(await verifyActualExecution(),plannedCases,{browserAvailable});
   }
   verified.summary=completedQaSummary(verified,{retriedIds:gaps.map(item=>item.id)});
   if(verified.verdict==='passed')
    verified.handoffNote='Все тест-кейсы подтверждены, включая адресную допроверку '+gaps.map(item=>item.id).join(', ')+'.';
  }
  report=verified;
  state.executionVerified=true;
  if(adHoc)state.cases=report.cases;
  state.verdict=report.verdict;
  state.summary=report.summary.slice(0,3500);
  state.handoffNote=String(report.handoffNote||'').slice(0,2500);
   state.learningSuggestion=String(report.learningSuggestion||'').slice(0,1600);
  // Keep small screenshots as immutable QA evidence before deleting the workspace.
  const screenshotDir=join(dir,'.ado-qa-evidence');
  const shots=await readdir(screenshotDir).catch(()=>[]);
  const screenshots=[];
  for(const name of shots.filter(name=>/^[0-9a-f-]{36}\.jpg$/i.test(name)).slice(0,3)){
   const bytes=await readFile(join(screenshotDir,name)).catch(()=>null);
   if(bytes&&bytes.length>100&&bytes.length<=180000)screenshots.push({name,mime:'image/jpeg',data:bytes.toString('base64')});
  }
  state.screenshots=screenshots;
  state.findings=report.findings.slice(0,20);
  state.checks=report.checks.slice(0,30);
  state.caseResults=report.caseResults.slice(0,50);
  state.status='completed';
  state.message=singlePass?'Проверено '+report.caseResults.filter(c=>c.result==='passed'||c.result==='failed').length+' из '+report.caseResults.length:
   'Проверка завершена: '+(report.verdict==='passed'?'дефекты не найдены':report.verdict==='failed'?'обнаружены ошибки':'требуется ручная проверка');
 }catch(e){
  if(!isCancelled(job.id)){state.status='failed';state.message=String(e?.message||e).replaceAll(job.token||'','[REDACTED]').slice(0,1800);}
 }finally{
  // Always stop Chromium before deleting the shared QA workspace. This runs
  // after passed, blocked, failed, cancelled and interrupted agent attempts.
  await closeQaBrowserSession(qaBrowserSessionId);
  await rm(workdir,{recursive:true,force:true}).catch(()=>{});
 }
}
 return runTestJob;
}

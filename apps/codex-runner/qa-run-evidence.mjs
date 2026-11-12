/**
 * QA report verification: a language model's "passed" is a claim, not proof.
 * Browser proof originates in the trusted Playwright gateway, and generic
 * command proof originates in a qa-exec receipt correlated with Codex's
 * item.completed command_execution event. Exact textual command equality is
 * retained only for older, untagged runs.
 */
export function qaBaselineCommands(files,packageJson,capabilities){
 const commands=[],tracked=new Set(files);
 if(tracked.has('package.json')&&typeof packageJson?.scripts?.test==='string'&&/^npm: available$/m.test(capabilities))
  commands.push({command:'npm test',name:'Тесты Node.js из package.json'});
 if(files.some(file=>/(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(file))&&/^pytest: available$/m.test(capabilities))
  commands.push({command:'python3 -m pytest -q',name:'Тесты Python через pytest'});
 return commands;
}
export function readQaCommands(output){
 const commands=[];
 for(const line of String(output||'').split('\n')){
  let event;
  try{event=JSON.parse(line);}catch{continue;}
  const item=event?.item;
  if(event.type==='item.completed'&&item?.type==='command_execution'&&typeof item.command==='string'&&Number.isInteger(item.exit_code))
   commands.push({command:item.command,exitCode:item.exit_code});
 }
 return commands;
}
// Codex may invoke shell tools via /bin/bash -lc; the event need not match the
// model's prose. The exact case identity and qa-exec invocation are verified.
function invocationInEvent(command,kind,id){
 const raw=String(command||'').trim();
 const wrapped=raw.match(/^\S*\b(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
 const script=wrapped?wrapped[2]:raw;
 const segments=script.split(/(?:\r?\n|;\s*|&&|\|\|)/);
 const prefix=/^(?:(?:env\s+)?(?:[A-Z_][A-Z_0-9]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)?(?:(?:\/usr\/bin\/)?node)\s+\/opt\/codex-runner\/qa-exec\.mjs\s+(case|check)\s+([A-Za-z0-9_.-]+)\s+--\s+\S+/;
 return segments.some(segment=>{
  const match=prefix.exec(segment.trim());
  return !!match&&match[1]===kind&&match[2]===id;
 });
}
export function readQaReceipts(contents,commands=[]){
 const receipts=[];
 for(const line of String(contents||'').split('\n').slice(0,500)){
  let row;
  try{row=JSON.parse(line);}catch{continue;}
  if(!row||!['case','check'].includes(row.kind)||typeof row.id!=='string'||!/^[-a-zA-Z0-9_.]{1,100}$/.test(row.id)
   ||!Number.isInteger(row.exitCode)||row.exitCode<0||row.exitCode>255
   ||!Array.isArray(row.command)||typeof row.executionId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.executionId))continue;
  // A writable workspace alone is not a trusted attestation. Require an
  // actual Codex command_execution event invoking our ID-aware helper.
  if(!commands.some(c=>invocationInEvent(c.command,row.kind,row.id)))continue;
  receipts.push({kind:row.kind,id:row.id,executionId:row.executionId,exitCode:row.exitCode,
   command:row.command.slice(0,20).map(x=>String(x).slice(0,300)),
   stdout:String(row.stdout||'').slice(-1000),stderr:String(row.stderr||'').slice(-1000)});
 }
 return receipts;
}
function legacyCommand(commands,reported,result){
 const command=String(reported||'').trim();
 if(!command)return null;
 return commands.find(entry=>{
  const actual=entry.command.trim();
  const body=actual.match(/^\S*\b(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1$/)?.[2];
  return (actual===command||body===command)&&(result==='passed'?entry.exitCode===0:entry.exitCode!==0);
 });
}
function proofOutcome(kind,id,browserEvidence,receipts){
 const browser=browserEvidence.filter(e=>e?.kind===kind&&e.id===id&&['passed','failed'].includes(e.result));
 if(browser.length){
  const failure=browser.find(e=>e.result==='failed');
  const viewport=browser.at(-1)?.viewport;
  return {result:failure?'failed':'passed',browserVerified:true,reason:'executed',
   evidence:'[Chromium/Playwright] '+browser.length+' проверок для '+kind+' '+id+
    (viewport?' ('+viewport.width+'×'+viewport.height+')':'')+
    '. '+browser.map(e=>String(e.expression).slice(0,230)+' → '+e.result+(e.actual===null?'':' ('+String(e.actual).slice(0,100)+')')).join('; ').slice(0,1900)};
 }
 const matching=receipts.filter(r=>r.kind===kind&&r.id===id);
 if(matching.length){
  const latest=matching.at(-1);
  const explanation=latest.exitCode===0?latest.stdout:latest.stderr||latest.stdout;
  return {result:latest.exitCode===0?'passed':'failed',reason:'executed',
   evidence:'[qa-exec] '+kind+' '+id+' → код '+latest.exitCode+'. '+explanation.slice(-1250)};
 }
 return null;
}
export function verifyQaExecution(report,commands,baseline=[],{receipts=[],browserEvidence=[]}={}){
 const cases=report.caseResults.map(({command,...scenario})=>{
  if(!['passed','failed'].includes(scenario.result))return scenario;
  const proof=proofOutcome('case',scenario.case_id,browserEvidence,receipts);
  if(proof)return {...scenario,...proof,evidence:(proof.evidence+' '+scenario.evidence).slice(0,3000)};
  const ran=legacyCommand(commands,command,scenario.result);
  if(!ran)return {...scenario,result:'not_run',reason:'unknown',evidence:'Runner не нашёл структурированное подтверждение этой проверки в журнале Codex.'};
  return {...scenario,reason:'executed',evidence:(ran.command+' → код '+ran.exitCode+'. '+scenario.evidence).slice(0,3000)};
 });
 const checks=report.checks.map(({command,...check})=>{
  if(!['passed','failed'].includes(check.result))return check;
  const proof=check.evidenceId?proofOutcome('check',check.evidenceId,browserEvidence,receipts):null;
  if(proof)return {...check,result:proof.result,details:(proof.evidence+' '+check.details).slice(0,3000)};
  const ran=legacyCommand(commands,command,check.result);
  if(!ran)return {...check,result:'not_run',details:'Runner не подтвердил выполнение этой проверки.'};
  return {...check,details:(ran.command+' → код '+ran.exitCode+'. '+check.details).slice(0,3000)};
 });
 for(const check of baseline){
  if(check.exitCode!==0||checks.some(c=>c.result==='passed'&&c.details.startsWith(check.command+' → код 0.')))continue;
  checks.push({name:check.name,result:'passed',details:(check.command+' → код 0. '+check.output).slice(0,3000)});
 }
 const failed=cases.some(c=>c.result==='failed')||checks.some(c=>c.result==='failed');
 const findings=failed?report.findings:[];
 const complete=cases.length>0&&cases.every(c=>c.result==='passed')&&
  checks.every(c=>c.result==='passed')&&findings.length===0;
 return {...report,cases:cases.map(c=>({id:c.case_id,title:c.title})),caseResults:cases,checks,findings,
  verdict:failed?'failed':complete?'passed':'blocked'};
}

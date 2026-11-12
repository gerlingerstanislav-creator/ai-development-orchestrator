export function qaBaselineCommands(files, packageJson, capabilities) {
 const commands=[];
 const tracked=new Set(files);
 if(tracked.has('package.json')&&typeof packageJson?.scripts?.test==='string'&&/^npm: available$/m.test(capabilities)){
  commands.push({command:'npm test',name:'Тесты Node.js из package.json'});
 }
 if(files.some(file=>/(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(file))&&/^pytest: available$/m.test(capabilities)){
  commands.push({command:'python3 -m pytest -q',name:'Тесты Python через pytest'});
 }
 return commands;
}

export function readQaCommands(output) {
 const commands=[];
 for(const line of output.split('\n')){
  let event;
  try{event=JSON.parse(line);}catch{continue;}
  const item=event.item;
  if(event.type==='item.completed'&&item?.type==='command_execution'&&typeof item.command==='string'&&Number.isInteger(item.exit_code)){
   commands.push({command:item.command,exitCode:item.exit_code});
  }
 }
 return commands;
}

function matchingCommand(commands, reported, result) {
 const command=String(reported||'').trim();
 if(!command)return null;
 // Codex wraps shell commands in quotes. Match the whole command body to
 // avoid counting a substring of another command as a separate execution.
 return commands.find(entry=>{
  const actual=entry.command.trim();
  const body=actual.match(/^\S*\b(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1$/)?.[2];
  return (actual===command||body===command)&&(result==='passed'?entry.exitCode===0:entry.exitCode!==0);
 });
}

export function verifyQaExecution(report,commands,baseline=[]){
 const cases=report.caseResults.map(({command,...scenario})=>{
  if(!['passed','failed'].includes(scenario.result))return scenario;
  const ran=matchingCommand(commands,command,scenario.result);
  if(!ran)return {...scenario,result:'not_run',reason:'unknown',evidence:'Runner не подтвердил выполнение указанной команды с таким результатом.'};
  return {...scenario,reason:'executed',evidence:(ran.command+' → код '+ran.exitCode+'. '+scenario.evidence).slice(0,3000)};
 });
 const checks=report.checks.map(({command,...check})=>{
  if(!['passed','failed'].includes(check.result))return check;
  const ran=matchingCommand(commands,command,check.result);
  if(!ran)return {...check,result:'not_run',details:'Runner не подтвердил выполнение указанной команды с таким результатом.'};
  return {...check,details:(ran.command+' → код '+ran.exitCode+'. '+check.details).slice(0,3000)};
 });
 for(const check of baseline){
  if(check.exitCode!==0||checks.some(c=>c.result==='passed'&&c.details.startsWith(check.command+' → код 0.')))continue;
  checks.push({name:check.name,result:'passed',details:(check.command+' → код 0. '+check.output).slice(0,3000)});
 }
 const failed=cases.some(c=>c.result==='failed')||checks.some(c=>c.result==='failed');
 const findings=failed?report.findings:[];
 const complete=report.verdict==='passed'&&cases.length>0&&cases.every(c=>c.result==='passed')&&checks.some(c=>c.result==='passed')&&checks.every(c=>c.result==='passed');
 return {...report,cases:cases.map(c=>({id:c.case_id,title:c.title})),caseResults:cases,checks,findings,
  verdict:failed?'failed':complete?'passed':'blocked'};
}

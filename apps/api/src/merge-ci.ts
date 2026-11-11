type RequiredCheck={name:string;appId?:number};
type CheckRun={name:string;status:string;conclusion:string|null;app?:{id?:number}|null};
type CommitStatus={context:string;state:string};
type Evidence={checks:CheckRun[]|null;statuses:CommitStatus[]|null};
type Rule={type:string;parameters?:{required_status_checks?:Array<{context:string;integration_id?:number}>}};
type Branch={name:string;protection?:{required_status_checks?:{contexts?:string[];enforcement_level?:string}}};

const passing=new Set(['success','neutral','skipped']);
const blocked=(message:string)=>Object.assign(Error(message),{statusCode:409});
const githubError=(label:string,status:number)=>Object.assign(Error('Не удалось проверить '+label+' в GitHub: HTTP '+status),{statusCode:502});

export async function requireMergeCi(input:{
 base:string;headers:Record<string,string>;branch:string;headSha:string;mergeSha?:string|null
}){
 const {base,headers,branch,headSha,mergeSha}=input;
 const {Authorization:_,...publicHeaders}=headers;
 async function read(path:string,label:string){
  const url=base+path;
  const options={signal:AbortSignal.timeout(15000)};
  let response=await fetch(url,{...options,headers});
  if([401,403,404].includes(response.status)&&!response.headers.has('retry-after')&&response.headers.get('x-ratelimit-remaining')!=='0')
   response=await fetch(url,{...options,headers:publicHeaders});
  if([401,403,404].includes(response.status)&&!response.headers.has('retry-after')&&response.headers.get('x-ratelimit-remaining')!=='0')return null;
  if(!response.ok)throw githubError(label,response.status);
  return response;
 }
 async function pages<T>(path:string,label:string,select:(data:any)=>T[]|undefined){
  const items:T[]=[];
  for(let page=1;page<=30;page++){
   const response=await read(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page,label);
   if(!response)return null;
   const data=await response.json();
   const rows=select(data);
   if(!Array.isArray(rows))throw githubError(label,502);
   items.push(...rows);
   if(!/rel="next"/i.test(response.headers.get('link')||'')&&!(typeof data?.total_count==='number'&&data.total_count>items.length&&rows.length===100)){
    if(typeof data?.total_count==='number'&&data.total_count>items.length)
     throw blocked('GitHub вернул неполный список: '+label);
    return items;
   }
  }
  throw blocked('GitHub вернул слишком много страниц: '+label);
 }
 const ref=encodeURIComponent(branch);
 const [branchResponse,rules]=await Promise.all([
  read('/branches/'+ref,'защиту целевой ветки'),
  pages<Rule>('/rules/branches/'+ref,'правила целевой ветки',data=>data)
 ]);
 if(!branchResponse||!rules)throw blocked('Не удалось подтвердить список обязательных проверок CI для ветки '+branch);
 const details=await branchResponse.json() as Branch;
 if(details.name!==branch)throw blocked('GitHub не подтвердил правила для целевой ветки '+branch);
 const required:RequiredCheck[]=[];
 const add=(name:string,appId?:number)=>{
  if(typeof name!=='string'||!name.trim())throw blocked('GitHub вернул неполное правило обязательной проверки CI');
  if(!required.some(check=>check.name===name&&check.appId===appId))required.push({name,appId});
 };
 const classic=details.protection?.required_status_checks;
 if(classic?.enforcement_level!=='off'&&classic?.contexts?.length){
  // The compact branch response is readable with Contents access. Preserve any
  // source constraints from classic protection when the token can read them.
  const protection=await read('/branches/'+ref+'/protection/required_status_checks','источники проверок защищённой ветки');
  const data=protection?await protection.json() as {checks?:Array<{context:string;app_id?:number}>}:null;
  for(const context of classic.contexts){
   const source=data?.checks?.find(check=>check.context===context)?.app_id;
   add(context,typeof source==='number'&&source>0?source:undefined);
  }
 }
 for(const rule of rules){
  if(rule.type!=='required_status_checks')continue;
  const list=rule.parameters?.required_status_checks;
  if(!Array.isArray(list)||!list.length)throw blocked('GitHub вернул неполное правило обязательных проверок CI');
  for(const check of list)add(check.context,typeof check.integration_id==='number'&&check.integration_id>0?check.integration_id:undefined);
 }
 async function evidence(sha:string):Promise<Evidence>{
  const path='/commits/'+encodeURIComponent(sha);
  const [checks,statuses]=await Promise.all([
   pages<CheckRun>(path+'/check-runs?filter=latest','запуски проверок CI',data=>data?.check_runs),
   pages<CommitStatus>(path+'/statuses','статусы коммита',data=>data)
  ]);
  // GitHub lists commit statuses newest first. Preserve the latest per context.
  const seen=new Set<string>();
  return {checks,statuses:statuses?.filter(status=>{
   if(seen.has(status.context))return false;
   seen.add(status.context);return true;
  })??null};
 }
 const [head,candidate]=await Promise.all([
  evidence(headSha),required.length&&mergeSha&&mergeSha!==headSha?evidence(mergeSha):null
 ]);
 const diagnostics:string[]=[];
 const checkPassed=(run:CheckRun)=>run.status==='completed'&&passing.has(run.conclusion||'');
 const checkState=(run:CheckRun)=>run.status==='completed'?(run.conclusion||'результат неизвестен'):run.status;
 const values=(data:Evidence,check:RequiredCheck)=>({
  runs:data.checks?.filter(run=>run.name===check.name)??[],
  statuses:data.statuses?.filter(status=>status.context===check.name)??[]
 });
 // GitHub gives the test merge commit precedence whenever it has reported CI.
 const active=candidate&&(candidate.checks?.length||candidate.statuses?.length)?candidate:head;
 for(const check of required){
  const {runs,statuses}=values(active,check);
  const label=check.name+(check.appId?' (GitHub App '+check.appId+')':'');
  if(head.checks===null||head.statuses===null||candidate&&(candidate.checks===null||candidate.statuses===null)){
   diagnostics.push(label+' — данные CI недоступны');continue;
  }
  const accepted=check.appId?runs.filter(run=>run.app?.id===check.appId):runs;
  if(check.appId&&!accepted.length){
   diagnostics.push(label+(runs.length||statuses.length?' — источник не подтверждён':' — результат отсутствует'));continue;
  }
  if(!runs.length&&!statuses.length){diagnostics.push(label+' — результат отсутствует');continue;}
  const problems=[...accepted.filter(run=>!checkPassed(run)).map(checkState),...statuses.filter(status=>status.state!=='success').map(status=>status.state)];
  if(problems.length)diagnostics.push(label+' — '+[...new Set(problems)].join(', '));
 }
 // Retain the existing check on reported failures, including jobs that the branch
 // does not designate as mandatory.
 const requiredNames=new Set(required.map(check=>check.name));
 for(const run of head.checks??[])if(!requiredNames.has(run.name)&&!checkPassed(run))
  diagnostics.push(run.name+' — '+checkState(run));
 for(const status of head.statuses??[])if(!requiredNames.has(status.context)&&status.state!=='success')
  diagnostics.push(status.context+' — '+status.state);
 if(diagnostics.length)throw blocked('CI не подтверждён: '+[...new Set(diagnostics)].join('; '));
}

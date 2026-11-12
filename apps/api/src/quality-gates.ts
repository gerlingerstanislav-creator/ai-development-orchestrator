import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {resolveRoleAiSettings,roleCapacity} from './project-team.js';
import {agentInstructions} from './agent-instructions.js';

type GateKind='ci'|'review';
type RunResult={passed:boolean;kind:GateKind;message:string;headSha:string;baseSha:string};
type GateContext={projectId:string;taskId:string;runId:string};

const contextNames:Record<GateKind,string>={ci:'ado/self-hosted-ci',review:'ado/architecture-review'};
const errorText=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,1600);
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const ghHeaders=(token:string)=>({Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'});

export async function initQualityGateSchema(pool:Pool){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS quality_gate_runs(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('ci','review')),
  head_sha text NOT NULL,base_sha text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  verdict text,report jsonb NOT NULL DEFAULT '{}'::jsonb,message text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
  CONSTRAINT quality_gate_sha_format CHECK(length(head_sha)=40 AND length(base_sha)=40)
 );
 CREATE INDEX IF NOT EXISTS idx_quality_gate_project ON quality_gate_runs(project_id,started_at DESC);
 CREATE INDEX IF NOT EXISTS idx_quality_gate_sha ON quality_gate_runs(project_id,task_id,kind,head_sha,base_sha,started_at DESC);
 `);
}

async function logEvent(pool:Pool,projectId:string,runId:string,kind:GateKind,stage:string,detail:string,level='info'){
 await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level) VALUES($1,$2,$3,$4,$5,$6,$7)",
  [randomUUID(),projectId,runId,kind==='ci'?'ci':'architecture_review',stage,detail.slice(0,1800),level]);
}

async function publishStatus(pool:Pool,input:{projectId:string;runId:string;repository:string;token:string;headSha:string;kind:GateKind;state:'pending'|'success'|'failure'|'error';description:string}){
 try{
  const response=await fetch('https://api.github.com/repos/'+input.repository+'/statuses/'+input.headSha,{
   method:'POST',headers:{...ghHeaders(input.token),'Content-Type':'application/json'},
   body:JSON.stringify({state:input.state,context:contextNames[input.kind],description:input.description.slice(0,130)}),
   signal:AbortSignal.timeout(15000)
  });
  if(!response.ok)throw new Error('HTTP '+response.status);
 }catch(error){
  await logEvent(pool,input.projectId,input.runId,input.kind,'github_status_failed',
   'Результат сохранён в приложении, но статус GitHub не опубликован: '+errorText(error),'warning');
 }
}

async function readPr(pool:Pool,decrypt:(secret:string)=>string,projectId:string,taskId:string){
 const result=await pool.query(`SELECT t.id,t.title,t.description,t.git_branch,t.pr_number,
  p.owner_id AS actor_id,g.repository,g.target_branch,g.default_branch,c.secret_encrypted,
  a.model,a.reasoning,a.enabled
  FROM tasks t JOIN projects p ON p.id=t.project_id
  JOIN project_git_repositories g ON g.project_id=t.project_id
  JOIN connections c ON c.id=g.connection_id
  JOIN project_ai_settings a ON a.project_id=t.project_id
  WHERE t.project_id=$1 AND t.id=$2`,[projectId,taskId]);
 const task=result.rows[0];
 if(!task?.pr_number||!task.git_branch)throw new Error('Невозможно проверить качество: у задачи нет PR');
 const token=decrypt(task.secret_encrypted) as string;
 const response=await fetch('https://api.github.com/repos/'+task.repository+'/pulls/'+task.pr_number,{
  headers:ghHeaders(token),signal:AbortSignal.timeout(20000)
 });
 if(!response.ok)throw new Error('GitHub PR недоступен: HTTP '+response.status);
 const pr=await response.json() as {state?:string;head?:{sha?:string;ref?:string};base?:{sha?:string;ref?:string}};
 const headSha=pr.head?.sha,baseSha=pr.base?.sha;
 if(pr.state!=='open'||pr.head?.ref!==task.git_branch||!headSha||!baseSha||
  !/^[0-9a-f]{40}$/i.test(headSha)||!/^[0-9a-f]{40}$/i.test(baseSha)||
  !pr.base?.ref)throw new Error('PR изменён, закрыт или не содержит проверяемых SHA');
 return {task,token,headSha,baseSha,baseBranch:pr.base.ref};
}

async function gate(pool:Pool,ctx:GateContext,kind:GateKind,settings:Awaited<ReturnType<typeof readPr>>,
 decrypt:(secret:string)=>string,runnerUrl:string,runnerKey:string,onHeartbeat:()=>void):Promise<RunResult>{
 const {task,token,headSha,baseSha,baseBranch}=settings;
 const find=await pool.query('SELECT id,status,verdict,message FROM quality_gate_runs WHERE project_id=$1 AND task_id=$2 AND kind=$3 AND head_sha=$4 AND base_sha=$5 ORDER BY started_at DESC,id DESC LIMIT 1',
  [ctx.projectId,ctx.taskId,kind,headSha,baseSha]);
 let record=find.rows[0] as {id:string;status:string;verdict:string|null;message:string}|undefined;
 if(record?.status==='completed'&&record.verdict==='passed')return {passed:true,kind,message:record.message,headSha,baseSha};
 if(!record||['failed','completed'].includes(record.status)){
  const created=await pool.query(`INSERT INTO quality_gate_runs(id,project_id,task_id,kind,head_sha,base_sha)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status,verdict,message`,
   [randomUUID(),ctx.projectId,ctx.taskId,kind,headSha,baseSha]);
  record=created.rows[0]??(await pool.query('SELECT id,status,verdict,message FROM quality_gate_runs WHERE project_id=$1 AND task_id=$2 AND kind=$3 AND head_sha=$4 AND base_sha=$5',
   [ctx.projectId,ctx.taskId,kind,headSha,baseSha])).rows[0];
 }
 if(!record)throw Error('Не удалось создать запуск проверки качества');
 const id=record.id;
 await pool.query("UPDATE quality_gate_runs SET status='running' WHERE id=$1 AND status='queued'",[id]);
 const statusArgs={projectId:ctx.projectId,runId:id,repository:task.repository,token,headSha,kind};
 await publishStatus(pool,{...statusArgs,state:'pending',description:'Проверка выполняется внутри AI Development Orchestrator'});
 await logEvent(pool,ctx.projectId,id,kind,'started','Проверка PR '+headSha+' относительно '+baseSha);
 const ai=await resolveRoleAiSettings(pool,ctx.projectId,kind==='ci'?'devops':'architect',
  {model:task.model||'gpt-6-luna',reasoning:task.reasoning||'low',enabled:task.enabled});
 const job={id,kind,taskId:ctx.taskId,projectId:ctx.projectId,actorId:task.actor_id,
  repository:task.repository,branch:task.git_branch,baseBranch,token,
  expectedCommit:headSha,baseCommit:baseSha,model:ai.model,reasoning:ai.reasoning,
  title:String(task.title),description:String(task.description||''),agentInstructions:kind==='review'?agentInstructions.architect:'',
  maxRuntimeSeconds:kind==='ci'?2400:1200,roleCapacity:await roleCapacity(pool,ctx.projectId,kind==='ci'?'devops':'architect')};
 const request=async(path:string,method:'GET'|'POST'='GET',payload?:unknown)=>{
  const response=await fetch(runnerUrl+path,{method,headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
   body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(30000)});
  const value=await response.json().catch(()=>({})) as any;
  if(!response.ok)throw Object.assign(new Error(String(value.error||'Runner HTTP '+response.status)),{statusCode:response.status});
  return value;
 };
 try{
  let current:any;
  try{current=await request('/jobs/'+id);}
  catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
  if(!current||current.status==='interrupted'){
   try{current=await request('/jobs','POST',job);}
   catch(error){if((error as {statusCode?:number}).statusCode!==409)throw error;current=await request('/jobs/'+id);}
  }
  for(let attempt=0;attempt<390;attempt++){
   onHeartbeat();
   current=await request('/jobs/'+id);
   if(['completed','failed','cancelled'].includes(current.status))break;
   await wait(8000);
  }
  if(current.status!=='completed')throw Error('Исполнитель качества не завершился: '+String(current.message||current.status));
  const report=kind==='ci'?{checks:current.ciChecks,commit:current.testedCommit}:current.reviewReport;
  const passed=kind==='ci'?current.ciVerdict==='passed'&&current.testedCommit===headSha:
   current.reviewReport?.verdict==='approved'&&current.reviewedCommit===headSha;
  // Missing CI discovery is not a product regression. Prevent Temporal from
  // scheduling endless developer rework on the same head SHA. The workflow
  // already treats "Сбой проверки:" as a non-reworkable blocker.
  const unsupported=kind==='ci'&&current.ciVerdict==='blocked'&&current.testedCommit===headSha;
  if(!report||kind==='review'&&!['approved','changes_requested'].includes(report.verdict))
   throw Error('Исполнитель не предоставил валидный отчёт '+kind);
  const latest=await readPr(pool,decrypt,ctx.projectId,ctx.taskId);
  if(latest.headSha!==headSha||latest.baseSha!==baseSha)throw Error('PR изменён, закрыт или не содержит проверяемых SHA');
  const verdict=passed?'passed':unsupported?'blocked':'rejected';
  const message=passed?(kind==='ci'?'Собственный CI пройден':'Архитектор одобрил PR'):
   unsupported?'Не обнаружены исполняемые проверки проекта. CI заблокирован до настройки тестов; разработка не должна запускаться повторно.':
   (kind==='ci'?'Технические проверки не пройдены':String(report.summary||'Архитектор запросил исправления')).slice(0,1400);
  await pool.query("UPDATE quality_gate_runs SET status='completed',verdict=$2,report=$3,message=$4,completed_at=now() WHERE id=$1",
   [id,verdict,JSON.stringify(report),message]);
  await logEvent(pool,ctx.projectId,id,kind,verdict,message,passed?'info':'warning');
  await publishStatus(pool,{...statusArgs,state:passed?'success':unsupported?'error':'failure',description:message});
  return {passed,kind,message:passed?message:unsupported?'Сбой проверки: '+message+'\n'+JSON.stringify(report).slice(0,3000):
   message+'\n'+JSON.stringify(report).slice(0,5500),headSha,baseSha};
 }catch(error){
  const message=errorText(error);
  await pool.query("UPDATE quality_gate_runs SET status='failed',verdict='blocked',message=$2,completed_at=now() WHERE id=$1",[id,message]);
  await logEvent(pool,ctx.projectId,id,kind,'failed',message,'error');
  await publishStatus(pool,{...statusArgs,state:'error',description:message});
  return {passed:false,kind,message:'Сбой проверки: '+message,headSha,baseSha};
 }
}

export async function runQualityGates(pool:Pool,ctx:GateContext,decrypt:(secret:string)=>string,runnerUrl:string,runnerKey:string,onHeartbeat:()=>void=()=>{}){
 const settings=await readPr(pool,decrypt,ctx.projectId,ctx.taskId);
 for(const kind of ['ci','review'] as const){
  const result=await gate(pool,ctx,kind,settings,decrypt,runnerUrl,runnerKey,onHeartbeat);
  if(!result.passed)return result;
 }
 return {passed:true,kind:'review' as const,message:'Собственный CI и архитектурное ревью подтверждены',headSha:settings.headSha,baseSha:settings.baseSha};
}

/** Do not accept quality reports from a previous PR commit or previous base. */
export async function requireQualityGates(pool:Pick<Pool,'query'>,projectId:string,taskId:string,headSha:string,baseSha:string){
 const result=await pool.query(`SELECT DISTINCT ON (kind) kind,status,verdict FROM quality_gate_runs
  WHERE project_id=$1 AND task_id=$2 AND head_sha=$3 AND base_sha=$4
  AND kind IN ('ci','review') ORDER BY kind,started_at DESC,id DESC`,[projectId,taskId,headSha,baseSha]);
 const passed=new Set(result.rows.filter(r=>r.status==='completed'&&r.verdict==='passed').map(r=>r.kind));
 if(!passed.has('ci')||!passed.has('review'))
  throw Object.assign(new Error('Нет успешного собственного CI и ревью архитектора для текущего SHA/base. Повторите проверку качества перед слиянием.'),{statusCode:409});
}

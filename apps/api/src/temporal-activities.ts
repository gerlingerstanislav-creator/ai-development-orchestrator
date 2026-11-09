import pg from 'pg';
import {randomUUID,createDecipheriv} from 'node:crypto';
import {ApplicationFailure} from '@temporalio/common';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const codexUrl=process.env.CODEX_RUNNER_URL||'http://codex:4300';
const runnerKey=process.env.RUNNER_SHARED_SECRET||'';

function decrypt(packed:string):string{
 const key=Buffer.from(process.env.CREDENTIALS_KEY||'','hex');
 if(key.length!==32)throw Error('CREDENTIALS_KEY must contain 32 bytes');
 const bytes=Buffer.from(packed,'base64');
 const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 d.setAuthTag(bytes.subarray(12,28));
 return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');
}
async function runner(path:string,method:'GET'|'POST'='GET',body?:unknown):Promise<any>{
 const response=await fetch(codexUrl+path,{method,headers:{'X-Runner-Secret':runnerKey,'Content-Type':'application/json'},
  body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const data=await response.json().catch(()=>({})) as any;
 if(!response.ok){
  const error=Object.assign(new Error(String(data.error||'Codex runner error')),{statusCode:response.status});
  throw error;
 }
 return data;
}
async function event(projectId:string,processId:string,kind:string,stage:string,detail:string,level='info'){
 await pool.query('INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [randomUUID(),projectId,processId,kind,stage,detail.slice(0,2200),level]);
}
type TaskRef={projectId:string;taskId:string;runId:string;attempt?:number};
async function jobSettings(projectId:string,taskId:string){
 const [task,repo,settings,rules]=await Promise.all([
  pool.query('SELECT * FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]),
  pool.query("SELECT g.repository,g.default_branch,g.target_branch,c.secret_encrypted FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.provider='github_token'",[projectId]),
  pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]),
  pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 60',[projectId])
 ]);
 if(!task.rowCount||!repo.rowCount||!settings.rowCount||!settings.rows[0].enabled)
  throw ApplicationFailure.nonRetryable('Задача, подключение GitHub или настройки AI недоступны');
 const t=task.rows[0],g=repo.rows[0],ai=settings.rows[0];
 return {task:t,repo:g,ai,token:decrypt(g.secret_encrypted),rules:rules.rows.map(x=>x.body).join('\n').slice(0,12000)};
}
async function dispatch(job:any){
 try{
  await runner('/jobs/'+job.id);
  return; // A Temporal activity retry must not create a duplicate Codex job.
 }catch(e){
  if((e as any).statusCode!==404)throw e;
 }
 try{await runner('/jobs','POST',job);}
 catch(e){if((e as any).statusCode!==409)throw e;}
}

export async function startDevelopment(args:TaskRef){
 const {projectId,taskId,runId,attempt=0}=args;
 const {task,repo,ai,token,rules}=await jobSettings(projectId,taskId);
 const record=await pool.query('SELECT status FROM ai_task_runs WHERE id=$1 AND project_id=$2',[runId,projectId]);
 if(!record.rowCount)throw ApplicationFailure.nonRetryable('Запуск разработки отсутствует');
 if(['completed','failed'].includes(record.rows[0].status))return;
 const baseBranch=task.pr_base_branch||repo.target_branch||repo.default_branch;
 const feedback=String(task.test_feedback||'').slice(0,10000);
 const description=String(task.description||'').slice(0,14000)+(feedback?'\n\nОБЯЗАТЕЛЬНЫЕ ИСПРАВЛЕНИЯ ПО РЕЗУЛЬТАТАМ ТЕСТИРОВАНИЯ:\n'+feedback:'');
 const job={id:runId,taskId,repository:repo.repository,baseBranch,token,
  model:ai.model,reasoning:ai.reasoning,maxRuntimeSeconds:1800,
  title:task.title,description,projectRules:rules,relatedTasks:[]};
 await dispatch(job);
 await pool.query("UPDATE ai_task_runs SET status='running',message=$2 WHERE id=$1 AND status='queued'",
  [runId,attempt?'Исправление дефектов после тестирования':'Разработка через Temporal']);
 await event(projectId,runId,'development','started',attempt?'Повторная разработка после дефектов':'Запуск разработки через Temporal');
}
export async function checkDevelopment(args:TaskRef):Promise<{status:string;message:string}>{
 const {projectId,taskId,runId}=args;
 const run=await pool.query('SELECT status,message,model FROM ai_task_runs WHERE id=$1 AND project_id=$2',[runId,projectId]);
 if(!run.rowCount)throw ApplicationFailure.nonRetryable('Запуск разработки не найден');
 if(['completed','failed'].includes(run.rows[0].status))return {status:run.rows[0].status,message:run.rows[0].message};
 let remote:any;
 try{remote=await runner('/jobs/'+runId);}
 catch(e){
  if((e as any).statusCode===404){
   const reason='Исполнитель Codex потерял задачу после перезапуска; автоматическое продолжение требует нового запуска';
   await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,reason]);
   await event(projectId,runId,'development','failed',reason,'error');
   return {status:'failed',message:reason};
  }
  throw e;
 }
 const status=String(remote.status||'running'),message=String(remote.message||'').slice(0,3000);
 if(message!==run.rows[0].message){
  await pool.query('UPDATE ai_task_runs SET status=$2,message=$3 WHERE id=$1',[runId,status,message]);
  await event(projectId,runId,'development',status,message,status==='failed'?'error':'info');
 }
 if(status==='completed'||status==='failed'){
  if(status==='completed'&&!remote.prUrl){
   const msg='Разработка завершилась без PR; передавать в тестирование нечего';
   await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,msg]);
   return {status:'failed',message:msg};
  }
  await pool.query('UPDATE ai_task_runs SET status=$2,message=$3,branch=$4,pr_url=$5,completed_at=now() WHERE id=$1',
   [runId,status,message,remote.branch||null,remote.prUrl||null]);
  if(remote.usage){
   const u=remote.usage;
   await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,'development',$5,$6,$7,$8) ON CONFLICT(source_id) DO NOTHING",
    [randomUUID(),projectId,taskId,runId,run.rows[0].model,Number(u.input_tokens)||0,Number(u.cached_input_tokens)||0,Number(u.output_tokens)||0]);
  }
  if(status==='completed'){
   const match=/\/pull\/(\d+)$/.exec(String(remote.prUrl));
   await pool.query("UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$5,updated_at=now() WHERE id=$1 AND project_id=$6",
    [taskId,remote.branch||taskId,remote.prUrl,match?Number(match[1]):null,remote.baseBranch||null,projectId]);
   await event(projectId,runId,'development','testing','Разработка завершена. Передача отдельному AI-тестировщику.');
  }
 }
 return {status,message};
}
export async function startTesting(args:{projectId:string;taskId:string;cycleId:string;attempt:number}):Promise<string>{
 const {projectId,taskId,cycleId,attempt}=args;
 const {task,repo,ai,token,rules}=await jobSettings(projectId,taskId);
 const existing=await pool.query('SELECT id,status FROM ai_test_runs WHERE cycle_id=$1 AND attempt=$2',[cycleId,attempt]);
 const testId=existing.rowCount?existing.rows[0].id:randomUUID();
 if(!existing.rowCount){
  await pool.query("INSERT INTO ai_test_runs(id,project_id,task_id,cycle_id,attempt,status,message) VALUES($1,$2,$3,$4,$5,'queued','Ожидает запуска проверки') ON CONFLICT(cycle_id,attempt) DO NOTHING",
   [testId,projectId,taskId,cycleId,attempt]);
 }
 const record=await pool.query('SELECT id,status FROM ai_test_runs WHERE cycle_id=$1 AND attempt=$2',[cycleId,attempt]);
 const id=record.rows[0].id;
 if(['completed','failed'].includes(record.rows[0].status))return id;
 if(!task.pr_url||!task.git_branch)throw ApplicationFailure.nonRetryable('Нет PR или ветки для тестирования');
 await dispatch({id,kind:'test',taskId,repository:repo.repository,baseBranch:task.pr_base_branch||repo.target_branch||repo.default_branch,
  token,model:ai.model,reasoning:ai.reasoning,maxRuntimeSeconds:900,
  title:task.title,description:task.description,projectRules:rules});
 await pool.query("UPDATE ai_test_runs SET status='running',message='AI-тестировщик проверяет изменения' WHERE id=$1",[id]);
 await event(projectId,id,'testing','started','Тестирование в отдельной рабочей копии репозитория');
 return id;
}
export async function checkTesting(args:{projectId:string;taskId:string;testId:string}):Promise<{status:string;message:string;verdict?:string}>{
 const {projectId,testId}=args;
 const row=await pool.query('SELECT status,message,task_id FROM ai_test_runs WHERE id=$1 AND project_id=$2',[testId,projectId]);
 if(!row.rowCount)throw ApplicationFailure.nonRetryable('Запуск тестирования не найден');
 if(['completed','failed'].includes(row.rows[0].status)){
  const old=await pool.query('SELECT verdict FROM ai_test_runs WHERE id=$1',[testId]);
  return {status:row.rows[0].status,message:row.rows[0].message,verdict:old.rows[0]?.verdict};
 }
 let remote;
 try{remote=await runner('/jobs/'+testId);}
 catch(e){
  if((e as any).statusCode===404){
   const message='Потерян процесс тестирования после перезапуска исполнителя';
   await pool.query("UPDATE ai_test_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[testId,message]);
   await event(projectId,testId,'testing','failed',message,'error');
   return {status:'failed',message};
  }throw e;
 }
 const status=String(remote.status||'running'),message=String(remote.message||'').slice(0,2500);
 if(status==='completed'||status==='failed'){
  const verdict=status==='failed'?'blocked':String(remote.verdict||'blocked');
  const report={summary:remote.summary||message,findings:remote.findings||[],checks:remote.checks||[],commit:remote.testedCommit||null};
  await pool.query('UPDATE ai_test_runs SET status=$2,message=$3,verdict=$4,report=$5,completed_at=now() WHERE id=$1',
   [testId,status,message,verdict,JSON.stringify(report)]);
  await event(projectId,testId,'testing',verdict,JSON.stringify(report).slice(0,2200),verdict==='passed'?'info':verdict==='failed'?'error':'warning');
  return {status,message,verdict};
 }
 if(message!==row.rows[0].message)await pool.query('UPDATE ai_test_runs SET status=$2,message=$3 WHERE id=$1',[testId,status,message]);
 return {status,message};
}
export async function approveTestedTask(args:{projectId:string;taskId:string;testId:string}){
 const {projectId,taskId,testId}=args;
 await pool.query("UPDATE tasks SET stage='merge_queue',test_feedback='',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing'",
  [taskId,projectId]);
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),taskId,'tests_passed','Проверки завершены, PR готов к слиянию']);
 await event(projectId,testId,'testing','approved','Тесты пройдены. PR отправлен в очередь слияния');
}
export async function rejectTestedTask(args:{projectId:string;taskId:string;cycleId:string;testId:string;attempt:number;allowFix:boolean}):Promise<string|null>{
 const {projectId,taskId,cycleId,testId,attempt,allowFix}=args;
 const test=await pool.query('SELECT report FROM ai_test_runs WHERE id=$1',[testId]);
 const report=test.rows[0]?.report||{};
 const feedback=JSON.stringify(report).slice(0,10000);
 await pool.query("UPDATE tasks SET stage='development',test_feedback=$3,test_attempts=$4,updated_at=now() WHERE id=$1 AND project_id=$2",
  [taskId,projectId,feedback,attempt+1]);
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),taskId,'tests_failed',('Тестировщик вернул в разработку: '+feedback).slice(0,2400)]);
 await event(projectId,testId,'testing',allowFix?'retry_development':'needs_attention',
  allowFix?'Дефекты переданы разработчику. Автоматическое исправление '+(attempt+1):'Лимит автоматических исправлений исчерпан',allowFix?'warning':'error');
 if(!allowFix)return null;
 const old=await pool.query('SELECT id FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2',[cycleId,attempt+1]);
 if(old.rowCount)return old.rows[0].id;
 const settings=await pool.query('SELECT model FROM project_ai_settings WHERE project_id=$1',[projectId]);
 const initial=await pool.query('SELECT triggered_by FROM ai_task_runs WHERE id=$1',[cycleId]);
 const id=randomUUID();
 await pool.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status,cycle_id,cycle_attempt) VALUES($1,$2,$3,$4,$5,'queued',$6,$7) ON CONFLICT(cycle_id,cycle_attempt) DO NOTHING",
  [id,projectId,taskId,initial.rows[0].triggered_by,settings.rows[0].model,cycleId,attempt+1]);
 const saved=await pool.query('SELECT id FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2',[cycleId,attempt+1]);
 return saved.rows[0].id;
}
export async function noteCycleFailure(args:{projectId:string;taskId:string;message:string;stage:string}){
 await pool.query("UPDATE tasks SET stage='development',test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND stage IN ('development','testing')",
  [args.taskId,args.projectId,args.message.slice(0,3000)]);
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),args.taskId,'pipeline_failed',(args.stage+': '+args.message).slice(0,2400)]);
}

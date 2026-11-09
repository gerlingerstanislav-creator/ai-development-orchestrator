import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';

const unavailableReasons=new Set(['tool_unavailable','environment_unavailable','manual_only']);
type TestCase={id:string;title:string;priority?:string;purpose?:string};
type TestResult={case_id:string;result:string;evidence?:string;reason?:string};
type TestCheck={name?:string;result?:string;details?:string};
export type QaRunRow={id:string;status:string;verdict:string|null;qa_spec_version:number|null;qa_plan_snapshot:any;report:any;task_id:string};

export function qaWaiverAssessment(run:QaRunRow|null|undefined){
 const blockers:string[]=[];
 const cases:Array<TestCase>=Array.isArray(run?.qa_plan_snapshot?.cases)?run.qa_plan_snapshot.cases:[];
 const results:Array<TestResult>=Array.isArray(run?.report?.caseResults)?run.report.caseResults:[];
 const checks:Array<TestCheck>=Array.isArray(run?.report?.checks)?run.report.checks:[];
 const findings=Array.isArray(run?.report?.findings)?run.report.findings:[];
 const byId=new Map(results.filter(r=>r&&typeof r.case_id==='string').map(r=>[r.case_id,r]));
 const unverified:Array<{id:string;title:string;priority:string;reason:string;evidence:string}>=[];
 let passed=0;
 if(!run||run.status!=='completed'||run.verdict!=='blocked')blockers.push('Нет завершённого QA-прогона с результатом «проверка недоступна».');
 if(!/^[0-9a-f]{40}$/i.test(String(run?.report?.commit||'')))blockers.push('Не подтверждён SHA проверенной ветки.');
 if(!Number.isInteger(Number(run?.qa_spec_version))||Number(run?.qa_spec_version)<1)blockers.push('Не установлена версия технического задания.');
 if(!cases.length)blockers.push('Отсутствует зафиксированный тест-план.');
 if(!Array.isArray(run?.report?.checks))blockers.push('Нет отчёта о доступных автоматических проверках.');
 if(findings.length)blockers.push('Обнаружены дефекты. Согласование непроверенных сценариев их не отменяет.');
 if(checks.some(c=>c.result==='failed'))blockers.push('Есть упавшие автоматические проверки.');
 if(results.some(r=>r?.result==='failed'))blockers.push('Есть тест-кейсы с обнаруженными ошибками.');
 for(const c of cases){
  const result=byId.get(c.id);
  if(result?.result==='passed'){
   if(String(result.evidence||'').trim().length<10)blockers.push('Недостаточно доказательств прохождения сценария «'+c.title+'».');
   passed++;continue;
  }
  if(result?.result!=='blocked'&&result?.result!=='not_run'){
   blockers.push('Для сценария «'+c.title+'» нет корректного результата.');continue;
  }
  const reason=String(result.reason||'');
  const evidence=String(result.evidence||'').trim();
  if(!unavailableReasons.has(reason)||evidence.length<15)
   blockers.push('Для сценария «'+c.title+'» отсутствует подтверждение нехватки средств тестирования.');
  unverified.push({id:c.id,title:c.title,priority:String(c.priority||'normal'),reason,evidence});
 }
 if(!unverified.length)blockers.push('Нет сценариев, которые необходимо явно исключить из проверки.');
 return {eligible:blockers.length===0,blockers,passed,total:cases.length,unverified,checks,
  summary:String(run?.report?.summary||''),capabilities:String(run?.report?.capabilities||''),commit:String(run?.report?.commit||''),spec_version:run?.qa_spec_version??null};
}

type Dependencies={pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>;uid:(req:any)=>string;decryptToken:(ciphertext:string)=>string};
const routeParams=z.object({id:z.string().uuid(),taskId:z.string().uuid()});

export async function initQaWaiverSchema(pool:Pool){
 await pool.query("CREATE TABLE IF NOT EXISTS qa_merge_waivers (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,test_run_id uuid NOT NULL REFERENCES ai_test_runs(id) ON DELETE CASCADE,approved_by uuid NOT NULL REFERENCES users(id),justification text NOT NULL,commit_sha text NOT NULL,spec_version integer NOT NULL,unverified_cases jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,test_run_id))");
 await pool.query('CREATE INDEX IF NOT EXISTS qa_merge_waivers_lookup ON qa_merge_waivers(project_id,task_id,created_at DESC)');
}

export async function latestQaWaiver(pool:Pool,projectId:string,taskId:string){
 const [run,approved]=await Promise.all([
  pool.query('SELECT id,task_id,status,verdict,qa_spec_version,qa_plan_snapshot,report FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1',[projectId,taskId]),
  pool.query('SELECT id,test_run_id,justification,commit_sha,spec_version,approved_by,unverified_cases,created_at FROM qa_merge_waivers WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1',[projectId,taskId])
 ]);
 const current=run.rows[0] as QaRunRow|undefined;
 return {run_id:current?.id||null,assessment:qaWaiverAssessment(current),approval:approved.rows[0]||null};
}

export function registerQaWaiverRoutes(app:FastifyInstance,{pool,access,requireAdmin,uid,decryptToken}:Dependencies){
 app.get('/api/projects/:id/tasks/:taskId/qa-waiver',async(req:any,reply)=>{
  const {id,taskId}=routeParams.parse(req.params);
  if(!await access(req,reply,id))return;
  const found=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
  if(!found.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  return latestQaWaiver(pool,id,taskId);
 });
 app.post('/api/projects/:id/tasks/:taskId/qa-waiver',async(req:any,reply)=>{
  const {id,taskId}=routeParams.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const body=z.object({test_run_id:z.string().uuid(),justification:z.string().trim().min(20).max(3000),acknowledge_unverified:z.literal(true)}).parse(req.body);
  const connection=await pool.query('SELECT t.stage,t.spec_version,t.spec_review_status,t.spec_reviewed_version,t.spec_reviewed_commit,t.pr_number,g.repository,c.secret_encrypted FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 WHERE t.id=$1 AND t.project_id=$2',[taskId,id,uid(req)]);
  if(!connection.rowCount)return reply.code(404).send({error:'Задача или GitHub-подключение не найдены'});
  const task=connection.rows[0];
  if(task.stage!=='testing')return reply.code(409).send({error:'Решение доступно только на этапе тестирования'});
  const latest=await latestQaWaiver(pool,id,taskId);
  if(latest.run_id!==body.test_run_id||!latest.assessment.eligible)
   return reply.code(409).send({error:'В QA-отчёте есть дефекты или отсутствуют подтверждения недоступности тестов',details:latest.assessment.blockers});
  if(task.spec_review_status!=='current'||task.spec_version!==task.spec_reviewed_version||latest.assessment.spec_version!==task.spec_version)
   return reply.code(409).send({error:'ТЗ изменилось после тестирования'});
  const gh=await fetch('https://api.github.com/repos/'+task.repository+'/pulls/'+task.pr_number,{
   headers:{Authorization:'Bearer '+decryptToken(task.secret_encrypted),Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(15000)
  });
  if(!gh.ok)return reply.code(502).send({error:'Не удалось проверить PR в GitHub: HTTP '+gh.status});
  const pr=await gh.json() as any;
  if(pr.state!=='open'||pr.head?.sha!==latest.assessment.commit||task.spec_reviewed_commit!==pr.head.sha)
   return reply.code(409).send({error:'PR изменился после QA или аналитик проверял другой SHA'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const locked=await client.query('SELECT stage,spec_version,spec_review_status,spec_reviewed_version,spec_reviewed_commit FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
   if(!locked.rowCount||locked.rows[0].stage!=='testing'||locked.rows[0].spec_version!==task.spec_version||locked.rows[0].spec_review_status!=='current'||locked.rows[0].spec_reviewed_version!==task.spec_version||locked.rows[0].spec_reviewed_commit!==pr.head.sha){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Состояние задачи изменилось, повтори проверку'});
   }
   const last=await client.query('SELECT id,task_id,status,verdict,qa_spec_version,qa_plan_snapshot,report FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1',[id,taskId]);
   const current=last.rows[0] as QaRunRow|undefined;
   const assessment=qaWaiverAssessment(current);
   if(!current||current.id!==body.test_run_id||current.qa_spec_version!==task.spec_version||!assessment.eligible||assessment.commit!==pr.head.sha){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Результат QA изменился. Согласование недействительно'});
   }
   const waiverId=randomUUID();
   await client.query('INSERT INTO qa_merge_waivers(id,project_id,task_id,test_run_id,approved_by,justification,commit_sha,spec_version,unverified_cases) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[waiverId,id,taskId,body.test_run_id,uid(req),body.justification,assessment.commit,task.spec_version,JSON.stringify(assessment.unverified)]);
   await client.query("UPDATE tasks SET stage='merge_queue',test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,id,'Слияние с непроверенными сценариями: '+assessment.unverified.map(c=>c.title).join('; ').slice(0,1200)]);
   await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'qa_waiver_approved',('Проверено '+assessment.passed+'/'+assessment.total+'; пропущено '+assessment.unverified.length+'. Основание: '+body.justification).slice(0,2300)]);
   await client.query('COMMIT');
   return reply.code(201).send({id:waiverId,stage:'merge_queue',unverified:assessment.unverified});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
}

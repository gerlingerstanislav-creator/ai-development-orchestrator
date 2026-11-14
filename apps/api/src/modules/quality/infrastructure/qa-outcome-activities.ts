import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {pendingAgentQuestions} from '../../../task-agent-notes.js';
import {browserEvidenceAssessment} from '../../../task-evidence.js';
import {resolveRoleAiSettings} from '../../../project-team.js';
import {deploymentDecision} from '../../../deployment-stage.js';

type QaJobSettings={
 repo:{repository:string;default_branch:string;target_branch?:string};
 token:string;
 task:{pr_base_branch?:string|null};
};
export type QaOutcomePorts={
 pool:Pool;
 event:(projectId:string,processId:string,kind:string,stage:string,detail:string,level?:string)=>Promise<void>;
 jobSettings:(projectId:string,taskId:string)=>Promise<QaJobSettings>;
 nonRetryable:(message:string)=>Error;
 http?:typeof fetch;
};

/** QA is independently verified before task/PR transitions.
 * Temporal's exported Activity names remain stable; immutable SHA and project
 * ownership checks are enforced here, outside workflow deterministic code.
 */
export function createQaOutcomeActivities({pool,event,jobSettings,nonRetryable,http=fetch}:QaOutcomePorts){
export async function approveTestedTask(args:{projectId:string;taskId:string;testId:string;simplified?:boolean}){
 if(!args.simplified&&await pendingAgentQuestions(pool,args.projectId,args.taskId))throw nonRetryable('QA нашёл открытый вопрос. Ответь до перехода к слиянию');
 const {projectId,taskId,testId}=args;
 const verified=await pool.query(`SELECT t.implementation_kind,t.implementation_commit,t.execution_mode,t.evidence_source_sha,r.report
  FROM ai_test_runs r JOIN tasks t ON t.id=r.task_id
  WHERE r.id=$1 AND r.project_id=$2 AND r.task_id=$3 AND r.status='completed'
   AND r.verdict='passed' AND r.report->>'commit' IS NOT NULL
   AND r.qa_spec_version=t.spec_version`,[testId,projectId,taskId]);
 if(!verified.rowCount)throw nonRetryable('Нет успешного независимого QA для текущей версии требований');
 const result=verified.rows[0];
 if(result.execution_mode==='browser_evidence'&&result.implementation_kind==='artifact'){
  const proof=browserEvidenceAssessment(result.report,result.evidence_source_sha);
  if(!proof.passed)throw nonRetryable('Отсутствуют подлинные артефакты: '+proof.reason);
  const updated=await pool.query(`UPDATE tasks SET stage='done',test_feedback='',updated_at=now()
   WHERE id=$1 AND project_id=$2 AND stage='testing'
    AND execution_mode='browser_evidence' AND implementation_kind='artifact'
    AND evidence_source_sha=$3 AND spec_version=$4 RETURNING id`,
   [taskId,projectId,result.evidence_source_sha,result.report.spec_version]);
  if(!updated.rowCount)throw nonRetryable('Задача или исходный SHA изменились после проверки');
  await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'evidence_verified',$3)",
   [randomUUID(),taskId,'Фактические desktop/mobile скриншоты получены и проверены на SHA '+result.evidence_source_sha+'. PR, merge и деплой пропущены как неприменимые.']);
  await event(projectId,testId,'testing','evidence_verified','Сохранены и проверены реальные артефакты без изменения кода');
  return;
 }
 if(result.implementation_kind==='already_implemented'){
  const sha=String(result.implementation_commit||'');
  const report=result.report||{};
  if(!/^[a-f0-9]{40}$/i.test(sha)||report.commit!==sha||report.executionVerified!==true||
   !Array.isArray(report.caseResults)||!report.caseResults.length||report.caseResults.some((c:any)=>c.result!=='passed'))
   throw nonRetryable('Нужен полностью подтверждённый QA существующей реализации на закреплённом SHA');
  const {repo,token,task}=await jobSettings(projectId,taskId);
  const base=task.pr_base_branch||repo.target_branch||repo.default_branch;
  const response=await http('https://api.github.com/repos/'+repo.repository+'/branches/'+encodeURIComponent(base),{
   headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(20000)
  });
  if(!response.ok)throw Error('Не удалось перепроверить SHA целевой ветки после QA: GitHub HTTP '+response.status);
  const current=await response.json() as {commit?:{sha?:string}};
  if(current.commit?.sha!==sha)throw nonRetryable('Целевая ветка изменилась во время QA: требуется повторная проверка');
  const client=await pool.connect();
  let decision:{stage:'documentation'|'deployment';status:'skipped'|'pending';reason:string};
  try{
   await client.query('BEGIN');
   const project=await client.query('SELECT owner_id FROM projects WHERE id=$1',[projectId]);
   const mode=await client.query('SELECT mode FROM project_deployment_settings WHERE project_id=$1',[projectId]);
   decision=deploymentDecision(mode.rows[0]?.mode||'skip');
   const updated=await client.query("UPDATE tasks SET stage=$4,test_feedback='',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing' AND implementation_kind='already_implemented' AND implementation_commit=$3 RETURNING id",
    [taskId,projectId,sha,decision.stage]);
   if(!updated.rowCount)throw nonRetryable('Задача изменилась после QA');
   await client.query(`INSERT INTO task_deployment_records(task_id,project_id,status,reason,merge_sha,actor_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id) DO UPDATE SET status=EXCLUDED.status,
    reason=EXCLUDED.reason,merge_sha=EXCLUDED.merge_sha,actor_id=EXCLUDED.actor_id,updated_at=now()`,
    [taskId,projectId,decision.status,decision.reason,sha,project.rows[0]?.owner_id||null]);
   await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'existing_implementation_verified',$3)",
    [randomUUID(),taskId,'QA подтвердил, что требуемый код уже есть в базовой ветке на SHA '+sha+'. Новый PR не нужен.']);
   await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)",
    [randomUUID(),taskId,decision.status==='skipped'?'deployment_skipped':'deployment_pending',decision.reason]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await event(projectId,testId,'testing','already_implemented_verified','QA подтвердил исходную реализацию на '+sha+'. Дальнейший этап: '+decision!.stage);
  return;
 }
 const moved=await pool.query("UPDATE tasks SET stage='merge_queue',test_feedback='',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='testing' RETURNING id",
  [taskId,projectId]);
 if(!moved.rowCount)throw nonRetryable('Задача изменилась после успешного QA; переход к слиянию отменён');
 await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',
  [randomUUID(),taskId,'tests_passed','Проверки завершены, PR готов к слиянию']);
 await event(projectId,testId,'testing','approved','Тесты пройдены. PR отправлен в очередь слияния');
}
export async function rejectTestedTask(args:{projectId:string;taskId:string;cycleId:string;testId:string;attempt:number;allowFix:boolean}):Promise<string|null>{
 const {projectId,taskId,cycleId,testId,attempt,allowFix}=args;
 const test=await pool.query("SELECT report FROM ai_test_runs WHERE id=$1 AND project_id=$2 AND task_id=$3 AND status='completed' AND verdict='failed'",
  [testId,projectId,taskId]);
 if(!test.rowCount)throw nonRetryable('Нет завершённого неуспешного QA-прогона этой задачи');
 const report=test.rows[0].report||{};
 const feedback=JSON.stringify(report).slice(0,10000);
 const lastDeveloper=await pool.query(
  "SELECT result_kind,result_commit FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2 AND project_id=$3 AND task_id=$4 ORDER BY created_at DESC LIMIT 1",
  [cycleId,attempt,projectId,taskId]);
 const unchanged=lastDeveloper.rows[0];
 if(unchanged?.result_kind==='no_changes_needed'&&unchanged.result_commit&&unchanged.result_commit===report.commit){
  // The developer has explicitly disputed the prior QA feedback without
  // changing this SHA. Another identical automatic developer cycle will not
  // resolve the contradiction: keep QA's failed verdict and ask PM to decide
  // whether tests, requirements or implementation need attention.
  const detail=('QA нашёл дефекты после подтверждения разработчиком отсутствия необходимых правок на SHA '+
   report.commit+'. Повторная автоматическая разработка остановлена; ПМ должен разобрать расхождение с QA. '+feedback).slice(0,2400);
  await pool.query("UPDATE tasks SET stage='testing',test_feedback=$3,updated_at=now() WHERE id=$1 AND project_id=$2",
   [taskId,projectId,detail]);
  await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'qa_dev_disagreement',$3)",
   [randomUUID(),taskId,detail]);
  await event(projectId,testId,'testing','needs_attention',detail,'warning');
  return null;
 }
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
  [id,projectId,taskId,initial.rows[0].triggered_by,(await resolveRoleAiSettings(pool,projectId,'development',{...settings.rows[0],reasoning:'low'})).model,cycleId,attempt+1]);
 const saved=await pool.query('SELECT id FROM ai_task_runs WHERE cycle_id=$1 AND cycle_attempt=$2',[cycleId,attempt+1]);
 return saved.rows[0].id;
}
 return {approveTestedTask,rejectTestedTask};
}

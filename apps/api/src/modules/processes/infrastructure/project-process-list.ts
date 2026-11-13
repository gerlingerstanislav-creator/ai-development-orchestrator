import type {Pool} from 'pg';
import {readDevelopmentQueue} from '../../../agent-work-scheduler.js';

/** PostgreSQL-backed, read-only project process history projection. Caller verifies membership. */
export async function listProjectProcesses(pool:Pool,id:string){
 const [imports,developments,tests,merges,analyses,iterationRuns,deployments,queuedTasks,peerQuestions,pmOrders,taskAnalyses,evidenceRuns,workAssignments]=await Promise.all([
  pool.query("SELECT j.id,j.status,j.message,j.source_url,j.request_text,j.source_file_count,j.analyzed_chunks,j.total_chunks,j.saved_documents,j.created_at,j.updated_at,j.result,j.draft_result IS NOT NULL AS has_draft,(SELECT count(*)::int FROM document_import_topics tp WHERE tp.job_id=j.id) AS topic_total,(SELECT count(*)::int FROM document_import_topics tp WHERE tp.job_id=j.id AND tp.status IN ('complete','conflict')) AS topic_completed FROM document_import_jobs j WHERE j.project_id=$1 ORDER BY j.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT r.id,r.task_id,r.status,r.message,r.model,r.created_at,r.completed_at,t.title AS task_title,t.display_number,r.pr_url FROM ai_task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT t.id,t.task_id,t.status,t.message,t.verdict,t.report,t.attempt,t.created_at,t.completed_at,k.title AS task_title,k.display_number FROM ai_test_runs t JOIN tasks k ON k.id=t.task_id WHERE t.project_id=$1 ORDER BY t.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT id,status,message,created_at,finished_at,results FROM merge_process_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 70",[id]),
  pool.query("SELECT r.id,r.task_id,r.status,r.message,r.created_at,r.completed_at,r.spec_version,t.display_number,t.title AS task_title FROM requirement_review_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  pool.query(`SELECT r.id,r.status,r.message,r.created_at,r.updated_at,r.plan_id,i.id AS iteration_id,i.title
   FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id
   WHERE i.project_id=$1 ORDER BY r.created_at DESC LIMIT 70`,[id]),
  pool.query("SELECT r.id,r.status,r.message,r.sha,r.github_url,r.task_id,r.created_at,r.updated_at,t.title,t.display_number FROM deployment_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  readDevelopmentQueue(pool,id),
  pool.query("SELECT q.note_id AS id,q.task_id,q.role,q.status,q.error AS detail,q.updated_at,n.body,t.display_number FROM agent_peer_queue q JOIN task_agent_notes n ON n.id=q.note_id JOIN tasks t ON t.id=q.task_id WHERE q.project_id=$1 AND q.status IN ('queued','running','waiting','failed') ORDER BY q.updated_at DESC LIMIT 60",[id]),
  pool.query("SELECT id,status,summary AS detail,updated_at,created_at FROM project_pm_orders WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 40",[id]),
  pool.query("SELECT r.id,r.task_id,r.status,r.message,r.created_at,r.updated_at,t.title,t.display_number FROM agent_analysis_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT r.id,r.task_id,r.status,r.message,r.source_sha,r.created_at,r.updated_at,t.title,t.display_number FROM task_evidence_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT a.id,a.task_id,a.source_role,a.role,a.objective,a.acceptance,a.status,a.result,a.evidence,a.reviewer_note,a.created_at,a.updated_at,t.title,t.display_number FROM agent_work_assignments a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id WHERE a.project_id=$1 ORDER BY a.created_at DESC LIMIT 100",[id])
 ]);
 const qualityGateHistory=await pool.query(
  "SELECT g.id,g.kind,g.task_id,g.head_sha,g.base_sha,g.status,g.verdict,g.report,g.message,g.started_at,g.completed_at,t.title,t.display_number FROM quality_gate_runs g JOIN tasks t ON t.id=g.task_id WHERE g.project_id=$1 ORDER BY g.started_at DESC LIMIT 70",[id]);
 const promptRecords=await pool.query(
  'SELECT * FROM (SELECT DISTINCT ON (process_id) process_id AS id,role,operation,created_at FROM agent_prompt_audit WHERE project_id=$1 ORDER BY process_id,created_at DESC) entries ORDER BY created_at DESC LIMIT 50',
  [id]);
 const processes:any[]=[
  ...qualityGateHistory.rows.map((r:any)=>({id:r.id,kind:r.kind,title:(r.kind==='ci'?'Собственный CI':'Ревью архитектора')+' #'+r.display_number+' · '+r.title,
   status:r.status,detail:r.message,createdAt:r.started_at,updatedAt:r.completed_at,taskId:r.task_id,
   result:{message:r.message,verdict:r.verdict,commit:r.head_sha,base:r.base_sha,...r.report}})),
  ...deployments.rows.map((r:any)=>({id:r.id,kind:'deployment',title:'Выкладка #'+r.display_number+' · '+r.title,
   status:r.status,detail:r.message,createdAt:r.created_at,updatedAt:r.updated_at,taskId:r.task_id,
   result:{message:r.message,sha:r.sha,github_url:r.github_url}})),
  ...iterationRuns.rows.map(row=>({id:row.id,kind:'analysis',title:'План задач · '+row.title,status:row.status,
   detail:row.message,createdAt:row.created_at,updatedAt:row.updated_at,iterationId:row.iteration_id,result:{message:row.message}})),
  ...imports.rows.map((r:any)=>({id:r.id,kind:'document_import',title:(r.source_url?'Анализ материалов · '+r.source_url.split('/').slice(-1)[0]:'Подготовка ТЗ'),status:r.status,detail:r.message,createdAt:r.created_at,updatedAt:r.updated_at,sourceUrl:r.source_url,requestText:r.request_text,progress:{completed:r.analyzed_chunks,total:r.total_chunks},topicProgress:{completed:r.topic_completed,total:r.topic_total},result:r.result,savedDocuments:r.saved_documents,hasDraft:r.has_draft,sourceFileCount:r.source_file_count})),
  ...developments.rows.map((r:any)=>({id:r.id,kind:'development',title:'Разработка #'+r.display_number+' · '+r.task_title,status:r.status,detail:queuedTasks.find(row=>row.run_id===r.id)?.detail||r.message,createdAt:r.created_at,updatedAt:r.completed_at,taskId:r.task_id,result:r.pr_url?{prUrl:r.pr_url}:null}))
 ];
 for(const row of workAssignments.rows){
  processes.push({id:row.id,kind:'agent',title:'Поручение '+row.role+' #'+row.display_number+' · '+row.title,
   status:row.status,detail:row.status==='queued'||row.status==='running'?row.objective:row.result||row.objective,
   createdAt:row.created_at,updatedAt:row.updated_at,taskId:row.task_id,
   result:{message:row.result||'Ожидается подтверждённый результат',role:row.role,
    sourceRole:row.source_role,acceptance:row.acceptance,evidence:row.evidence,
    reviewerNote:row.reviewer_note}});
 }
 for(const row of evidenceRuns.rows){
  processes.push({id:row.id,kind:'testing',title:'Браузерные артефакты #'+row.display_number+' · '+row.title,
   status:row.status==='dispatching'?'queued':row.status,detail:row.message||'Подготовка настоящих скриншотов',
   createdAt:row.created_at,updatedAt:row.updated_at,taskId:row.task_id,result:{sha:row.source_sha,message:row.message}});
 }
 for(const row of tests.rows){
  processes.push({id:row.id,kind:'testing',title:'Тестирование #'+row.display_number+' · '+row.task_title,
   status:row.status,detail:row.message,createdAt:row.created_at,updatedAt:row.completed_at,taskId:row.task_id,
   result:row.report?{message:row.report.summary,verdict:row.verdict,findings:row.report.findings,checks:row.report.checks,commit:row.report.commit}:null});
 }
 for(const row of taskAnalyses.rows){
  processes.push({id:row.id,kind:'analysis',title:'Анализ задачи #'+row.display_number+' · '+row.title,status:row.status,detail:row.message||'Системный аналитик обрабатывает задачу',createdAt:row.created_at,updatedAt:row.updated_at,taskId:row.task_id,result:{message:row.message}});
 }
 for(const row of analyses.rows){
  if(developments.rows.some((dev:any)=>dev.id===row.id))continue; // Reconciliation is already recorded in the development process events.
  processes.push({id:row.id,kind:'analysis',title:'Сверка ТЗ #'+row.display_number+' · '+row.task_title,status:row.status,
   detail:row.message,createdAt:row.created_at,updatedAt:row.completed_at,taskId:row.task_id,result:{message:row.message}});
 }
 for(const row of queuedTasks){
  if(developments.rows.some(run=>run.id===row.run_id))continue;
  processes.push({id:row.run_id||row.task_id,kind:'development',title:'Очередь разработки #'+row.display_number+' · '+row.title,
   status:row.status==='dispatching'?'running':row.status,detail:row.detail,createdAt:row.created_at,updatedAt:row.updated_at,taskId:row.task_id});
 }
 for(const row of peerQuestions.rows){
  processes.push({id:row.id,kind:'analysis',title:'Вопрос специалисту · задача #'+row.display_number,status:row.status,detail:row.detail||row.body,createdAt:row.updated_at,updatedAt:row.updated_at,taskId:row.task_id});
 }
 for(const row of pmOrders.rows){
  processes.push({id:row.id,kind:'analysis',title:row.status==='waiting_user'?'ПМ · нужен твой ответ в чате':row.status==='waiting_agents'?'ПМ · ожидает команду':'Поручение ПМ',status:row.status==='working'?'running':row.status==='queued'?'queued':['completed','failed'].includes(row.status)?row.status:'waiting',detail:row.detail,createdAt:row.created_at,updatedAt:row.updated_at});
 }
 for(const row of merges.rows){
  processes.push({id:row.id,kind:'merge',title:'Слияние готовых PR',status:row.status,detail:row.message,createdAt:row.created_at,updatedAt:row.finished_at,result:{results:row.results}});
 }
 const visibleIds=new Set(processes.map(p=>p.id));
 for(const entry of promptRecords.rows){
  if(visibleIds.has(entry.id))continue;
  processes.push({id:entry.id,kind:'analysis',title:'AI-запрос · '+entry.role,
   status:'logged',detail:'Промпт подготовлен для вызова модели ('+entry.operation+'); результат смотри в соответствующем чате.',
   createdAt:entry.created_at,updatedAt:entry.created_at});
 }
 processes.sort((x,y)=>new Date(y.createdAt).getTime()-new Date(x.createdAt).getTime());
 return {processes,checkedAt:new Date().toISOString()};
}

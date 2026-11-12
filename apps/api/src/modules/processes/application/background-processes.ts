/** User-scoped, read-only process-center projection.
 * Database reads remain membership-filtered and never advance tasks.
 */
type Db={query:(sql:string,args?:any[])=>Promise<{rows:any[]}>};
export function developmentProcessDetail(message:string){
 return message.replace('Codex изменяет код','Изменяет код').replace('Codex не создал файлы.','Файлы не изменились.');
}

export type BackgroundProcess={id:string;kind:'development'|'document_import'|'merge'|'testing'|'analysis'|'ci'|'review';role:'development'|'testing'|'analysis'|'analyst'|'platform'|'devops'|'architect';projectId:string;projectName:string;taskId?:string;title:string;detail:string;status:'queued'|'running';createdAt:string;url:string};

export async function listBackgroundProcesses(pool:Db,userId:string){
 const [developments,imports,tests,merges,analyses,iterationRuns,taskAnalyses]=await Promise.all([
  pool.query(`SELECT a.id,a.project_id,p.name AS project_name,a.task_id,t.title AS task_title,t.display_number,a.status,a.message,a.created_at,a.cycle_id
    FROM ai_task_runs a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.project_id=a.project_id AND m.user_id=$1
    JOIN tasks t ON t.id=a.task_id
    WHERE a.status IN ('queued','running')
    ORDER BY a.created_at DESC LIMIT 50`,[userId]),
  pool.query(`SELECT j.id,j.project_id,p.name AS project_name,j.status,j.message,j.created_at
    FROM document_import_jobs j JOIN projects p ON p.id=j.project_id
    JOIN memberships m ON m.project_id=j.project_id AND m.user_id=$1
    WHERE j.status IN ('queued','running') ORDER BY j.created_at DESC LIMIT 50`,[userId]),
  pool.query("SELECT t.id,t.project_id,t.task_id,t.status,t.message,t.created_at,p.name AS project_name FROM ai_test_runs t JOIN projects p ON p.id=t.project_id JOIN memberships m ON m.project_id=p.id AND m.user_id=$1 WHERE t.status IN ('queued','running') ORDER BY t.created_at DESC LIMIT 50",[userId]),
  pool.query("SELECT j.id,j.project_id,j.status,j.message,j.created_at,p.name AS project_name FROM merge_process_runs j JOIN projects p ON p.id=j.project_id JOIN memberships m ON m.project_id=p.id AND m.user_id=$1 WHERE j.status IN ('queued','running') ORDER BY j.created_at DESC LIMIT 50",[userId]),
  pool.query(`SELECT r.id,r.project_id,r.task_id,r.status,r.message,r.created_at,t.title,p.name AS project_name,phase.stage
   FROM requirement_review_runs r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=r.project_id
   JOIN memberships m ON m.project_id=r.project_id AND m.user_id=$1
   LEFT JOIN LATERAL (SELECT e.stage FROM process_events e WHERE e.project_id=r.project_id AND e.process_id=r.id
    AND e.stage IN ('review_started','test_design_started') ORDER BY e.created_at DESC,e.id DESC LIMIT 1) phase ON true
   WHERE r.status IN ('queued','running') ORDER BY r.created_at DESC LIMIT 50`,[userId]),
  pool.query(`SELECT r.id,r.status,r.message,r.created_at,i.id AS iteration_id,i.project_id,i.title,p.name AS project_name
   FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id JOIN projects p ON p.id=i.project_id
   JOIN memberships m ON m.project_id=i.project_id AND m.user_id=$1
   WHERE r.status IN ('queued','running') ORDER BY r.created_at DESC LIMIT 50`,[userId]),
  pool.query(`SELECT a.id,a.project_id,p.name AS project_name,a.task_id,t.display_number,t.title,a.status,a.message,a.created_at
   FROM agent_analysis_runs a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.project_id=a.project_id AND m.user_id=$1
   JOIN tasks t ON t.id=a.task_id WHERE a.status IN ('queued','running') ORDER BY a.created_at DESC LIMIT 50`,[userId])
 ]);
 const qualityGateProcesses=await pool.query(`SELECT g.id,g.project_id,g.task_id,g.kind,g.status,g.message,g.started_at,
  p.name AS project_name,t.title AS task_title,t.display_number
  FROM quality_gate_runs g JOIN projects p ON p.id=g.project_id JOIN memberships m ON m.project_id=g.project_id AND m.user_id=$1
  JOIN tasks t ON t.id=g.task_id WHERE g.status IN ('queued','running')
  ORDER BY g.started_at DESC LIMIT 60`,[userId]);
 const processes:BackgroundProcess[]=[];
 for(const gate of qualityGateProcesses.rows){
  processes.push({id:gate.kind+':'+gate.id,kind:gate.kind==='ci'?'ci':'review',role:gate.kind==='ci'?'devops':'architect',
   projectId:gate.project_id,projectName:gate.project_name,taskId:gate.task_id,
   title:(gate.kind==='ci'?'Собственный CI':'Ревью архитектора')+' #'+gate.display_number+' · '+gate.task_title,
   detail:gate.message||'Проверяется PR',status:gate.status==='queued'?'queued':'running',
   createdAt:gate.started_at,url:'/projects/'+gate.project_id+'/processes?process='+gate.id});
 }
 for(const row of developments.rows){
  // Display is a read-only projection. Legacy recovery runs in the
  // scheduled reconciler, never during a user's GET request.
  processes.push({id:'development:'+row.id,kind:'development',role:'development',
   projectId:row.project_id,projectName:row.project_name,taskId:row.task_id,
   title:'Разработка #'+row.display_number+' · '+row.task_title,
   detail:developmentProcessDetail(row.message||'Работа над задачей'),
   status:row.status==='queued'?'queued':'running',createdAt:row.created_at,
   url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of imports.rows){
  processes.push({id:'import:'+row.id,kind:'document_import',role:'analyst',projectId:row.project_id,projectName:row.project_name,
   title:'Импорт документации',detail:String(row.message||'Обработка Markdown-документов').slice(0,250),
   status:row.status,createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of tests.rows){
  processes.push({id:'test:'+row.id,kind:'testing',role:'testing',taskId:row.task_id,projectId:row.project_id,projectName:row.project_name,
   title:'AI-тестирование',detail:row.message||'Проверка задачи',status:row.status,
   createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of analyses.rows){
  const preparingTests=row.stage==='test_design_started';
  processes.push({id:'analysis:'+row.id,kind:preparingTests?'testing':'analysis',role:preparingTests?'testing':'analysis',projectId:row.project_id,projectName:row.project_name,
   taskId:row.task_id,title:(preparingTests?'Подготовка тест-плана · ':'Сверка требований · ')+row.title,detail:row.message||'Проверка задачи',status:row.status,createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of taskAnalyses.rows){
  processes.push({id:'task-analysis:'+row.id,kind:'analysis',role:'analysis',projectId:row.project_id,projectName:row.project_name,
   taskId:row.task_id,title:'Анализ #'+row.display_number+' · '+row.title,detail:row.message||'Подготовка требований к разработке',
   status:row.status,createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of iterationRuns.rows){
  processes.push({id:'iteration-plan:'+row.id,kind:'analysis',role:'analysis',projectId:row.project_id,projectName:row.project_name,
   title:'План задач · '+row.title,detail:row.message,status:row.status,createdAt:row.created_at,
   url:'/projects/'+row.project_id+'/docs/plan/'+row.iteration_id});
 }
 for(const row of merges.rows){
  processes.push({id:'merge:'+row.id,kind:'merge',role:'platform',projectId:row.project_id,projectName:row.project_name,
   title:'Последовательное слияние PR',detail:row.message||'Обработка PR',status:row.status==='queued'?'queued':'running',
   createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 processes.sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime());
 return {count:processes.length,processes,checkedAt:new Date().toISOString()};
}

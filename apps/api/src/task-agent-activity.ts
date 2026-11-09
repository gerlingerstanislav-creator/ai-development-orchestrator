import type {Pool,PoolClient} from 'pg';

export async function recordAgentActivity(db:Pool|PoolClient,projectId:string,taskIds:string[],runId:string,
 kind:'analysis'|'documentation'|'qa_design',status:'running'|'completed'|'failed',message:string){
 await db.query(
  "INSERT INTO process_events(id,project_id,task_id,process_id,process_kind,stage,detail,level) SELECT gen_random_uuid(),$1,task_id,$3,$4,$5,$6,$7 FROM unnest($2::uuid[]) AS task(task_id)",
  [projectId,taskIds,runId,kind,status,message.slice(0,500),status==='failed'?'error':'info']);
}

export async function readAgentActivity(pool:Pool,projectId:string,taskId:string){
 const result=await pool.query(`
  WITH scoped_events AS (
   SELECT DISTINCT ON (process_id) process_id,process_kind,stage,detail,created_at
   FROM process_events WHERE project_id=$1 AND task_id=$2
   ORDER BY process_id,created_at DESC,id DESC
  ), runs AS (
   SELECT r.id::text,'development' AS kind,r.status,
    LEFT(COALESCE(NULLIF(n.body,''),r.message),500) AS summary,r.pr_url AS link,r.created_at,r.completed_at
   FROM ai_task_runs r LEFT JOIN task_agent_notes n ON n.task_id=r.task_id AND n.source_key='developer:'||r.id
   WHERE r.project_id=$1 AND r.task_id=$2
   UNION ALL
   SELECT id::text,'testing',status,LEFT(CONCAT_WS(' ',CASE WHEN status='completed' THEN CASE verdict WHEN 'passed' THEN 'Проверки пройдены.' WHEN 'failed' THEN 'Найдены дефекты.' WHEN 'blocked' THEN 'Часть проверок заблокирована.' END END,NULLIF(COALESCE(NULLIF(report->>'summary',''),message),'')),500),NULL,created_at,completed_at
   FROM ai_test_runs WHERE project_id=$1 AND task_id=$2
   UNION ALL
   SELECT r.id::text,'analysis',
    CASE WHEN qa.process_id IS NULL THEN r.status WHEN review.stage='failed' THEN 'failed' ELSE 'completed' END,
    LEFT(COALESCE(review.detail,r.message),500),NULL,r.created_at,
    CASE WHEN qa.process_id IS NULL THEN r.completed_at ELSE review.created_at END
   FROM requirement_review_runs r
   LEFT JOIN scoped_events qa ON qa.process_id=r.id AND qa.process_kind='qa_design'
   LEFT JOIN LATERAL (
    SELECT stage,detail,created_at FROM process_events
    WHERE project_id=r.project_id AND process_id=r.id AND process_kind='analysis'
     AND stage IN ('current','pending','needs_approval','rejected','failed')
    ORDER BY created_at DESC,id DESC LIMIT 1
   ) review ON qa.process_id IS NOT NULL
   WHERE r.project_id=$1 AND r.task_id=$2
   UNION ALL
   SELECT process_id::text,process_kind,
    CASE WHEN stage='running' AND created_at<now()-interval '5 minutes' THEN 'failed' ELSE stage END,
    CASE WHEN stage='running' AND created_at<now()-interval '5 minutes' THEN 'Работа прервалась без результата.' ELSE detail END,
    NULL,created_at,CASE WHEN stage='running' THEN NULL ELSE created_at END
   FROM scoped_events
  )
  SELECT id,kind,status,summary,link,created_at,completed_at FROM runs
  WHERE status IN ('queued','running','completed','failed')
  ORDER BY (status IN ('queued','running')) DESC,COALESCE(completed_at,created_at) DESC,id LIMIT 100
 `,[projectId,taskId]);
 return result.rows;
}

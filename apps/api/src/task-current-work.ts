import type {Pool} from 'pg';

/** Short project-scoped projection for Kanban and list view. All details and
 * full histories remain in task /activity and the Process Center.
 */
export type TaskCurrentWork={
 role:string;status:string;detail:string;source:string;updated_at:string
};
export async function readProjectTaskCurrentWork(db:Pick<Pool,'query'>,projectId:string):
 Promise<Map<string,TaskCurrentWork[]>>{
 const r=await db.query(`
  WITH recent AS (
   SELECT task_id,role,status,LEFT(objective,240) AS detail,
    'assignment' AS source,updated_at
    FROM agent_work_assignments
    WHERE project_id=$1 AND task_id IS NOT NULL
     AND status IN ('queued','running','submitted','blocked')
   UNION ALL
   SELECT task_id,'analysis',status,'Проверяет требования',
    'analysis',updated_at FROM agent_analysis_runs
    WHERE project_id=$1 AND status IN ('queued','running','waiting','failed')
   UNION ALL
   SELECT task_id,'development',status,'Разрабатывает изменения',
    'development',created_at FROM ai_task_runs
    WHERE project_id=$1 AND status IN ('queued','running')
   UNION ALL
   SELECT task_id,'testing',status,'Проверяет реализацию',
    'testing',created_at FROM ai_test_runs
    WHERE project_id=$1 AND status IN ('queued','running')
   UNION ALL
   SELECT task_id,'testing',status,'Готовит скриншоты и проверяет браузер',
    'browser_evidence',updated_at FROM task_evidence_runs
    WHERE project_id=$1 AND status IN ('queued','dispatching','running','failed')
   UNION ALL
   SELECT task_id,role,status,LEFT(n.body,240),
    'consultation',q.updated_at FROM agent_peer_queue q
    JOIN task_agent_notes n ON n.id=q.note_id
    WHERE q.project_id=$1 AND q.status IN ('queued','running','waiting','failed')
   UNION ALL
   SELECT task_id,'manager',status,'Определяет план и исполнителей',
    'pm',created_at FROM assistant_messages
    WHERE project_id=$1 AND task_id IS NOT NULL AND pm_request_id=task_id
     AND channel='pm-internal' AND status IN ('queued','processing')
  )
  SELECT task_id,role,status,detail,source,updated_at FROM (
   SELECT *,row_number() OVER(PARTITION BY task_id
     ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'processing' THEN 0
      WHEN 'blocked' THEN 1 WHEN 'failed' THEN 1
      WHEN 'submitted' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
      updated_at DESC) AS rank
   FROM recent
  ) ordered WHERE rank<=3 ORDER BY task_id,rank
 `,[projectId]);
 const result=new Map<string,TaskCurrentWork[]>();
 for(const row of r.rows){
  if(!result.has(row.task_id))result.set(row.task_id,[]);
  result.get(row.task_id)!.push({
   role:row.role,status:row.status,detail:row.detail,source:row.source,
   updated_at:row.updated_at
  });
 }
 return result;
}

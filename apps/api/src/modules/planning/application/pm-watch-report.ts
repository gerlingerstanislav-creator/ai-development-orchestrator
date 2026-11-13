import {randomUUID} from 'node:crypto';

/** Single transactional writer for PM process completion and internal
 * continuation. All watchers share the same unique report key so Temporal
 * Activity retries and lost acknowledgements cannot duplicate user messages.
 */
export type PmWatchReport={
 projectId:string;
 processId:string;
 kind:'iteration_plan'|'document_import'|'development'|'iteration_execution'|'testing'|'task_goal';
 taskId?:string;
 orderId?:string;
 topicId?:string|null;
 actorId?:string;
};

type QueryResult={rows:any[];rowCount:number|null};
type DbClient={query:(sql:string,values?:any[])=>Promise<QueryResult>;release:()=>void};

export type PmWatchReportContent={
 /** Visible report in the project PM chat. */
 message:string;
 /** Additional internal instruction for the PM, not shown to the user. */
 resumeInstruction:string;
 /** Existing generic watch reports limit the visible message to 3500 chars. */
 visibleLimit?:number;
};

export async function reportPmWatchCompletion<TClient extends DbClient>(
 pool:{connect:()=>Promise<TClient>},
 watch:PmWatchReport,
 {message,resumeInstruction,visibleLimit}:PmWatchReportContent
):Promise<'completed'>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const mark=await client.query(
   'INSERT INTO project_pm_process_reports(project_id,process_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING process_id',
   [watch.projectId,watch.processId,watch.kind]
  );
  if(!mark.rowCount){
   await client.query('ROLLBACK');
   return 'completed';
  }
  await client.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id,pm_order_id) VALUES($1,$2,'assistant',$3,'project','completed',$4,$5)",
   [randomUUID(),watch.projectId,visibleLimit===undefined?message:message.slice(0,visibleLimit),watch.topicId||null,watch.orderId||null]);
  if(watch.orderId&&watch.actorId){
   const resumeId=randomUUID();
   await client.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status,topic_id,pm_order_id) VALUES($1,$2,$3,'user',$4,'pm-internal','queued',$5,$6)",
    [resumeId,watch.projectId,watch.actorId,'СИСТЕМНОЕ СОБЫТИЕ: '+message+resumeInstruction,watch.topicId||null,watch.orderId]);
   await client.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail,process_id) VALUES($1,$2,'resume',$3,$4)",
    [randomUUID(),watch.orderId,resumeId,watch.processId]);
   await client.query("UPDATE project_pm_orders SET status='queued',updated_at=now() WHERE id=$1",[watch.orderId]);
  }
  await client.query('COMMIT');
  return 'completed';
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{
  client.release();
 }
}

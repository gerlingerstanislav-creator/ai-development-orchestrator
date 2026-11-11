import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Client as TemporalClient} from '@temporalio/client';
import {roleCapacity} from './project-team.js';

/** Questions remain in task_agent_notes. This queue only tracks delivery and retries. */
export async function initAgentPeerQueue(pool:Pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS agent_peer_queue (
  note_id uuid PRIMARY KEY REFERENCES task_agent_notes(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','running','completed','waiting','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  error text NOT NULL DEFAULT ''
 );
 CREATE INDEX IF NOT EXISTS idx_agent_peer_queue_dispatch ON agent_peer_queue(role,status,next_attempt_at);`);
}
export async function reconcileAgentPeerQueue(pool:Pool,temporal:()=>Promise<TemporalClient>){
 const client=await pool.connect();
 let locked=false;
 try{
  const l=await client.query("SELECT pg_try_advisory_lock(hashtext('ado-iteration-development-queue')) AS locked");
  locked=l.rows[0]?.locked===true;
  if(!locked)return;
  await client.query(`INSERT INTO agent_peer_queue(note_id,project_id,task_id,role)
   SELECT n.id,n.project_id,n.task_id,CASE WHEN n.target_stage='all' THEN 'manager' ELSE n.target_stage END FROM task_agent_notes n
   WHERE n.kind='question' AND n.source_kind='agent' AND n.status='open'
    AND NOT n.requires_customer AND n.target_stage IN ('analysis','development','testing','documentation','deployment','analyst','all')
   ON CONFLICT(note_id) DO NOTHING`);
  await client.query(`UPDATE agent_peer_queue q SET status='completed',updated_at=now()
   FROM task_agent_notes n WHERE q.note_id=n.id AND n.status='answered' AND q.status<>'completed'`);
  await client.query(`UPDATE agent_peer_queue q SET status='waiting',updated_at=now()
   FROM task_agent_notes n WHERE q.note_id=n.id AND n.requires_customer AND q.status NOT IN ('completed','waiting')`);
  await client.query("UPDATE agent_peer_queue SET status='queued',next_attempt_at=now(),updated_at=now(),error='Восстановлено после прерванного исполнения' WHERE status='running' AND updated_at<now()-interval '15 minutes'");
  // A peer answer is a separate short assignment and may not preempt active work.
  const pending=await client.query(`SELECT q.note_id,q.project_id,q.task_id,q.role,q.attempts FROM agent_peer_queue q
   JOIN task_agent_notes n ON n.id=q.note_id
   WHERE q.status='queued' AND q.next_attempt_at<=now() AND n.status='open' AND NOT n.requires_customer
   AND NOT EXISTS(SELECT 1 FROM agent_peer_queue r WHERE r.project_id=q.project_id AND r.role=q.role AND r.status='running' AND r.note_id=q.note_id)
   ORDER BY q.next_attempt_at,q.updated_at LIMIT 25`);
  for(const job of pending.rows){
   const capacity=await roleCapacity(pool,job.project_id,job.role);
   const peerRunning=await client.query("SELECT count(*)::int AS count FROM agent_peer_queue WHERE project_id=$1 AND role=$2 AND status='running'",[job.project_id,job.role]);
   if(Number(peerRunning.rows[0]?.count||0)>=capacity)continue;
   let busy=false;
   if(job.role==='manager'||job.role==='analyst')
    busy=!!(await client.query("SELECT 1 FROM agent_sessions WHERE project_id=$1 AND role=$2 AND status='running' AND expires_at>now() LIMIT 1",[job.project_id,job.role])).rowCount;
   if(job.role==='development')
    busy=Number((await client.query("SELECT count(*)::int AS count FROM ai_task_runs WHERE project_id=$1 AND status IN ('queued','running')",[job.project_id])).rows[0]?.count||0)+Number(peerRunning.rows[0]?.count||0)>=capacity;
   if(job.role==='testing')
    busy=Number((await client.query("SELECT count(*)::int AS count FROM ai_test_runs WHERE project_id=$1 AND status IN ('queued','running')",[job.project_id])).rows[0]?.count||0)+Number(peerRunning.rows[0]?.count||0)>=capacity;
   if(job.role==='analysis')
    busy=!!(await client.query("SELECT 1 FROM iteration_planning_runs WHERE status IN ('queued','running') LIMIT 1")).rowCount;
   if(busy)continue;
   const claimed=await client.query("UPDATE agent_peer_queue SET status='running',attempts=attempts+1,updated_at=now() WHERE note_id=$1 AND status='queued' RETURNING attempts",[job.note_id]);
   if(!claimed.rowCount)continue;
   try{
    const temporalClient=await temporal();
    await temporalClient.workflow.start('processPeerQuestionWork',{
     taskQueue:'agent-pipeline',
     workflowId:'peer-question-'+job.note_id+'-'+claimed.rows[0].attempts,
     args:[job.note_id]
    });
   }catch(error){
    await client.query("UPDATE agent_peer_queue SET status='queued',next_attempt_at=now()+interval '1 minute',updated_at=now(),error=$2 WHERE note_id=$1 AND status='running'",[job.note_id,String(error).slice(0,500)]);
   }
   // Claim one work item per reconciliation. Other roles can run in parallel on subsequent ticks.
   return;
  }
 }finally{
  if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('ado-iteration-development-queue'))").catch(()=>{});
  client.release();
 }
}

/** Called by a Temporal activity; never erase the original question or the agent's answer. */
export async function markPeerWorkResult(pool:Pool,noteId:string,error:string|null){
 const note=await pool.query("SELECT status,requires_customer FROM task_agent_notes WHERE id=$1",[noteId]);
 const row=await pool.query("SELECT attempts FROM agent_peer_queue WHERE note_id=$1",[noteId]);
 if(!row.rowCount)return;
 const attempts=Number(row.rows[0].attempts);
 const status=!note.rowCount||note.rows[0].status==='answered'?'completed':
  note.rows[0].requires_customer?'waiting':attempts>=3?'failed':'queued';
 const detail=error||(!note.rowCount?'Вопрос удалён':note.rows[0].requires_customer?'Ожидается решение владельца':'Ответ не найден в актуальных материалах');
 await pool.query(`UPDATE agent_peer_queue SET status=$2,error=$3,next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE note_id=$1`,[noteId,status,detail.slice(0,800)]);
 if(status==='failed'){
  const q=await pool.query('SELECT project_id,task_id FROM agent_peer_queue WHERE note_id=$1',[noteId]);
  if(q.rowCount)await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level) VALUES($1,$2,$3,'analysis','peer_question_failed',$4,'warning')",
   [randomUUID(),q.rows[0].project_id,noteId,'Вопрос агента не разрешён за 3 попытки. Требуется внимание ПМ; исходный вопрос сохранён в задаче '+q.rows[0].task_id]);
 }
}

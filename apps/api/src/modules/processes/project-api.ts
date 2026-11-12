import type {Pool} from 'pg';
import type {Client} from '@temporalio/client';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {recordAgentPrompt} from '../../agent-prompt.js';
import {releaseTaskOrchestration} from '../../task-orchestration.js';
import {listProjectProcesses} from './application/project-process-list.js';

type Deps={
 pool:Pool;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;
 temporal:()=>Promise<Client>;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}

/**
 * Process Center HTTP boundary: scoped history, prompt audit, instructions,
 * user cancellation. Workflow dispatch remains in infrastructure.
 */
export function registerProjectProcessRoutes(
 app:FastifyInstance,{pool,uid,access,requireAdmin,temporal}:Deps
){
// Project-scoped process center. The global counter uses this same data model.
// Read-only, project-scoped audit of the actual prompt sent to an AI agent.
// Only administrators can view potentially sensitive task text; secrets are redacted at write time.
app.get('/api/projects/:id/processes/:processId/prompts',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const rows=await pool.query('SELECT id,role,operation,prompt,original_chars,truncated,created_at FROM agent_prompt_audit WHERE project_id=$1 AND process_id=$2 ORDER BY created_at DESC LIMIT 10',[id,processId]);
 return {prompts:rows.rows};
});
// Codex Runner sends the exact final development/QA prompt after adding sandbox rules.
app.post('/internal/agent-prompt',async(req:any,reply)=>{
 const secret=process.env.RUNNER_SHARED_SECRET||'';
 if(!secret||req.headers['x-runner-secret']!==secret)return reply.code(403).send({error:'Forbidden'});
 const data=parse(z.object({
  projectId:z.string().uuid(),processId:z.string().uuid(),
  role:z.enum(['development','testing']),prompt:z.string().min(1).max(80000)
 }),req.body);
 const belongs=await pool.query(
  'SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND id=$2 UNION ALL SELECT 1 FROM ai_test_runs WHERE project_id=$1 AND id=$2 LIMIT 1',
  [data.projectId,data.processId]);
 if(!belongs.rowCount)return reply.code(404).send({error:'Process not found'});
 await recordAgentPrompt(pool,{projectId:data.projectId,processId:data.processId,role:data.role,operation:'codex_exec',prompt:data.prompt});
 return {ok:true};
});
app.get('/api/projects/:id/processes',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 return listProjectProcesses(pool,id);
});
app.post('/api/projects/:id/processes/:processId/instructions',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {message}=parse(z.object({message:z.string().trim().min(1).max(2000)}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const job=await client.query("SELECT status,message FROM document_import_jobs WHERE project_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE",[id,processId,uid(req)]);
  if(!job.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Процесс импорта не найден'});}
  if(job.rows[0].status!=='running'){await client.query('ROLLBACK');return reply.code(409).send({error:'Аналитик уже завершил или остановил этот процесс'});}
  if(/Формирование итоговой структуры|Сохранение документов/.test(String(job.rows[0].message))){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'Аналитик уже сохраняет результат. Уточнение на этой стадии не успеет примениться.'});
  }
  await client.query('INSERT INTO process_instructions(id,project_id,process_id,actor_id,body) VALUES($1,$2,$3,$4,$5)',
   [randomUUID(),id,processId,uid(req),message]);
  await client.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'document_import','user_instruction',$4)",
   [randomUUID(),id,processId,message]);
  const acknowledgement='Уточнение принято и передано аналитику. Оно будет учтено на текущем или следующем этапе.';
  await client.query("INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,channel,created_at) VALUES($1,$2,NULL,$3,'user',$4,'documentation',clock_timestamp()),($5,$2,NULL,NULL,'assistant',$6,'documentation',clock_timestamp())",
   [randomUUID(),id,uid(req),message,randomUUID(),acknowledgement]);
  await client.query('COMMIT');
  return {ok:true,message:acknowledgement};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
});
// Stop an active analyst run without rolling back previously committed checkpoints.
 // Locking the job row also serializes the request with document-writing checkpoints.
app.post('/api/projects/:id/processes/:processId/stop',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 // Stop the actual Codex job and its Temporal workflow, without deleting the task or PR.
 const cancelRunner=async(runId:string)=>{
  try{
   await fetch((process.env.CODEX_RUNNER_URL||'http://codex:4300')+'/jobs/'+runId+'/cancel',{
    method:'POST',headers:{'X-Runner-Secret':process.env.RUNNER_SHARED_SECRET||''},
    signal:AbortSignal.timeout(8000)
   });
  }catch(error){req.log.warn({error,runId},'Codex cancellation needs reconciliation');}
 };
 const cancelWorkflow=async(workflowId:string)=>{
  try{const client=await temporal();await client.workflow.getHandle(workflowId).cancel();}
  catch(error){req.log.warn({error,workflowId},'Temporal cancellation needs reconciliation');}
 };
 const analyst=await pool.query("UPDATE agent_analysis_runs SET status='cancelled',message='Прервано пользователем',updated_at=now() WHERE project_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING task_id,spec_version",[id,processId]);
 if(analyst.rowCount){
  await pool.query("UPDATE tasks SET analysis_state='paused',updated_at=now() WHERE project_id=$1 AND id=$2 AND stage='analysis' AND analysis_state='processing' AND spec_version=$3",[id,analyst.rows[0].task_id,analyst.rows[0].spec_version]);
  await cancelWorkflow('task-analysis-'+processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'analysis','cancelled','Анализ задачи остановлен пользователем')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const dev=await pool.query("UPDATE ai_task_runs SET status='cancelled',message='Прервано пользователем',completed_at=now() WHERE project_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING task_id,cycle_id",[id,processId]);
 if(dev.rowCount){
  await cancelRunner(processId);
  await cancelWorkflow('task-cycle-'+(dev.rows[0].cycle_id||processId));
  await releaseTaskOrchestration(pool,id,dev.rows[0].task_id,dev.rows[0].cycle_id||processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'development','cancelled','Разработка остановлена пользователем')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const test=await pool.query("UPDATE ai_test_runs SET status='cancelled',message='Прервано пользователем',completed_at=now() WHERE project_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING task_id,cycle_id",[id,processId]);
 if(test.rowCount){
  await cancelRunner(processId);
  const cycle=test.rows[0].cycle_id;
  if(cycle){await cancelWorkflow('task-cycle-'+cycle);await cancelWorkflow('manual-test-'+cycle);}
  await releaseTaskOrchestration(pool,id,test.rows[0].task_id,cycle||processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'testing','cancelled','Тестирование остановлено пользователем')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const queue=await pool.query("UPDATE iteration_execution_queue SET status='cancelled',detail='Запуск отменён пользователем',updated_at=now() WHERE project_id=$1 AND COALESCE(run_id,task_id)=$2 AND status='queued' RETURNING task_id",[id,processId]);
 if(queue.rowCount)return {ok:true,status:'cancelled'};
 const planning=await pool.query("UPDATE iteration_planning_runs r SET status='cancelled',message='Прервано пользователем',updated_at=now() FROM project_iterations i WHERE r.id=$2 AND r.iteration_id=i.id AND i.project_id=$1 AND r.status IN ('queued','running') RETURNING r.id",[id,processId]);
 if(planning.rowCount){
  await cancelWorkflow('iteration-plan-'+processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'analysis','cancelled','Планирование итерации остановлено')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const stopped=await pool.query(
  "UPDATE document_import_jobs SET status='cancelled',message='Остановлен пользователем',updated_at=now() WHERE project_id=$1 AND id=$2 AND actor_id=$3 AND status='running' RETURNING id",
  [id,processId,uid(req)]);
 if(!stopped.rowCount)return reply.code(409).send({error:'Процесс уже завершён или не принадлежит пользователю'});
 await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'document_import','stopped','Пользователь остановил работу аналитика')",
  [randomUUID(),id,processId]);
 // The persisted status prevents subsequent writes even when cancellation reaches an
 // in-flight Codex request later. Workflow cancellation releases its worker slot.
 try{
  const client=await temporal();
  await client.workflow.getHandle('analyst-'+processId).cancel();
 }catch(error){req.log.warn({error},'Temporal cancel pending; persisted stop gate already active');}
 return {ok:true,status:'cancelled',message:'Аналитик остановлен. Уже сохранённые контрольные точки и документы не удалены.'};
});
app.get('/api/projects/:id/processes/:processId/events',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const rows=await pool.query("SELECT id,process_kind,level,stage,detail,created_at FROM process_events WHERE project_id=$1 AND process_id=$2 ORDER BY created_at ASC LIMIT 500",[id,processId]);
 return rows.rows;
});


}

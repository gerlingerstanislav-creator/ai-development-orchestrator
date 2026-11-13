import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';

type Dependencies={
 app:FastifyInstance;
 pool:Pick<Pool,'query'>;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
};

/**
 * Read-only projection. Legacy run reconciliation is owned by the scheduled
 * development reconciler; Temporal is the owner of modern cycle-backed runs.
 * GET must not start Codex work or mutate task/process state.
 */
export function registerDevelopmentRunStatusRoutes({app,pool,access}:Dependencies){
 app.get('/api/projects/:id/ai-runs/:runId',async(req:any,reply)=>{
  const {id,runId}=z.object({id:z.string().uuid(),runId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id))return;
  const run=await pool.query('SELECT id,task_id,model,status,branch,pr_url,message,created_at,completed_at,cycle_id FROM ai_task_runs WHERE id=$1 AND project_id=$2',[runId,id]);
  if(run.rowCount)return run.rows[0];

  const intent=(await pool.query(`SELECT q.run_id AS id,q.task_id,q.status,q.created_at,q.detail AS message,
   COALESCE(s.model,'gpt-6-luna') AS model FROM iteration_execution_queue q
   LEFT JOIN project_ai_settings s ON s.project_id=q.project_id WHERE q.project_id=$1 AND q.run_id=$2`,[id,runId])).rows[0];
  if(!intent)return reply.code(404).send({error:'Запуск не найден'});
  return {...intent,status:intent.status==='stale'?'failed':intent.status==='dispatched'?'completed':intent.status,
   message:intent.message||'Ожидает диспетчера разработки'};
 });
}

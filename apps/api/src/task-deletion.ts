import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
type Dependencies={pool:Pool;uid:(req:any)=>string;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>};
const uuid=z.string().uuid();

/** Only unstarted backlog/analysis tasks may be deleted. A task with execution evidence
 * must be cancelled through the existing workflow, preserving its history and PR. */
export function registerSafeTaskDeletion(app:FastifyInstance,{pool,uid,access,requireAdmin}:Dependencies){
 app.delete('/api/projects/:id/tasks/:taskId',async(req:any,reply)=>{
  const {id,taskId}=z.object({id:uuid,taskId:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {confirm_task_id}=z.object({confirm_task_id:uuid}).parse(req.body||{});
  if(confirm_task_id!==taskId)return reply.code(409).send({error:'Подтверди удаление именно выбранной задачи'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const task=(await client.query('SELECT id,display_number,title,stage,git_branch,pr_url FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id])).rows[0];
   if(!task){await client.query('ROLLBACK');return reply.code(404).send({error:'Задача не найдена'});}
   if(!['backlog','analysis'].includes(task.stage)||task.pr_url||task.git_branch){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Задача уже связана с исполнением. Для неё используй отмену задачи, а не удаление'});
   }
   const [children,development,testing,plans,caseCount]=await Promise.all([
    client.query('SELECT 1 FROM tasks WHERE project_id=$1 AND (parent_id=$2 OR depends_on_task_id=$2) LIMIT 1',[id,taskId]),
    client.query('SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 LIMIT 1',[id,taskId]),
    client.query('SELECT 1 FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 LIMIT 1',[id,taskId]),
    client.query('SELECT 1 FROM qa_test_plans WHERE project_id=$1 AND task_id=$2 LIMIT 1',[id,taskId]),
    client.query('SELECT 1 FROM qa_test_cases WHERE project_id=$1 AND source_task_id=$2 LIMIT 1',[id,taskId])
   ]);
   if([children,development,testing,plans,caseCount].some(r=>r.rowCount)){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Задача имеет связанные задачи или результаты выполнения. Удаление заблокировано'});
   }
   const deleted=await client.query('DELETE FROM tasks WHERE project_id=$1 AND id=$2 RETURNING id',[id,taskId]);
   if(!deleted.rowCount)throw new Error('Задача изменилась во время удаления');
   await client.query('COMMIT');
   return {ok:true,deleted_task_id:taskId,display_number:task.display_number};
  }catch(error){
   await client.query('ROLLBACK').catch(()=>{});
   if((error as any)?.code==='23503')return reply.code(409).send({error:'На задачу ссылаются связанные данные. Удаление заблокировано'});
   throw error;
  }finally{client.release();}
 });
}

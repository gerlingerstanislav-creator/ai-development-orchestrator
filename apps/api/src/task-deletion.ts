import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {tasksWithCustomerQuestions} from './project-manager.js';

type Dependencies={pool:Pool;uid:(req:any)=>string;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>};
const uuid=z.string().uuid();
const projectParams=z.object({id:uuid});
const taskParams=projectParams.extend({taskId:uuid});
const ownerQuestionsPath='/api/projects/:id/tasks/owner-questions/delete';
type TaskForDeletion={id:string;title:string;display_number:number;type:string;stage:string;git_branch:string|null;pr_url:string|null;has_related_data:boolean;active_question_job:boolean};

async function tasksForDeletion(db:Pick<Pool,'query'>,projectId:string,taskIds:string[]){
 if(!taskIds.length)return [];
 const result=await db.query<TaskForDeletion>(`
  SELECT t.id,t.title,t.display_number,t.type,t.stage,t.git_branch,t.pr_url,
   EXISTS(SELECT 1 FROM document_import_jobs j WHERE j.project_id=t.project_id AND j.source_key='po-answer:'||t.id::text AND j.status IN ('queued','running')) AS active_question_job,
   (EXISTS (SELECT 1 FROM tasks d WHERE d.project_id=t.project_id AND (d.parent_id=t.id OR d.depends_on_task_id=t.id))
   OR EXISTS (SELECT 1 FROM ai_task_runs r WHERE r.project_id=t.project_id AND r.task_id=t.id)
   OR EXISTS (SELECT 1 FROM ai_test_runs r WHERE r.project_id=t.project_id AND r.task_id=t.id)
   OR EXISTS (SELECT 1 FROM qa_test_plans p WHERE p.project_id=t.project_id AND p.task_id=t.id)
   OR EXISTS (SELECT 1 FROM qa_test_cases c WHERE c.project_id=t.project_id AND c.source_task_id=t.id)
   OR EXISTS (SELECT 1 FROM requirement_review_runs r WHERE r.project_id=t.project_id AND r.task_id=t.id AND r.status IN ('queued','running')))
   AS has_related_data
  FROM tasks t WHERE t.project_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.display_number,t.id
 `,[projectId,taskIds]);
 return result.rows;
}

function deletionBlocker(task:TaskForDeletion){
 if(task.type==='question'){
  if(task.active_question_job)return 'Ответ уже обрабатывается аналитиком. Дождитесь завершения процесса';
  if(task.has_related_data)return 'У вопроса есть связанные задачи или результаты выполнения';
  return null;
 }
 if(!['backlog','analysis'].includes(task.stage)||task.pr_url||task.git_branch)
  return 'Задача уже связана с исполнением. Для неё используй отмену задачи';
 if(task.has_related_data)
  return 'Задача имеет связанные задачи или результаты выполнения. Удаление заблокировано';
 return null;
}

async function ownerQuestionTaskIds(db:Pick<Pool,'query'>,projectId:string){
 return (await tasksWithCustomerQuestions(db,projectId)).filter(task=>task.awaits_product_owner).map(task=>String(task.id));
}

export function registerSafeTaskDeletion(app:FastifyInstance,{pool,access,requireAdmin}:Dependencies){
 app.delete('/api/projects/:id/tasks/:taskId',async(req:any,reply)=>{
  const {id,taskId}=taskParams.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {confirm_task_id}=z.object({confirm_task_id:uuid}).parse(req.body||{});
  if(confirm_task_id!==taskId)return reply.code(409).send({error:'Подтверди удаление именно выбранной задачи'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE',[id,taskId]);
   const [task]=await tasksForDeletion(client,id,[taskId]);
   if(!task){await client.query('ROLLBACK');return reply.code(404).send({error:'Задача не найдена'});}
   const blocker=deletionBlocker(task);
   if(blocker){await client.query('ROLLBACK');return reply.code(409).send({error:blocker});}
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

 app.get(ownerQuestionsPath+'/preview',async(req:any,reply)=>{
  const {id}=projectParams.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const tasks=await tasksForDeletion(pool,id,await ownerQuestionTaskIds(pool,id));
  return {tasks:tasks.map(task=>({
   id:task.id,title:task.title,display_number:task.display_number,blocked_reason:deletionBlocker(task)
  }))};
 });

 app.post(ownerQuestionsPath+'/confirm',async(req:any,reply)=>{
  const {id}=projectParams.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {task_ids,confirm}=z.object({task_ids:z.array(uuid).min(1),confirm:z.boolean()}).parse(req.body||{});
  if(!confirm)return reply.code(409).send({error:'Подтверди удаление выбранных задач'});
  const taskIds=[...new Set(task_ids)];
  const client=await pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
   await client.query('SELECT id FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[id,taskIds]);
   const currentOwnerQuestions=new Set(await ownerQuestionTaskIds(client,id));
   const tasks=await tasksForDeletion(client,id,taskIds);
   if(tasks.length!==taskIds.length||tasks.some(task=>!currentOwnerQuestions.has(task.id)||deletionBlocker(task))){
    await client.query('ROLLBACK');
    return reply.code(409).send({error:'Состав колонки или состояние задач изменилось. Открой предпросмотр заново.'});
   }
   const deleted=await client.query('DELETE FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) RETURNING id',[id,taskIds]);
   await client.query('COMMIT');
   return {ok:true,deleted_task_ids:deleted.rows.map(task=>task.id)};
  }catch(error){
   await client.query('ROLLBACK').catch(()=>{});
   if(['23503','40001'].includes((error as any)?.code))
    return reply.code(409).send({error:'Связи или состояние задач изменились. Открой предпросмотр заново.'});
   throw error;
  }finally{client.release();}
 });
}

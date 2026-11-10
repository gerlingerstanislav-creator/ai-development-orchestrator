import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {tasksWithCustomerQuestions} from './project-manager.js';

type Dependencies={pool:Pool;uid:(req:any)=>string;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>};
const uuid=z.string().uuid();
const projectParams=z.object({id:uuid});
const taskParams=projectParams.extend({taskId:uuid});
const ownerQuestionsPath='/api/projects/:id/tasks/owner-questions/delete';
type TaskForDeletion={id:string;title:string;display_number:number;stage:string;git_branch:string|null;pr_url:string|null;has_related_data:boolean};

async function tasksForDeletion(db:Pick<Pool,'query'>,projectId:string,taskIds:string[]){
 if(!taskIds.length)return [];
 const result=await db.query<TaskForDeletion>(`
  SELECT t.id,t.title,t.display_number,t.stage,t.git_branch,t.pr_url,
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
  const questions=await pool.query(
   "SELECT q.id,q.question,d.title AS document_title,CASE WHEN EXISTS(SELECT 1 FROM document_import_jobs j WHERE j.project_id=q.project_id AND j.status IN ('running','queued') AND (j.id=q.job_id OR j.analyst_input->>'questionId'=q.id::text)) THEN 'Вопрос используется активным процессом аналитика' ELSE NULL END AS blocked_reason FROM documentation_questions q JOIN documents d ON d.id=q.document_id AND d.project_id=q.project_id WHERE q.project_id=$1 AND q.status IN ('open','answered') ORDER BY q.created_at,q.id",
   [id]);
  return {tasks:tasks.map(task=>({
   id:task.id,title:task.title,display_number:task.display_number,blocked_reason:deletionBlocker(task)
  })),questions:questions.rows};
 });

 app.post(ownerQuestionsPath+'/confirm',async(req:any,reply)=>{
  const {id}=projectParams.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {task_ids,question_ids,confirm}=z.object({
   task_ids:z.array(uuid).max(100).default([]),
   question_ids:z.array(uuid).max(100).default([]),
   confirm:z.literal(true)
  }).parse(req.body||{});
  const taskIds=[...new Set(task_ids)],questionIds=[...new Set(question_ids)];
  if(!taskIds.length&&!questionIds.length)return reply.code(400).send({error:'Нет выбранных задач или вопросов'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
   if(taskIds.length)await client.query('SELECT id FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[id,taskIds]);
   if(questionIds.length)await client.query('SELECT id FROM documentation_questions WHERE project_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[id,questionIds]);
   const currentOwnerQuestions=new Set(await ownerQuestionTaskIds(client,id));
   const tasks=await tasksForDeletion(client,id,taskIds);
   const questions=questionIds.length?(await client.query(
    "SELECT q.id FROM documentation_questions q WHERE q.project_id=$1 AND q.id=ANY($2::uuid[]) AND q.status IN ('open','answered') AND NOT EXISTS(SELECT 1 FROM document_import_jobs j WHERE j.project_id=q.project_id AND j.status IN ('running','queued') AND (j.id=q.job_id OR j.analyst_input->>'questionId'=q.id::text))",
    [id,questionIds])).rows:[];
   if(tasks.length!==taskIds.length||questions.length!==questionIds.length||
      tasks.some(task=>!currentOwnerQuestions.has(task.id)||deletionBlocker(task))){
    await client.query('ROLLBACK');
    return reply.code(409).send({error:'Состав колонки или состояние задач/вопросов изменилось. Открой предпросмотр заново.'});
   }
   const deleted=taskIds.length?await client.query('DELETE FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) RETURNING id',[id,taskIds]):{rows:[]};
   const deletedQuestions=questionIds.length?await client.query('DELETE FROM documentation_questions WHERE project_id=$1 AND id=ANY($2::uuid[]) RETURNING id',[id,questionIds]):{rows:[]};
   await client.query('COMMIT');
   return {ok:true,deleted_task_ids:deleted.rows.map(task=>task.id),deleted_question_ids:deletedQuestions.rows.map(q=>q.id)};
  }catch(error){
   await client.query('ROLLBACK').catch(()=>{});
   if(['23503','40001'].includes((error as any)?.code))
    return reply.code(409).send({error:'Связи или состояние задач изменились. Открой предпросмотр заново.'});
   throw error;
  }finally{client.release();}
 });
 // Generic deletion preview is scoped to exactly the IDs selected by PM.
 // The owner must explicitly confirm after reviewing all dependent-data blockers.
 app.get('/api/projects/:id/tasks/delete/preview',async(req:any,reply)=>{
  const {id}=projectParams.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {ids}=z.object({ids:z.string().min(1).max(3900)}).parse(req.query);
  const taskIds=[...new Set(ids.split(',').map(value=>uuid.parse(value)))];
  if(!taskIds.length||taskIds.length>100)return reply.code(400).send({error:'Выбери от 1 до 100 задач'});
  const tasks=await tasksForDeletion(pool,id,taskIds);
  if(tasks.length!==taskIds.length)return reply.code(409).send({error:'Часть выбранных задач больше не существует. Обнови список'});
  return {tasks:tasks.map(task=>({id:task.id,title:task.title,display_number:task.display_number,blocked_reason:deletionBlocker(task)}))};
 });
 app.post('/api/projects/:id/tasks/delete/confirm',async(req:any,reply)=>{
  const {id}=projectParams.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {task_ids,confirm}=z.object({task_ids:z.array(uuid).min(1).max(100),confirm:z.literal(true)}).parse(req.body||{});
  const taskIds=[...new Set(task_ids)];
  const client=await pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
   await client.query('SELECT id FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[id,taskIds]);
   const tasks=await tasksForDeletion(client,id,taskIds);
   if(tasks.length!==taskIds.length||tasks.some(task=>deletionBlocker(task))){
    await client.query('ROLLBACK');
    return reply.code(409).send({error:'Выбранные задачи изменились или содержат связанные данные. Открой предпросмотр заново.'});
   }
   const removed=await client.query('DELETE FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) RETURNING id',[id,taskIds]);
   await client.query('COMMIT');
   return {ok:true,deleted_task_ids:removed.rows.map(row=>row.id)};
  }catch(error){
   await client.query('ROLLBACK').catch(()=>{});
   if(['23503','40001'].includes((error as any)?.code))
    return reply.code(409).send({error:'Задачи изменились или защищены связанными данными. Открой предпросмотр заново.'});
   throw error;
  }finally{client.release();}
 });

}

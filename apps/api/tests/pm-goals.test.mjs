import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {installPmGoalSchema,openPmGoal,linkPmGoal,assessPmGoal,listPmGoals,
 updatePmGoalStatus,completePmGoal}
 from '../dist/modules/planning/infrastructure/pm-goals.js';
import {executePmGoalTool,isPmGoalTool}
 from '../dist/modules/planning/infrastructure/pm-goal-tools.js';

async function isolated(fn){
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='pmgoals_'+randomUUID().replaceAll('-','');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 try{
  await admin.query('CREATE SCHEMA '+schema);
  await db.query(`
   CREATE TABLE projects(id uuid PRIMARY KEY);
   CREATE TABLE project_pm_orders(id uuid PRIMARY KEY);
   CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,channel text,status text,pm_order_id uuid);
   CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,title text,stage text,type text DEFAULT 'task',spec_version int DEFAULT 1);
   CREATE TABLE agent_work_assignments(id uuid PRIMARY KEY,project_id uuid,task_id uuid,status text, evidence text,spec_version int DEFAULT 1,result text);
   CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid,title text,body text);
  `);
  await installPmGoalSchema(db);
  await installPmGoalSchema(db);
  await fn(db);
 }finally{
  await db.end();
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
  await admin.end();
 }
}
const criteria=['Все шаги завершены и результат проверен'];
const objective='Добиться подтверждённого результата для владельца';

test('goal from real user message is durable and idempotent; questions do not create goals automatically',async()=>{
 await isolated(async db=>{
  const projectId=randomUUID(),actorId=randomUUID(),sourceMessageId=randomUUID();
  await db.query('INSERT INTO projects VALUES($1)',[projectId]);
  await db.query("INSERT INTO assistant_messages VALUES($1,$2,$3,'user','project','processing',NULL)",
   [sourceMessageId,projectId,actorId]);
  const original=await openPmGoal(db,{projectId,actorId,sourceMessageId,objective,criteria});
  assert.equal(original.status,'working');
  assert.equal(original.created,true);
  const retried=await openPmGoal(db,{projectId,actorId,sourceMessageId,objective,criteria});
  assert.equal(retried.id,original.id);
  assert.equal(retried.created,false);
  assert.equal((await listPmGoals(db,projectId)).goals.length,1);
  await assert.rejects(openPmGoal(db,{projectId,actorId:randomUUID(),sourceMessageId,objective,criteria}),
   /текущего сообщения владельца/);
  await assert.rejects(completePmGoal(db,{projectId,goalId:original.id,
   evidence:'Я просто сказал, что работа выполнена'}),/Нельзя завершить цель/);
  await updatePmGoalStatus(db,{projectId,goalId:original.id,status:'waiting_user',
   reason:'Для решения нужно разрешение владельца'});
  assert.equal((await assessPmGoal(db,projectId,original.id)).goal.status,'waiting_user');
 });
});

test('scope, evidence and current work version gate goal completion',async()=>{
 await isolated(async db=>{
  const projectId=randomUUID(),otherProject=randomUUID(),actorId=randomUUID(),sourceMessageId=randomUUID();
  const taskId=randomUUID(),assignmentId=randomUUID(),otherDocument=randomUUID();
  await db.query('INSERT INTO projects VALUES($1),($2)',[projectId,otherProject]);
  await db.query("INSERT INTO assistant_messages VALUES($1,$2,$3,'user','project','processing',NULL)",
   [sourceMessageId,projectId,actorId]);
  await db.query("INSERT INTO tasks VALUES($1,$2,'Незавершённая работа','analysis','task',2)",
   [taskId,projectId]);
  await db.query("INSERT INTO agent_work_assignments VALUES($1,$2,$3,'running','',1,'')",
   [assignmentId,projectId,taskId]);
  await db.query("INSERT INTO documents VALUES($1,$2,'Другой проект','Это отдельная длинная страница')",
   [otherDocument,otherProject]);
  const goal=await openPmGoal(db,{projectId,actorId,sourceMessageId,objective,criteria});
  await assert.rejects(linkPmGoal(db,{projectId,goalId:goal.id,kind:'document',referenceId:otherDocument}),
   /недоступен/);
  const link=await linkPmGoal(db,{projectId,goalId:goal.id,kind:'assignment',referenceId:assignmentId});
  assert.equal(link.verification.verified,false);
  assert.equal(link.watch.kind,'delegated_work');
  assert.equal((await linkPmGoal(db,{projectId,goalId:goal.id,kind:'assignment',referenceId:assignmentId})).linked,false);
  await assert.rejects(completePmGoal(db,{projectId,goalId:goal.id,
   evidence:'Доказательства полного достижения цели ещё отсутствуют'}),/Нельзя завершить цель/);
  await db.query("UPDATE agent_work_assignments SET status='completed',evidence='Верифицированный результат с SHA' WHERE id=$1",
   [assignmentId]);
  const assessed=await assessPmGoal(db,projectId,goal.id);
  assert.equal(assessed.verification.verified,false,'stale version never verifies a result');
  await db.query('UPDATE agent_work_assignments SET spec_version=2 WHERE id=$1',[assignmentId]);
  assert.equal((await assessPmGoal(db,projectId,goal.id)).verification.verified,true);
  assert.equal((await completePmGoal(db,{projectId,goalId:goal.id,
   evidence:'Проверил результат QA с точным SHA и принял итог'})).status,'completed');
  await assert.rejects(linkPmGoal(db,{projectId,goalId:goal.id,kind:'task',referenceId:taskId}),
   /завершённую цель/);
  assert.equal((await completePmGoal(db,{projectId,goalId:goal.id,
   evidence:'Повторный ответ не создаёт изменения'})).already_completed,true);
 });
});

test('PM goal tools are scoped to manager and to a real processing owner message',async()=>{
 await isolated(async db=>{
  const projectId=randomUUID(),actorId=randomUUID(),messageId=randomUUID();
  await db.query('INSERT INTO projects VALUES($1)',[projectId]);
  await db.query("INSERT INTO assistant_messages VALUES($1,$2,$3,'user','project','processing',NULL)",
   [messageId,projectId,actorId]);
  const manager={role:'manager',read_only:false,project_id:projectId,actor_id:actorId,
   process_id:messageId};
  assert.equal(isPmGoalTool('goals.open'),true);
  assert.equal(isPmGoalTool('tasks.close'),false);
  const open=await executePmGoalTool(db,manager,'goals.open',{objective,criteria});
  assert.equal(open.watch.kind,'goal');
  assert.equal(open.watch.goal_id,open.id);
  assert.equal((await executePmGoalTool(db,manager,'goals.list',{})).goals.length,1);
  const read=await executePmGoalTool(db,{...manager,read_only:true},'goals.read',{goal_id:open.id});
  assert.equal(read.goal.id,open.id);
  await assert.rejects(executePmGoalTool(db,{...manager,role:'development'},'goals.complete',
   {goal_id:open.id,evidence:'Неверное делегирование завершения'}),/только ПМ/);
  await assert.rejects(executePmGoalTool(db,{...manager,read_only:true},'goals.update',
   {goal_id:open.id,status:'working',reason:'Запустить дополнительные проверки'}),/не может изменять/);
 });
});

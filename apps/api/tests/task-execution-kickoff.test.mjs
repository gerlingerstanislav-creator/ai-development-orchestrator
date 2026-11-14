import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {registerTaskBoardRoutes} from '../dist/task-board-routes.js';

async function isolated(fn){
 const name='ado_dynamic_kickoff_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:4});
 try{
  await runSchemaMigrations(db,coreSchemaMigrations({analysis:'Аналитика'}));
  await fn(db);
 }finally{
  await db.end();await admin.query('DROP SCHEMA "'+name+'" CASCADE');await admin.end();
 }
}

async function setup(db){
 const ids={user:randomUUID(),project:randomUUID(),task:randomUUID()};
 await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[ids.user,'dynamic@example.test','hash']);
 await db.query('INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,$2,$3,true)',[ids.project,'Dynamic',ids.user]);
 await db.query('INSERT INTO project_ai_settings(project_id,enabled) VALUES($1,true)',[ids.project]);
 await db.query('INSERT INTO tasks(id,project_id,title,description,stage) VALUES($1,$2,$3,$4,\'backlog\')',[ids.task,ids.project,'Сделать исследование','Сравнить подходы и подготовить документ']);
 const app=Fastify();
 registerTaskBoardRoutes(app,{pool:db,uid:()=>ids.user,access:async()=>true,requireAdmin:async()=>true});
 const action=(body)=>app.inject({method:'PATCH',url:'/api/projects/'+ids.project+'/tasks/'+ids.task+'/board',payload:body});
 return {ids,app,action};
}

test('owner starts one durable PM order on the transition to in_progress, not on task creation or todo',async()=>{
 await isolated(async db=>{
  const {ids,app,action}=await setup(db);
  try{
   const before=await db.query("SELECT count(*)::int AS n FROM assistant_messages WHERE channel='pm-internal'");
   assert.equal(before.rows[0].n,0);
   assert.equal((await action({action:'move',status:'todo'})).statusCode,200);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM assistant_messages WHERE channel='pm-internal'")).rows[0].n,0);
   const reply=await action({action:'move',status:'in_progress'});
   assert.equal(reply.statusCode,200,reply.body);
   const result=reply.json().kickoff;
   assert.equal(result.status,'queued');
   assert.equal(result.reused,false);
   assert.equal((await db.query('SELECT board_status,stage FROM tasks WHERE id=$1',[ids.task])).rows[0].board_status,'in_progress');
   assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[ids.task])).rows[0].stage,'backlog');
   const message=(await db.query('SELECT task_id,body,status,pm_order_id,pm_request_id FROM assistant_messages WHERE id=$1',[result.message_id])).rows[0];
   assert.equal(message.task_id,ids.task);
   assert.equal(message.pm_request_id,ids.task);
   assert.equal(message.pm_order_id,result.order_id);
   assert.match(message.body,/work\.plan/);
   const order=(await db.query('SELECT source_message_id,status FROM project_pm_orders WHERE id=$1',[result.order_id])).rows[0];
   assert.deepEqual(order,{source_message_id:result.message_id,status:'queued'});
   const replay=await action({action:'start'});
   assert.equal(replay.statusCode,200,replay.body);
   assert.equal(replay.json().kickoff.reused,true);
   assert.equal(replay.json().kickoff.message_id,result.message_id);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM project_pm_orders WHERE project_id=$1",[ids.project])).rows[0].n,1);
   assert.equal((await action({action:'move',status:'todo'})).statusCode,409,'cannot disguise active PM work by reversing Kanban');
   assert.equal((await action({action:'postpone'})).statusCode,409,'cannot postpone a queued PM turn');
   assert.ok((await db.query("SELECT 1 FROM process_events WHERE process_kind='pm_inbox' AND task_id=$1",[ids.task])).rowCount);
  }finally{await app.close();}
 });
});

test('a failed PM kickoff is retried on the same message and order, not a duplicate DAG',async()=>{
 await isolated(async db=>{
  const {ids,app,action}=await setup(db);
  try{
   await action({action:'move',status:'in_progress'});
   const initial=(await db.query("SELECT id,pm_order_id FROM assistant_messages WHERE task_id=$1 AND channel='pm-internal'",[ids.task])).rows[0];
   await db.query("UPDATE assistant_messages SET status='failed',pm_dispatched_at=now() WHERE id=$1",[initial.id]);
   await db.query("UPDATE project_pm_orders SET status='failed' WHERE id=$1",[initial.pm_order_id]);
   const retry=await action({action:'start'});
   assert.equal(retry.statusCode,200,retry.body);
   assert.equal(retry.json().kickoff.message_id,initial.id);
   const next=(await db.query('SELECT status,pm_dispatch_attempt,pm_dispatched_at FROM assistant_messages WHERE id=$1',[initial.id])).rows[0];
   assert.equal(next.status,'queued');
   assert.equal(next.pm_dispatch_attempt,2);
   assert.equal(next.pm_dispatched_at,null);
   assert.equal((await db.query('SELECT status FROM project_pm_orders WHERE id=$1',[initial.pm_order_id])).rows[0].status,'queued');
   assert.equal((await db.query("SELECT count(*)::int AS n FROM assistant_messages WHERE channel='pm-internal' AND task_id=$1",[ids.task])).rows[0].n,1);
  }finally{await app.close();}
 });
});

test('disabled AI stops the board transition atomically; no phantom kickoff',async()=>{
 await isolated(async db=>{
  const {ids,app,action}=await setup(db);
  try{
   await db.query('UPDATE project_ai_settings SET enabled=false WHERE project_id=$1',[ids.project]);
   const reply=await action({action:'move',status:'in_progress'});
   assert.equal(reply.statusCode,409,reply.body);
   assert.match(reply.json().message||reply.json().error,/AI/);
   assert.equal((await db.query('SELECT board_status FROM tasks WHERE id=$1',[ids.task])).rows[0].board_status,'backlog');
   assert.equal((await db.query("SELECT count(*)::int AS n FROM assistant_messages WHERE channel='pm-internal'")).rows[0].n,0);
  }finally{await app.close();}
 });
});

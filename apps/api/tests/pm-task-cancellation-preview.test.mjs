import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {registerTaskCancellationRoutes} from '../dist/task-cancellation.js';

test('existing task #36 is found by cancellation preview and active PM work is a real blocker',async()=>{
 const schema='ado_pm_cancel_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:4});
 const app=Fastify();
 try{
  await runSchemaMigrations(db,coreSchemaMigrations({analysis:'Аналитика'}));
  const owner=randomUUID(),project=randomUUID(),task=randomUUID(),assignment=randomUUID(),pmMessage=randomUUID();
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[owner,'pm-cancel@example.test','hash']);
  await db.query('INSERT INTO projects(id,name,owner_id) VALUES($1,$2,$3)',[project,'Cancel',owner]);
  await db.query("INSERT INTO tasks(id,project_id,title,description,stage,display_number) VALUES($1,$2,'Скриншоты текущей реализации сайта','Подготовить скриншоты','development',36)",[task,project]);
  registerTaskCancellationRoutes(app,{
   pool:db,uid:()=>owner,access:async()=>true,requireAdmin:async()=>true,
   decryptToken:()=>'' 
  });
  const preview=()=>app.inject({method:'GET',url:'/api/projects/'+project+'/tasks/'+task+'/cancel-preview'});
  let response=await preview();
  assert.equal(response.statusCode,200,response.body);
  assert.equal(Number(response.json().task.display_number),36);
  assert.deepEqual(response.json().blocked,[]);
  await db.query(`INSERT INTO agent_work_assignments(
   id,project_id,task_id,source_role,role,objective,acceptance,spec_version,status
  ) VALUES($1,$2,$3,'manager','testing','Проверить реальный сайт в браузере','Подтвердить скриншоты desktop и mobile',1,'running')`,
   [assignment,project,task]);
  response=await preview();
  assert.equal(response.statusCode,200,response.body);
  assert.ok(response.json().blocked.some(x=>/активный AI\/Temporal-процесс/.test(x)));
  await db.query("UPDATE agent_work_assignments SET status='completed' WHERE id=$1",[assignment]);
  await db.query(`INSERT INTO assistant_messages(
   id,project_id,task_id,actor_id,role,body,channel,status
  ) VALUES($1,$2,$3,$4,'user','Начать проверку','pm-internal','queued')`,
   [pmMessage,project,task,owner]);
  response=await preview();
  assert.ok(response.json().blocked.length>0,'queued PM inbox still owns this task');
  await db.query("UPDATE assistant_messages SET status='completed' WHERE id=$1",[pmMessage]);
  response=await preview();
  assert.deepEqual(response.json().blocked,[],'past successful work does not prevent cancellation forever');
 }finally{
  await app.close();await db.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
 }
});

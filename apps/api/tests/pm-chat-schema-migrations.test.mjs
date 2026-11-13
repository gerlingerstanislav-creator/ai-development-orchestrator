import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {initProjectManagerSchema} from '../dist/project-manager.js';
import {initChatImages} from '../dist/chat-images.js';

const migrations=coreSchemaMigrations({analysis:'Аналитика'}).filter(m=>m.version<=5);
async function withSchema(fn){
 const schema='ado_pm_chat_v5_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 try{await fn(db);}
 finally{
  await db.end();
  await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
  await admin.end();
 }
}

test('fresh PostgreSQL schema creates PM history and chat attachments once in migration v5',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const objects=await db.query(`SELECT
   to_regclass('manager_messages') IS NOT NULL AS messages,
   to_regclass('manager_requests') IS NOT NULL AS requests,
   to_regclass('chat_images') IS NOT NULL AS images,
   to_regclass('idx_manager_messages_task') IS NOT NULL AS msg_index,
   to_regclass('idx_manager_requests_active') IS NOT NULL AS req_index,
   to_regclass('idx_chat_images_assistant') IS NOT NULL AS assistant_index,
   to_regclass('idx_chat_images_manager') IS NOT NULL AS manager_index`);
  assert.deepEqual(objects.rows[0],{
   messages:true,requests:true,images:true,msg_index:true,req_index:true,
   assistant_index:true,manager_index:true
  });
  const deps=await db.query(`SELECT conname FROM pg_constraint c
   JOIN pg_class t ON t.oid=c.conrelid
   WHERE t.relname='chat_images' AND c.contype IN ('f','c')`);
  const names=new Set(deps.rows.map(x=>x.conname));
  for(const name of ['chat_images_assistant_message_id_fkey','chat_images_manager_message_id_fkey','exactly_one_chat_message'])
   assert.ok(names.has(name),'Missing dependency/constraint '+name);
  const ledger=(await db.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(ledger.map(x=>x.version),[1,2,3,4,5]);
  assert.deepEqual(ledger.map(x=>x.checksum),[
   'ado-legacy-schema-baseline-v1',
   'ado-agent-audit-notes-queues-v2',
   'ado-quality-orchestration-pm-inbox-v3',
   'ado-merge-batch-ddl-v4',
   'ado-manager-chat-attachments-ddl-v5'
  ],'legacy migration identities are immutable');
 });
});

test('v5 adopts already created PM schema and attachments without dropping message history or running state',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.filter(m=>m.version<=4)),[1,2,3,4]);
  // Existing deployments ran these idempotent initializers on each startup.
  await initProjectManagerSchema(db);
  await initChatImages(db);
  const ids={user:randomUUID(),project:randomUUID(),task:randomUUID(),manager:randomUUID(),
   request:randomUUID(),assistant:randomUUID(),image1:randomUUID(),image2:randomUUID()};
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'pm-v5@example.test','hash')",[ids.user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Legacy project',$2,true)",[ids.project,ids.user]);
  await db.query("INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'Legacy PM task','Existing task')",[ids.task,ids.project]);
  await db.query("INSERT INTO manager_messages(id,project_id,task_id,actor_id,role,body,status) VALUES($1,$2,$3,$4,'user','Keep this decision','queued')",
   [ids.manager,ids.project,ids.task,ids.user]);
  await db.query("INSERT INTO manager_requests(id,project_id,task_id,source_key,kind,source_id,payload,status) VALUES($1,$2,$3,'preexisting','question',$4,$5,'open')",
   [ids.request,ids.project,ids.task,ids.manager,JSON.stringify({question:'Which option?'})]);
  await db.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status) VALUES($1,$2,$3,'user','PM request with attachment','project','queued')",
   [ids.assistant,ids.project,ids.user]);
  const data=Buffer.from([137,80,78,71,13,10,26,10]);
  await db.query(`INSERT INTO chat_images(id,project_id,task_id,assistant_message_id,manager_message_id,actor_id,name,mime_type,image_data)
   VALUES($1,$2,$3,$4,NULL,$5,'project.png','image/png',$6),
         ($7,$2,$3,NULL,$8,$5,'task.png','image/png',$6)`,
   [ids.image1,ids.project,ids.task,ids.assistant,ids.user,data,ids.image2,ids.manager]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[5]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const [message,request,images,project]=await Promise.all([
   db.query('SELECT body,status FROM manager_messages WHERE id=$1',[ids.manager]),
   db.query('SELECT payload,status FROM manager_requests WHERE id=$1',[ids.request]),
   db.query('SELECT id,name,assistant_message_id,manager_message_id,image_data FROM chat_images ORDER BY name'),
   db.query('SELECT agents_running FROM projects WHERE id=$1',[ids.project])
  ]);
  assert.deepEqual(message.rows[0],{body:'Keep this decision',status:'queued'});
  assert.deepEqual(request.rows[0],{payload:{question:'Which option?'},status:'open'});
  assert.equal(images.rows.length,2);
  assert.deepEqual(new Set(images.rows.map(x=>x.id)),new Set([ids.image1,ids.image2]));
  assert.deepEqual(images.rows.map(x=>x.image_data),[data,data]);
  assert.deepEqual(images.rows.find(x=>x.id===ids.image1).assistant_message_id,ids.assistant);
  assert.deepEqual(images.rows.find(x=>x.id===ids.image2).manager_message_id,ids.manager);
  assert.equal(project.rows[0].agents_running,true,'schema adoption must not stop autonomous agents');
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(x=>x.version),[1,2,3,4,5]);
 });
});

test('fresh v5 enforces exactly one existing parent message for each chat attachment',async()=>{
 await withSchema(async db=>{
  await runSchemaMigrations(db,migrations);
  const ids={user:randomUUID(),project:randomUUID(),task:randomUUID(),assistant:randomUUID(),manager:randomUUID()};
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'pm-v5-constraint@example.test','hash')",[ids.user]);
  await db.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Image constraints',$2)",[ids.project,ids.user]);
  await db.query("INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Existing task')",[ids.task,ids.project]);
  await db.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body) VALUES($1,$2,$3,'user','Chat')",[ids.assistant,ids.project,ids.user]);
  await db.query("INSERT INTO manager_messages(id,project_id,task_id,actor_id,role,body) VALUES($1,$2,$3,$4,'user','Task')",[ids.manager,ids.project,ids.task,ids.user]);
  const insert=(assistant,manager)=>db.query(`INSERT INTO chat_images(id,project_id,task_id,assistant_message_id,manager_message_id,actor_id,name,mime_type,image_data)
    VALUES($1,$2,$3,$4,$5,$6,'test.png','image/png',$7)`,[randomUUID(),ids.project,ids.task,assistant,manager,ids.user,Buffer.from('x')]);
  await assert.rejects(insert(null,null),/exactly_one_chat_message/);
  await assert.rejects(insert(ids.assistant,ids.manager),/exactly_one_chat_message/);
  await assert.rejects(insert(randomUUID(),null),/foreign key/);
  await insert(ids.assistant,null);
  await insert(null,ids.manager);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM chat_images')).rows[0].count,2);
 });
});

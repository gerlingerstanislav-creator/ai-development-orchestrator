import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {chatFilesSchema,validateChatFiles,saveChatFiles,readPmChatFileContext,registerChatFileRoutes} from '../dist/chat-files.js';

const input=(name,content)=>({name,mimeType:'application/octet-stream',
 data:Buffer.from(content).toString('base64')});
test('chat file uploads enforce safe extensions, magic bytes and explicit size limits',()=>{
 assert.equal(chatFilesSchema.parse([input('requirements.md','ok')]).length,1);
 assert.equal(validateChatFiles([input('requirements.md','ok')])[0].mimeType,'text/markdown');
 assert.throws(()=>validateChatFiles([input('run.exe','binary')]),/Разрешены файлы/);
 assert.throws(()=>validateChatFiles([input('file.pdf','fake pdf')]),/неверный формат/);
 assert.throws(()=>validateChatFiles([input('archive.zip','fake zip')]),/неверный формат/);
 assert.throws(()=>validateChatFiles([input('too-big.md','a'.repeat(2*1024*1024+1))]),/2 МБ/);
 assert.throws(()=>validateChatFiles([input('../secrets.txt','text')]),/Разрешены файлы/);
 const good=Buffer.from('%PDF-1.7\nsmall document');
 assert.equal(validateChatFiles([input('reference.pdf',good)])[0].mimeType,'application/pdf');
});
test('chat attachment is persisted, readable only in scoped project, and downloadable as byte-exact file',async t=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='chat_files_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 const app=Fastify();
 t.after(async()=>{
  await app.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
 });
 await runSchemaMigrations(pool,coreSchemaMigrations({analysis:'Анализ'}));
 const id={project:randomUUID(),actor:randomUUID(),message:randomUUID(),other:randomUUID()};
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'chat-files@example.test','hash')",[id.actor]);
 await pool.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'File uploads',$2)",[id.project,id.actor]);
 await pool.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status) VALUES($1,$2,$3,'user','Проанализируй приложенный файл','project','queued')",[id.message,id.project,id.actor]);
 const original='Задача #42: локальная сборка и скриншоты';
 const saved=validateChatFiles([input('requirements.txt',original)]);
 await saveChatFiles(pool,{projectId:id.project,actorId:id.actor,messageId:id.message,files:saved});
 const context=await readPmChatFileContext(pool,id.project,id.message);
 assert.equal(context.length,1);assert.equal(context[0].content,original);assert.equal(context[0].readable,true);
 const row=(await pool.query("SELECT id,name,size_bytes,sha256 FROM chat_files WHERE project_id=$1",[id.project])).rows[0];
 assert.equal(row.size_bytes,Buffer.byteLength(original));
 assert.equal(row.sha256.trim(),createHash('sha256').update(original).digest('hex'));
 registerChatFileRoutes(app,{pool,access:async(req,reply,projectId)=>{
  if(req.headers['x-allowed-project']!==projectId){reply.code(403).send({error:'Forbidden'});return false;}
  return true;
 }});
 const url='/api/projects/'+id.project+'/chat-files/'+row.id;
 const good=await app.inject({method:'GET',url,headers:{'x-allowed-project':id.project}});
 assert.equal(good.statusCode,200,good.body);
 assert.equal(good.rawPayload.toString(),original);
 assert.match(good.headers['content-disposition'],/attachment/);
 assert.equal(good.headers['x-content-type-options'],'nosniff');
 const denied=await app.inject({method:'GET',url,headers:{'x-allowed-project':id.other}});
 assert.equal(denied.statusCode,403);
 const mismatched=await app.inject({method:'GET',url:'/api/projects/'+id.other+'/chat-files/'+row.id,
  headers:{'x-allowed-project':id.other}});
 assert.equal(mismatched.statusCode,404);
});

test('task manager and project PM share the attachment store without mixing their message IDs',async t=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='task_chat_files_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();});
 await runSchemaMigrations(pool,coreSchemaMigrations({analysis:'Анализ'}));
 const ids={user:randomUUID(),project:randomUUID(),task:randomUUID(),manager:randomUUID()};
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'task-chat-files@example.test','hash')",[ids.user]);
 await pool.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Task chat files',$2)",[ids.project,ids.user]);
 await pool.query("INSERT INTO tasks(id,project_id,title,stage) VALUES($1,$2,'Task',$3)",[ids.task,ids.project,'backlog']);
 await pool.query("INSERT INTO manager_messages(id,project_id,task_id,actor_id,role,body,status) VALUES($1,$2,$3,$4,'user','See attached spec','queued')",[ids.manager,ids.project,ids.task,ids.user]);
 await saveChatFiles(pool,{projectId:ids.project,taskId:ids.task,actorId:ids.user,
  messageId:ids.manager,scope:'manager',files:validateChatFiles([input('spec.md','# Acceptance\n- Screenshot works')])});
 const rows=await pool.query('SELECT id,assistant_message_id,manager_message_id,task_id FROM chat_files WHERE project_id=$1',[ids.project]);
 assert.equal(rows.rowCount,1);
 assert.equal(rows.rows[0].assistant_message_id,null);
 assert.equal(rows.rows[0].manager_message_id,ids.manager);
 assert.equal(rows.rows[0].task_id,ids.task);
 const context=await readPmChatFileContext(pool,ids.project,ids.manager,'manager');
 assert.match(context[0].content,/Screenshot works/);
 assert.deepEqual(await readPmChatFileContext(pool,ids.project,ids.manager,'assistant'),[]);
});

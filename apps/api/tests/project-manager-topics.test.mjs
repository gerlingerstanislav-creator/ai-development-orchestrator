import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {registerAssistantRoutes} from '../dist/assistant.js';

test('closed PM discussions disappear from sidebar without hiding any messages from the main chat',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pm_topics_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 const app=Fastify();
 t.after(async()=>{await app.close();await pool.end();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query(`
  CREATE TABLE project_chat_topics(id uuid PRIMARY KEY,project_id uuid,title text,status text DEFAULT 'open',created_at timestamptz DEFAULT now(),closed_at timestamptz);
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,task_id uuid,role text,body text,channel text DEFAULT 'project',status text DEFAULT 'completed',reply_to uuid,topic_id uuid,pm_request_id uuid,created_task_id uuid,created_document_id uuid,created_at timestamptz DEFAULT now(),documentation_reset_requested boolean DEFAULT false,owner_question_cleanup_requested boolean DEFAULT false);
  CREATE TABLE chat_images(id uuid PRIMARY KEY,project_id uuid,assistant_message_id uuid,name text,mime_type text,created_at timestamptz DEFAULT now());
 `);
 registerAssistantRoutes(app,{pool,uid:()=>randomUUID(),access:async()=>true,requireAdmin:async()=>true,
  codexUrl:'http://localhost:9999',runnerKey:'unused',decryptToken:value=>value,startDocumentationWorkflow:async()=>{}});
 const project=randomUUID(),topic=randomUUID(),active=randomUUID(),userMessage=randomUUID();
 // A topic retains its messages after being closed. An unrelated original question stays in the main chat.
 await db.query("INSERT INTO project_chat_topics(id,project_id,title,status) VALUES($1,$2,'Решённая проблема','closed'),($3,$2,'Новая проблема','open')",[topic,project,active]);
 await db.query("INSERT INTO assistant_messages(id,project_id,role,body) VALUES($1,$2,'user','Исходный вопрос')",[userMessage,project]);
 await db.query("INSERT INTO assistant_messages(id,project_id,role,body,topic_id) VALUES($1,$2,'assistant','Вопрос решён',$3)",[randomUUID(),project,topic]);
 await db.query("INSERT INTO assistant_messages(id,project_id,role,body,topic_id) VALUES($1,$2,'assistant','Нужно ваше решение',$3)",[randomUUID(),project,active]);
 const base='/api/projects/'+project+'/assistant';
 const topics=await app.inject({method:'GET',url:base+'/topics'});
 assert.equal(topics.statusCode,200,topics.body);
 assert.deepEqual(topics.json().map(item=>item.title),['Новая проблема']);
 const messages=await app.inject({method:'GET',url:base+'/messages?mode=project'});
 assert.equal(messages.statusCode,200,messages.body);
 assert.deepEqual(messages.json().map(message=>message.body),['Исходный вопрос','Вопрос решён','Нужно ваше решение']);
 assert.equal(messages.json()[0].topic_id,null);
 assert.equal(messages.json()[1].topic_title,'Решённая проблема');
 await db.query("UPDATE project_chat_topics SET status='closed',closed_at=now() WHERE id=$1",[active]);
 const empty=await app.inject({method:'GET',url:base+'/topics'});
 assert.deepEqual(empty.json(),[],'resolved discussion must disappear immediately');
 assert.equal((await app.inject({method:'GET',url:base+'/messages'})).json().length,3,'history is preserved for the PM');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {executeAgentTool} from '../dist/agent-tool-executor.js';

test('task history is scoped, complete across sources and cursor-paginated',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='task_history_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
 CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid NOT NULL);
 CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid NOT NULL,task_id uuid,role text,body text,channel text,created_at timestamptz);
 CREATE TABLE task_agent_notes(id uuid PRIMARY KEY,project_id uuid NOT NULL,task_id uuid NOT NULL,author_stage text,kind text,body text,target_stage text,created_at timestamptz);
 CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid NOT NULL,event text,detail text,created_at timestamptz);`);
 const project=randomUUID(),otherProject=randomUUID(),task=randomUUID(),otherTask=randomUUID(),owner=randomUUID();
 await db.query('INSERT INTO tasks VALUES($1,$2),($3,$4)',[task,project,otherTask,otherProject]);
 for(let i=0;i<12;i++){
  await db.query("INSERT INTO assistant_messages VALUES($1,$2,$3,'user',$4,'project',$5)",
   [randomUUID(),project,task,'message-'+i,new Date(Date.UTC(2026,0,1,0,i,0)).toISOString()]);
 }
 await db.query("INSERT INTO task_agent_notes VALUES($1,$2,$3,'testing','observation','QA note','all',$4)",
  [randomUUID(),project,task,new Date(Date.UTC(2026,0,1,0,13,0)).toISOString()]);
 await db.query("INSERT INTO task_events VALUES($1,$2,'stage_changed','Разработка', $3)",
  [randomUUID(),task,new Date(Date.UTC(2026,0,1,0,14,0)).toISOString()]);
 await db.query("INSERT INTO task_events VALUES($1,$2,'stage_changed','Сторонняя задача', $3)",
  [randomUUID(),otherTask,new Date(Date.UTC(2026,0,1,0,15,0)).toISOString()]);
 const session={id:randomUUID(),project_id:project,actor_id:owner,role:'development',task_id:task};
 const read=async(args)=>executeAgentTool(db,session,'tasks.history',{task_id:task,...args},async()=>{});
 const first=await read({limit:10});
 assert.equal(first.events.length,10);
 assert.ok(first.next_cursor);
 assert.equal(first.events[0].kind,'task_event');
 assert.equal(first.events[1].kind,'agent_note');
 const second=await read({limit:10,cursor:first.next_cursor});
 assert.equal(second.events.length,4);
 assert.equal(second.next_cursor,null);
 assert.equal(new Set([...first.events,...second.events].map(x=>x.id)).size,14);
 await assert.rejects(executeAgentTool(db,session,'tasks.history',{task_id:otherTask},async()=>{}),/другой задач/);
 await assert.rejects(read({cursor:'invalid',limit:10}),/курсор/);
});

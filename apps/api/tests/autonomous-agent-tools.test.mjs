import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAgentReaderSession,initAgentToolsSchema,readAgentSession,toolsForRole} from '../dist/agent-tools.js';
import {initTaskAgentNotesSchema} from '../dist/task-agent-notes.js';
import {executeAgentTool} from '../dist/agent-tool-executor.js';

test('specialists can consult and record/resolve blockers but cannot mutate workflow or other projects',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='autonomous_agents_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid REFERENCES users(id),deleted_at timestamptz);
  CREATE TABLE memberships(project_id uuid,user_id uuid,role text);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
  CREATE TABLE process_events(id uuid PRIMARY KEY,project_id uuid NOT NULL,process_id uuid NOT NULL,process_kind text,stage text,detail text,level text DEFAULT 'info',task_id uuid);
  CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid REFERENCES tasks(id),event text NOT NULL,detail text NOT NULL DEFAULT '');
 `);
 await initTaskAgentNotesSchema(db);
 await initAgentToolsSchema(db);
 const user=randomUUID(),p1=randomUUID(),p2=randomUUID(),t1=randomUUID(),t2=randomUUID(),run=randomUUID();
 await db.query('INSERT INTO users VALUES($1)',[user]);
 await db.query('INSERT INTO projects VALUES($1,$2,NULL),($3,$2,NULL)',[p1,user,p2]);
 await db.query('INSERT INTO tasks VALUES($1,$2),($3,$4)',[t1,p1,t2,p2]);
 assert.equal(toolsForRole('development').some(t=>t.name==='agents.consult'),true);
 assert.equal(toolsForRole('development').some(t=>t.name==='blockers.report'),true);
 assert.equal(toolsForRole('development').some(t=>t.name==='tasks.create'),false);
 assert.equal(toolsForRole('development',true).some(t=>t.name==='blockers.report'),false);
 const scope=await createAgentReaderSession(db,{projectId:p1,taskId:t1,processId:run,role:'development'});
 const session=await readAgentSession(db,scope.secret);
 assert.equal(session.read_only,false,'specialist is scoped but may perform safe mutations');
 const act=(name,args)=>executeAgentTool(db,session,name,args,async()=>{});
 const reported=await act('blockers.report',{task_id:t1,kind:'tool',summary:'Не хватает браузера для проверки поведения',
  evidence:'QA-кейс не может быть исполнен без браузерного инструмента',resolution_hint:'Помочь QA'});
 assert.equal(reported.status,'open');
 const listed=await act('blockers.list',{task_id:t1});
 assert.equal(listed.blockers.length,1);
 assert.equal(listed.blockers[0].kind,'tool');
 await assert.rejects(act('blockers.report',{task_id:t2,kind:'other',summary:'Другой проект недоступен',
  evidence:'Недостаточно сведений об этом проекте'}),/только для своей задачи/);
 const consult=await act('agents.consult',{task_id:t1,target_role:'architect',question:'Проверь, можно ли обойти техническое ограничение безопасным способом'});
 const consultAgain=await act('agents.consult',{task_id:t1,target_role:'architect',question:'Проверь, можно ли обойти техническое ограничение безопасным способом'});
 assert.equal(consult.note_id,consultAgain.note_id,'repeat requests must not duplicate questions');
 const note=(await db.query('SELECT target_stage,requires_customer,status FROM task_agent_notes WHERE id=$1',[consult.note_id])).rows[0];
 assert.equal(note.target_stage,'architect');
 assert.equal(note.requires_customer,false);
 assert.equal(note.status,'open');
 const closed=await act('blockers.resolve',{blocker_id:reported.id,resolution_evidence:'Браузерный исполнитель подключён и сценарий доступен для повторной проверки'});
 assert.equal(closed.status,'resolved');
 assert.equal((await act('blockers.list',{task_id:t1})).blockers[0].status,'resolved');
});

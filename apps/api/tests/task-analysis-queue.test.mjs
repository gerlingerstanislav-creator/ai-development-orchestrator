import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {initTaskAnalysisQueue,reconcileTaskAnalysisQueue} from '../dist/task-analysis-queue.js';

test('system analyst automatically owns analysis tasks, hands off completed work, and keeps unresolved questions in Analysis',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='analysis_queue_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid NOT NULL,iteration_id uuid,display_number int DEFAULT 1,
   type text NOT NULL DEFAULT 'task',stage text NOT NULL DEFAULT 'analysis',
   analysis_state text NOT NULL DEFAULT 'new',spec_version int NOT NULL DEFAULT 1,
   spec_review_status text NOT NULL DEFAULT 'current',spec_reviewed_version int NOT NULL DEFAULT 1,
   clarification_questions jsonb NOT NULL DEFAULT '[]'::jsonb,priority int NOT NULL DEFAULT 3,
   iteration_work_kind text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  CREATE TABLE project_ai_settings(project_id uuid,enabled boolean NOT NULL);
  CREATE TABLE project_role_capacity(project_id uuid,role text,capacity int);
  CREATE TABLE task_agent_notes(id uuid PRIMARY KEY,project_id uuid,task_id uuid,author_stage text,author_name text,
   target_stage text,kind text,body text,source_kind text,source_key text,status text,UNIQUE(task_id,source_key));
  CREATE TABLE task_events(id uuid,task_id uuid,event text,detail text);
  CREATE TABLE process_events(id uuid,project_id uuid,process_id uuid,process_kind text,stage text,detail text);
 `);
 await initTaskAnalysisQueue(db);
 const project=randomUUID(),ready=randomUUID(),blocked=randomUUID(),newTask=randomUUID();
 await db.query('INSERT INTO projects VALUES($1)',[project]);
 await db.query('INSERT INTO project_ai_settings VALUES($1,true)',[project]);
 await db.query("INSERT INTO project_role_capacity VALUES($1,'analysis',1)",[project]);
 await db.query("INSERT INTO tasks(id,project_id,analysis_state) VALUES($1,$2,'ready_for_development'),($3,$2,'ready_for_development'),($4,$2,'new')",
  [ready,project,blocked,newTask]);
 await db.query("INSERT INTO task_agent_notes VALUES($1,$2,$3,'analysis','SA','all','question','Нужен ответ','agent','q-1','open')",
  [randomUUID(),project,blocked]);
 const started=[];
 const temporal=async()=>({workflow:{start:async(name,options)=>started.push({name,options})}});
 await reconcileTaskAnalysisQueue(db,temporal);
 const rows=await db.query('SELECT id,stage,analysis_state FROM tasks WHERE project_id=$1',[project]);
 const find=id=>rows.rows.find(row=>row.id===id);
 assert.equal(find(ready).stage,'development','ready analysis should move without an iteration launch');
 assert.equal(find(ready).analysis_state,'approved');
 assert.equal(find(blocked).stage,'analysis','unanswered owner question should block only its own task');
 assert.equal(find(newTask).analysis_state,'processing','available analysis task should be claimed automatically');
 assert.equal(started.length,1);
 assert.equal(started[0].name,'analyzeTaskStage');
 assert.equal(started[0].options.args.length,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM task_events WHERE task_id=$1 AND event='stage_changed'",[ready])).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM task_agent_notes WHERE task_id=$1 AND kind=$2',[ready,'handoff'])).rows[0].n,1);
});

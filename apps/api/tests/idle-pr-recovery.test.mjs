import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {reconcileIdlePullRequests} from '../dist/idle-pr-recovery.js';

test('only a proven completed PR is resumed; QA remains a separate real check',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='idle_pr_recovery_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await pool.query(`
  CREATE TABLE users(id uuid PRIMARY KEY,email text NOT NULL);
  CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid NOT NULL,agents_running boolean NOT NULL DEFAULT true,deleted_at timestamptz);
  CREATE TABLE project_ai_settings(project_id uuid PRIMARY KEY,enabled boolean NOT NULL);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid NOT NULL,type text NOT NULL DEFAULT 'task',
   stage text NOT NULL DEFAULT 'development',analysis_state text NOT NULL DEFAULT 'approved',
   pr_url text,git_branch text,pr_number integer,test_feedback text NOT NULL DEFAULT '',
   spec_review_status text NOT NULL DEFAULT 'current',updated_at timestamptz DEFAULT now());
  CREATE TABLE ai_task_runs(id uuid PRIMARY KEY,task_id uuid NOT NULL,status text,
   created_at timestamptz DEFAULT now(),completed_at timestamptz);
  CREATE TABLE ai_test_runs(id uuid PRIMARY KEY,task_id uuid NOT NULL,created_at timestamptz DEFAULT now());
  CREATE TABLE task_orchestration_owners(task_id uuid PRIMARY KEY,state text);
  CREATE TABLE iteration_execution_queue(task_id uuid PRIMARY KEY,status text);
  CREATE TABLE process_events(id uuid PRIMARY KEY,project_id uuid,process_id uuid,process_kind text,
   stage text,detail text,level text,task_id uuid,created_at timestamptz DEFAULT now());
 `);
 const [user,project,pausedProject,completed,alreadyQa,paused]=Array.from({length:6},randomUUID);
 await pool.query("INSERT INTO users VALUES($1,'admin@example.test')",[user]);
 await pool.query('INSERT INTO projects VALUES($1,$3,true,null),($2,$3,false,null)',[project,pausedProject,user]);
 await pool.query('INSERT INTO project_ai_settings VALUES($1,true),($2,true)',[project,pausedProject]);
 for(const [id,pid] of [[completed,project],[alreadyQa,project],[paused,pausedProject]]){
  await pool.query("INSERT INTO tasks(id,project_id,pr_url,git_branch,pr_number) VALUES($1,$2,$3,'fix/branch',34)",
   [id,pid,'https://github.com/example/repo/pull/34']);
  await pool.query("INSERT INTO ai_task_runs(id,task_id,status,created_at,completed_at) VALUES($1,$2,'completed',now()-interval '1 hour',now()-interval '45 minutes')",
   [randomUUID(),id]);
 }
 await pool.query("INSERT INTO ai_test_runs VALUES($1,$2,now()-interval '15 minutes')",[randomUUID(),alreadyQa]);
 const called=[];
 const recover=async input=>{
  called.push(input);
  await pool.query('INSERT INTO ai_test_runs VALUES($1,$2,now())',[randomUUID(),input.taskId]);
  return {ok:true,status:202,message:'QA started'};
 };
 const token=async(userId,email)=>{assert.equal(userId,user);assert.equal(email,'admin@example.test');return 'scoped-token';};
 await reconcileIdlePullRequests(pool,recover,token);
 assert.deepEqual(called,[{projectId:project,taskId:completed,auth:'Bearer scoped-token',cookie:''}]);
 assert.equal((await pool.query("SELECT stage FROM tasks WHERE id=$1",[completed])).rows[0].stage,'development',
  'reconciler itself cannot falsely assert a completed QA stage');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM process_events WHERE process_kind='recovery' AND stage='continued'")).rows[0].n,1);
 await reconcileIdlePullRequests(pool,recover,token);
 assert.equal(called.length,1,'an actual QA record makes the retry unnecessary');
});

test('failed recovery is visible and throttled rather than spinning every tick',async()=>{
 const queries=[];
 const task={project_id:randomUUID(),task_id:randomUUID(),owner_id:randomUUID(),email:'owner@example.test'};
 let queried=false;
 const db={query:async(sql,values)=>{
  queries.push({sql,values});
  if(sql.startsWith('SELECT t.id AS task_id')){if(queried)return {rows:[]};queried=true;return {rows:[task]};}
  return {rows:[],rowCount:1};
 }};
 const failed=async()=>{throw Error('GitHub unavailable');};
 await reconcileIdlePullRequests(db,failed,async()=> 'scoped');
 assert.equal(queries.filter(x=>x.sql.includes("process_kind,stage,detail,level")).length,1);
 const event=queries.find(x=>x.sql.includes("process_kind,stage,detail,level"));
 assert.equal(event.values[3],'blocked');
 assert.match(event.values[4],/GitHub unavailable/);
 assert.match(queries[0].sql,/2 minutes/,'recovery attempts must be durably rate-limited');
});

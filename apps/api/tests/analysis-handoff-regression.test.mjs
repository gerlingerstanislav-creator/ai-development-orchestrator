import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {initAnalysisFirstGate} from '../dist/analysis-first-gate.js';
import {initTaskAnalysisQueue,reconcileTaskAnalysisQueue,reuseExistingAnalysisForDevelopment} from '../dist/task-analysis-queue.js';
import {registerProjectManagerRoutes} from '../dist/project-manager.js';

test('completed, clearly specified analysis passes technical consultations, even when agents are paused',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='analysis_handoff_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY,agents_running boolean NOT NULL DEFAULT false);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),
   iteration_id uuid,display_number int DEFAULT 1,title text DEFAULT 'Eight parallel colored lines',
   priority int NOT NULL DEFAULT 3,created_at timestamptz NOT NULL DEFAULT now(),
   type text NOT NULL DEFAULT 'task',stage text NOT NULL DEFAULT 'analysis',
   analysis_state text NOT NULL DEFAULT 'new',spec_version int NOT NULL DEFAULT 1,
   spec_review_status text NOT NULL DEFAULT 'current',spec_reviewed_version int NOT NULL DEFAULT 1,
   pr_url text,git_branch text,
   clarification_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
   updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid,event text,detail text,actor_id uuid);
  CREATE TABLE ai_task_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid,status text,runner_spec_version int);
  CREATE TABLE task_orchestration_owners(task_id uuid,state text);
  CREATE TABLE task_agent_notes(id uuid PRIMARY KEY,project_id uuid,task_id uuid,
   kind text,status text,target_stage text DEFAULT 'all',requires_customer boolean NOT NULL DEFAULT false,
   author_stage text DEFAULT 'analysis',author_name text DEFAULT 'Agent',
   body text DEFAULT '',source_kind text DEFAULT 'agent',source_key text,
   UNIQUE(task_id,source_key));
  CREATE TABLE project_ai_settings(project_id uuid,enabled boolean);
  CREATE TABLE project_role_capacity(project_id uuid,role text,capacity int);
  CREATE TABLE process_events(id uuid,project_id uuid,process_id uuid,process_kind text,stage text,detail text);
 `);
 await initTaskAnalysisQueue(db);
 const project=randomUUID();
 const [readyTech,readyOwner,waitingRecovered,unverified,resumePrevious,resumeOwner,actorId]=Array.from({length:7},randomUUID);
 await db.query('INSERT INTO projects(id,agents_running) VALUES($1,false)',[project]);
 await db.query('INSERT INTO project_ai_settings VALUES($1,true)',[project]);
 await db.query("INSERT INTO tasks(id,project_id,analysis_state) VALUES($1,$5,'ready_for_development'),($2,$5,'ready_for_development'),($3,$5,'waiting_questions'),($4,$5,'ready_for_development')",
  [readyTech,readyOwner,waitingRecovered,unverified,project]);
 for(const id of [readyTech,readyOwner,waitingRecovered])
  await db.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'analysis_completed','Requirements confirmed')",[randomUUID(),id]);
 await db.query("INSERT INTO tasks(id,project_id,analysis_state,pr_url,git_branch) VALUES($1,$3,'new','https://github.com/example/repo/pull/2','fix/prior-work'),($2,$3,'new','https://github.com/example/repo/pull/3','fix/prior-owner')",
  [resumePrevious,resumeOwner,project]);
 for(const taskId of [resumePrevious,resumeOwner])
  await db.query("INSERT INTO ai_task_runs VALUES($1,$2,$3,'failed')",[randomUUID(),project,taskId]);
 await db.query("INSERT INTO agent_analysis_runs(id,project_id,task_id,spec_version,status) VALUES($1,$2,$3,1,'completed')",
  [randomUUID(),project,waitingRecovered]);
 const addNote=(id,target,requiresCustomer)=>db.query("INSERT INTO task_agent_notes(id,project_id,task_id,kind,status,target_stage,requires_customer,source_key) VALUES($1,$2,$3,'question','open',$4,$5,$6)",
  [randomUUID(),project,id,target,requiresCustomer,'note:'+randomUUID()]);
 await addNote(readyTech,'devops',false);
 await addNote(waitingRecovered,'architect',false);
 await addNote(readyOwner,'analysis',true);
 await addNote(resumeOwner,'analysis',true);
 await initAnalysisFirstGate(db);
 assert.equal(await reuseExistingAnalysisForDevelopment(db,project,resumePrevious,actorId),true);
 assert.equal(await reuseExistingAnalysisForDevelopment(db,project,resumeOwner,actorId),false,
  'unanswered owner questions cannot be waived by resuming a PR');
 assert.equal((await db.query('SELECT analysis_state FROM tasks WHERE id=$1',[unverified])).rows[0].analysis_state,'new',
  'unverified legacy ready state must not bypass analyst approval');
 const temporal=async()=>({workflow:{start:async()=>{throw Error('Paused project must not run agents');}}});
 await reconcileTaskAnalysisQueue(db,temporal);
 const state=async id=>(await db.query('SELECT stage,analysis_state FROM tasks WHERE id=$1',[id])).rows[0];
 assert.deepEqual(await state(readyTech),{stage:'development',analysis_state:'approved'});
 assert.deepEqual(await state(resumePrevious),{stage:'development',analysis_state:'approved'},
  'previous PR can resume on explicit owner approval without repeated analysis');
 assert.deepEqual(await state(resumeOwner),{stage:'analysis',analysis_state:'new'});
 assert.equal((await db.query("SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND event='analysis_reused_by_owner'",[resumePrevious])).rows[0].n,1);
 assert.deepEqual(await state(waitingRecovered),{stage:'development',analysis_state:'approved'},
  'prior completed analysis is reused rather than repeated over technical questions');
 assert.deepEqual(await state(readyOwner),{stage:'analysis',analysis_state:'ready_for_development'});
 assert.deepEqual(await state(unverified),{stage:'analysis',analysis_state:'new'});
 await assert.rejects(
  db.query("UPDATE tasks SET stage='development',analysis_state='approved' WHERE id=$1",[readyOwner]),
  {code:'23514'},'owner decisions remain protected by the database trigger');
 await assert.rejects(
  db.query("UPDATE tasks SET stage='development',analysis_state='approved' WHERE id=$1",[unverified]),
  {code:'23514'},'manual edits cannot bypass a missing analyst outcome');
 assert.equal((await db.query("SELECT count(*)::int AS n FROM task_agent_notes WHERE status='open'")).rows[0].n,4,
  'technical and owner questions are retained for visibility');
});

test('PM start-development action uses the real work-queue endpoint',async t=>{
 const app=Fastify();
 t.after(()=>app.close());
 const projectId=randomUUID(),taskId=randomUUID(),messageId=randomUUID(),actorId=randomUUID();
 let launches=0;
 app.post('/api/projects/:id/tasks/:taskId/run-ai',async req=>{
  launches++;
  assert.deepEqual(req.body,{approveAnalysis:true});
  return {id:randomUUID(),status:'queued'};
 });
 const pool={query:async sql=>{
  if(sql.startsWith('SELECT m.actor_id'))return {rows:[{actor_id:actorId,email:'admin@example.test',body:'Переведи в разработку'}],rowCount:1};
  if(sql.startsWith('SELECT id,title,description,stage'))return {rows:[{id:taskId,stage:'analysis',analysis_state:'ready_for_development',spec_version:1}],rowCount:1};
  return {rows:[],rowCount:0};
 }};
 registerProjectManagerRoutes(app,{pool,workerSecret:'test-secret',
  uid:()=>actorId,access:async()=>true,requireAdmin:async()=>true,
  workerAuthorization:async()=> 'Bearer scoped',
  decideAction:async()=>({action:'start_development'}),startManagerWorkflow:async()=>{},
  recoverTask:async()=>{throw Error('Already-approved analysis must enqueue rather than rerun development');}
 });
 const response=await app.inject({method:'POST',url:'/internal/manager/continue',
  headers:{'x-runner-secret':'test-secret'},
  payload:{projectId,taskId,messageId,analysisActions:true}});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().handled,true);
 assert.match(response.json().message,/передана в разработку/);
 assert.equal(launches,1);
});

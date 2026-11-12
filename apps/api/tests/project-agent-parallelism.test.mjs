import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {initAgentWorkQueue,reconcileAgentWorkQueue,readDevelopmentQueue} from '../dist/agent-work-scheduler.js';
import {initTaskOrchestrationSchema} from '../dist/task-orchestration.js';

test('the development dispatcher fills each project capacity in the same reconciliation',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='agent_isolation_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{
  await db.end();
  await admin.query('DROP SCHEMA '+schema+' CASCADE');
  await admin.end();
 });
 await db.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid,deleted_at timestamptz,agents_running boolean NOT NULL DEFAULT true);
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE project_iterations(id uuid PRIMARY KEY,project_id uuid,revision int,approved_revision int);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,iteration_id uuid,title text DEFAULT '',display_number int DEFAULT 1,
   type text DEFAULT 'task',stage text DEFAULT 'analysis',analysis_state text DEFAULT 'ready_for_development',
   spec_version int DEFAULT 1,spec_reviewed_version int DEFAULT 1,spec_review_status text DEFAULT 'current',
   clarification_questions jsonb DEFAULT '[]',priority int DEFAULT 2,depends_on_task_id uuid,git_branch text,pr_url text,
   pr_base_branch text,test_feedback text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  CREATE TABLE project_ai_settings(project_id uuid,enabled boolean,model text,reasoning text);
  CREATE TABLE project_agent_models(project_id uuid,role text,model text);
  CREATE TABLE project_role_capacity(project_id uuid,role text,capacity int);
  CREATE TABLE project_git_repositories(project_id uuid,connection_id uuid);
  CREATE TABLE connections(id uuid,provider text);
  CREATE TABLE task_agent_notes(task_id uuid,project_id uuid,kind text,status text,target_stage text NOT NULL DEFAULT 'all',requires_customer boolean NOT NULL DEFAULT false);
  CREATE TABLE agent_peer_queue(project_id uuid,role text,status text);
  CREATE TABLE ai_task_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid,triggered_by uuid,model text,status text,message text DEFAULT '',cycle_id uuid,cycle_attempt int,created_at timestamptz DEFAULT now());
  CREATE TABLE ai_test_runs(id uuid PRIMARY KEY,task_id uuid,status text,verdict text,completed_at timestamptz DEFAULT now());
  CREATE TABLE process_events(id uuid,project_id uuid,process_id uuid,process_kind text,stage text,detail text);
  CREATE TABLE task_events(id uuid,task_id uuid,actor_id uuid,event text,detail text);
  CREATE TABLE iteration_execution_queue(project_id uuid,iteration_id uuid NOT NULL,task_id uuid,requested_by uuid,
   status text DEFAULT 'queued' CHECK(status IN ('queued','dispatching','dispatched','cancelled')),run_id uuid,
   detail text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(project_id,task_id));
 `);
 await initTaskOrchestrationSchema(db);
 await initAgentWorkQueue(db);
 const actor=randomUUID(),connection=randomUUID(),projects=[randomUUID(),randomUUID()];
 const projectTasks=projects.map(()=>Array.from({length:3},randomUUID));
 await db.query('INSERT INTO users VALUES($1)',[actor]);
 await db.query("INSERT INTO connections VALUES($1,'github_token')",[connection]);
 for(const [index,project] of projects.entries()){
  await db.query('INSERT INTO projects(id,owner_id) VALUES($1,$2)',[project,actor]);
  await db.query("INSERT INTO project_ai_settings VALUES($1,true,'gpt-6-luna','low')",[project]);
  await db.query('INSERT INTO project_git_repositories VALUES($1,$2)',[project,connection]);
  await db.query("INSERT INTO project_role_capacity VALUES($1,'development',$2)",[project,index===0?2:1]);
  await db.query("INSERT INTO tasks(id,project_id,stage,analysis_state) SELECT unnest($1::uuid[]),$2,'development','approved'",
   [projectTasks[index],project]);
 }
 const starts=[];
 const temporal=async()=>({workflow:{start:async(name,options)=>{starts.push({name,...options});}}});
 const counts=async()=>{
  const rows=await db.query("SELECT project_id,count(*)::int AS count FROM ai_task_runs GROUP BY project_id");
  return Object.fromEntries(rows.rows.map(row=>[row.project_id,row.count]));
 };
 await reconcileAgentWorkQueue(db,temporal);
 assert.equal(starts.length,3,'two developers in project A and one in project B launch in the same pass');
 assert.equal((await counts())[projects[0]],2);
 assert.equal((await counts())[projects[1]],1);
 const waitingA=await readDevelopmentQueue(db,projects[0]);
 const waitingB=await readDevelopmentQueue(db,projects[1]);
 assert.equal(waitingA.filter(row=>row.reason==='capacity').length,1);
 assert.equal(waitingB.filter(row=>row.reason==='capacity').length,2);

 await db.query("UPDATE project_role_capacity SET capacity=2 WHERE project_id=$1 AND role='development'",[projects[1]]);
 await reconcileAgentWorkQueue(db,temporal);
 assert.equal((await counts())[projects[0]],2,'project A is still capped at two');
 assert.equal((await counts())[projects[1]],2,'project B capacity update does not affect project A');
 await db.query("UPDATE project_role_capacity SET capacity=3 WHERE project_id=$1 AND role='development'",[projects[0]]);
 await reconcileAgentWorkQueue(db,temporal);
 assert.equal((await counts())[projects[0]],3);
 assert.equal((await counts())[projects[1]],2);
 await reconcileAgentWorkQueue(db,temporal);
 assert.equal(starts.length,5,'reconciliation never launches duplicate workflow IDs');
 assert.equal(new Set(starts.map(start=>start.workflowId)).size,5);
 // Stop only project A. Its new developer work must remain queued while
 // project B is permitted to fill its own newly available slot.
 const fourth=randomUUID();
 await db.query("INSERT INTO tasks(id,project_id,stage,analysis_state) VALUES($1,$2,'development','approved')",[fourth,projects[0]]);
 await db.query('UPDATE projects SET agents_running=false WHERE id=$1',[projects[0]]);
 await db.query("UPDATE project_role_capacity SET capacity=3 WHERE project_id=$1 AND role='development'",[projects[1]]);
 await reconcileAgentWorkQueue(db,temporal);
 assert.equal((await counts())[projects[0]],3,'Stop must suspend only its own project');
 assert.equal((await counts())[projects[1]],3,'project B is unaffected by Stop in project A');
 assert.equal((await readDevelopmentQueue(db,projects[0])).find(row=>row.task_id===fourth).reason,'paused');
 await db.query('UPDATE projects SET agents_running=true WHERE id=$1',[projects[0]]);
 await db.query("UPDATE project_role_capacity SET capacity=4 WHERE project_id=$1 AND role='development'",[projects[0]]);
 await reconcileAgentWorkQueue(db,temporal);
 assert.equal((await counts())[projects[0]],4,'Play restarts queued work without duplicates');
 assert.equal(starts.length,7);
 assert.equal(new Set(starts.map(start=>start.workflowId)).size,7);
});

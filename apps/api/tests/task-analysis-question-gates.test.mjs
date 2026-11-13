import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {initTaskAnalysisQueue,reconcileTaskAnalysisQueue} from '../dist/task-analysis-queue.js';
import {pendingAgentQuestions,resolveAgentQuestionsForReview} from '../dist/task-agent-notes.js';

test('technical consultations do not deadlock analysis, while real owner questions remain mandatory',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='analysis_question_gate_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY,agents_running boolean NOT NULL DEFAULT true);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),
   iteration_id uuid,display_number int DEFAULT 1,title text DEFAULT 'Test task',
   priority int DEFAULT 2,created_at timestamptz NOT NULL DEFAULT now(),
   type text DEFAULT 'task',stage text DEFAULT 'analysis',
   analysis_state text DEFAULT 'new',spec_version int DEFAULT 1,
   spec_review_status text NOT NULL DEFAULT 'current',spec_reviewed_version int NOT NULL DEFAULT 1,
   pr_url text,git_branch text,
   clarification_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
   updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE task_agent_notes(id uuid PRIMARY KEY,project_id uuid,task_id uuid,
   kind text,status text,target_stage text DEFAULT 'all',requires_customer boolean NOT NULL DEFAULT false,
   author_stage text DEFAULT 'analysis',author_name text DEFAULT 'Агент',
   body text DEFAULT 'Технический вопрос',source_kind text DEFAULT 'agent',
   source_key text,created_at timestamptz DEFAULT now(),UNIQUE(task_id,source_key));
  CREATE TABLE project_ai_settings(project_id uuid,enabled boolean);
  CREATE TABLE project_role_capacity(project_id uuid,role text,capacity int);
  CREATE TABLE task_events(id uuid,task_id uuid,event text,detail text);
  CREATE TABLE process_events(id uuid,project_id uuid,process_id uuid,process_kind text,stage text,detail text);
  CREATE TABLE task_requirement_reviews(task_id uuid,project_id uuid,spec_version int,status text,classification text,created_at timestamptz DEFAULT now(),resolved_at timestamptz);
 `);
 await initTaskAnalysisQueue(db);
 const project=randomUUID();
 const [readyTech,newTech,waitingTech,readyOwner,newOwner,legacyOwner]=Array.from({length:6},randomUUID);
 await db.query('INSERT INTO projects VALUES($1,true)',[project]);
 await db.query('INSERT INTO project_ai_settings VALUES($1,true)',[project]);
 await db.query("INSERT INTO project_role_capacity VALUES($1,'analysis',5)",[project]);
 await db.query("INSERT INTO tasks(id,project_id,stage,analysis_state) VALUES($1,$7,'analysis','ready_for_development'),($2,$7,'analysis','new'),($3,$7,'analysis','waiting_questions'),($4,$7,'analysis','ready_for_development'),($5,$7,'analysis','new'),($6,$7,'analysis','new')",
  [readyTech,newTech,waitingTech,readyOwner,newOwner,legacyOwner,project]);
 const insertNote=async(taskId,target,requiresCustomer)=>{
  const id=randomUUID();
  await db.query("INSERT INTO task_agent_notes(id,project_id,task_id,kind,status,target_stage,requires_customer,source_key) VALUES($1,$2,$3,'question','open',$4,$5,$6)",
   [id,project,taskId,target,requiresCustomer,'question:'+id]);
  return id;
 };
 await insertNote(readyTech,'devops',false);
 await insertNote(newTech,'architect',false);
 await insertNote(waitingTech,'devops',false);
 const readyOwnerNote=await insertNote(readyOwner,'all',true);
 const newOwnerNote=await insertNote(newOwner,'analysis',true);
 await insertNote(legacyOwner,'all',false);

 assert.equal(await pendingAgentQuestions(db,project,readyTech),0);
 assert.equal(await pendingAgentQuestions(db,project,readyOwner),1);
 assert.equal((await resolveAgentQuestionsForReview(db,project,newTech,1)).remaining,0);
 assert.equal((await resolveAgentQuestionsForReview(db,project,newOwner,1)).remaining,1);

 const starts=[];
 const temporal=async()=>({workflow:{start:async(name,opts)=>starts.push({name,taskRunId:opts.args[0]})}});
 await reconcileTaskAnalysisQueue(db,temporal);

 const state=async id=>(await db.query('SELECT stage,analysis_state FROM tasks WHERE id=$1',[id])).rows[0];
 assert.deepEqual(await state(readyTech),{stage:'development',analysis_state:'approved'},
  'completed analysis can hand off despite open technical consultation');
 assert.equal((await state(newTech)).analysis_state,'processing',
  'new analysis should be scheduled despite internal architect question');
 assert.equal((await state(waitingTech)).analysis_state,'processing',
  'previously stuck waiting_questions must be recovered and retried');
 assert.deepEqual(await state(readyOwner),{stage:'analysis',analysis_state:'ready_for_development'},
  'explicit owner question blocks handoff');
 assert.equal((await state(newOwner)).analysis_state,'new',
  'explicit owner question blocks new analysis');
 assert.equal((await state(legacyOwner)).analysis_state,'new',
  'legacy all-stage owner question remains blocking');
 assert.equal(starts.length,2);
 assert.equal((await db.query("SELECT count(*)::int AS count FROM task_agent_notes WHERE kind='question' AND status='open'")).rows[0].count,6,
  'technical questions remain visible; the system must not fake answers');
 await db.query("UPDATE task_agent_notes SET status='answered' WHERE id=ANY($1::uuid[])",[[readyOwnerNote,newOwnerNote]]);
 await reconcileTaskAnalysisQueue(db,temporal);
 assert.equal((await state(readyOwner)).stage,'development');
 assert.equal((await state(newOwner)).analysis_state,'processing');
 assert.equal((await state(legacyOwner)).analysis_state,'new');
});

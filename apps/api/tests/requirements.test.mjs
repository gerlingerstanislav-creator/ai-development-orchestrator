import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {initRequirementsSchema,saveSpecRevision,reconcileTaskRequirements} from '../dist/requirements.js';

test('spec revisions, analyst reconciliation and human-approval gate persist in PostgreSQL',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const userId=randomUUID(),projectId=randomUUID(),taskId=randomUUID();
 try{
  await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)');
  await pool.query('CREATE TABLE projects (id uuid PRIMARY KEY)');
  await pool.query("CREATE TABLE tasks (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),title text NOT NULL,description text NOT NULL)");
  await pool.query("CREATE TABLE workflow_stages (project_id uuid NOT NULL,stage text NOT NULL,agent_name text NOT NULL DEFAULT '',agent_instructions text NOT NULL DEFAULT '')");
  await pool.query("CREATE TABLE project_rules (project_id uuid NOT NULL,body text NOT NULL,created_at timestamptz DEFAULT now())");
  await pool.query('CREATE TABLE qa_test_plans (id uuid PRIMARY KEY)');
  await pool.query('CREATE TABLE ai_test_runs (id uuid PRIMARY KEY)');
  await pool.query('INSERT INTO users(id) VALUES($1)',[userId]);
  await pool.query('INSERT INTO projects(id) VALUES($1)',[projectId]);
  await pool.query('INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,$3,$4)',[taskId,projectId,'Search','Users can search by title']);
  await pool.query("INSERT INTO workflow_stages(project_id,stage,agent_name) VALUES($1,'analysis','AI-аналитик')",[projectId]);
  await initRequirementsSchema(pool);

  const before=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
  assert.equal(before.spec_version,1);
  assert.equal(before.spec_review_status,'current');
  assert.equal((await pool.query('SELECT count(*)::int AS total FROM task_spec_versions WHERE task_id=$1',[taskId])).rows[0].total,1);

  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await saveSpecRevision(client,before,{title:'Search',description:'Users can search by title and filter active results',origin:'user',actorId:userId});
   await client.query('COMMIT');
  }finally{client.release();}
  let task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
  assert.equal(task.spec_version,2);
  assert.equal(task.spec_review_status,'pending');
  assert.equal(task.spec_reviewed_version,1);

  let calls=0;
  const aligned=await reconcileTaskRequirements(pool,{projectId,taskId,commitSha:'',prEvidence:'PR ещё не создан'},async()=>{
   calls++;
   return JSON.stringify({classification:'aligned',summary:'User requirement is consistent',proposed_description:task.description,questions:[]});
  });
  assert.equal(aligned,'current');
  assert.equal(calls,1);
  task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
  assert.equal(task.spec_review_status,'current');
  assert.equal(task.spec_reviewed_version,2);

  const propose=await reconcileTaskRequirements(pool,{projectId,taskId,commitSha:'sha-1',prEvidence:'Changing response behavior'},async()=>JSON.stringify({
   classification:'material_change',summary:'API now filters results differently',proposed_description:'Users can search by title and filter active results, ordered by creation date',questions:[]
  }));
  assert.equal(propose,'needs_approval');
  task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
  assert.equal(task.spec_version,2);
  assert.equal(task.spec_review_status,'needs_approval');
  assert.equal(task.description,'Users can search by title and filter active results');
  const review=(await pool.query("SELECT * FROM task_requirement_reviews WHERE task_id=$1 AND status='needs_approval'",[taskId])).rows[0];
  assert.equal(review.commit_sha,'sha-1');
  assert.match(review.proposed_description,/creation date/);

  // A proposal is not silently accepted; a subsequent edit invalidates it.
  const editor=await pool.connect();
  try{
   await editor.query('BEGIN');
   const locked=(await editor.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
   await saveSpecRevision(editor,locked,{title:locked.title,description:'Users can search by title and active state with pagination',origin:'user',actorId:userId});
   await editor.query('COMMIT');
  }finally{editor.release();}
  task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
  assert.equal(task.spec_version,3);
  assert.equal(task.spec_review_status,'pending');
  assert.equal((await pool.query('SELECT count(*)::int AS total FROM task_spec_versions WHERE task_id=$1',[taskId])).rows[0].total,3);
 }finally{await pool.end();}
});

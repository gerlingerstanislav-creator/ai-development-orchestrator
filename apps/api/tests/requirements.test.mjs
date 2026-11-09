import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {initRequirementsSchema,saveSpecRevision,reconcileTaskRequirements} from '../dist/requirements.js';
import {initQaWaiverSchema} from '../dist/qa-waiver.js';
import {initTaskOrchestrationSchema,acquireTaskOrchestration,releaseTaskOrchestration} from '../dist/task-orchestration.js';
import {initTaskAgentNotesSchema,recordTaskAgentNote,taskNotesContext,pendingAgentQuestions,resolveAgentQuestionsForReview} from '../dist/task-agent-notes.js';
import {initTaskCancellationSchema,needsGitHubCleanup} from '../dist/task-cancellation.js';
import {initProjectManagerSchema} from '../dist/project-manager.js';

test('spec revisions, analyst reconciliation and human-approval gate persist in PostgreSQL',async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const userId=randomUUID(),projectId=randomUUID(),taskId=randomUUID();
 try{
  await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)');
  await pool.query('CREATE TABLE projects (id uuid PRIMARY KEY)');
  await pool.query("CREATE TABLE tasks (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),title text NOT NULL,description text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE workflow_stages (project_id uuid NOT NULL,stage text NOT NULL,agent_name text NOT NULL DEFAULT '',agent_instructions text NOT NULL DEFAULT '')");
  await pool.query("CREATE TABLE task_events (id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES tasks(id),event text NOT NULL,detail text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE project_rules (project_id uuid NOT NULL,body text NOT NULL,created_at timestamptz DEFAULT now())");
  await pool.query('CREATE TABLE qa_test_plans (id uuid PRIMARY KEY)');
  await pool.query("CREATE TABLE documents (id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text NOT NULL,body text NOT NULL DEFAULT '')");
  await pool.query('CREATE TABLE ai_test_runs (id uuid PRIMARY KEY)');
  await pool.query('INSERT INTO users(id) VALUES($1)',[userId]);
  await pool.query('INSERT INTO projects(id) VALUES($1)',[projectId]);
  await pool.query('INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,$3,$4)',[taskId,projectId,'Search','Users can search by title']);
  await pool.query("INSERT INTO workflow_stages(project_id,stage,agent_name) VALUES($1,'analysis','AI-аналитик')",[projectId]);
  await initRequirementsSchema(pool);
  await initQaWaiverSchema(pool);
  await initQaWaiverSchema(pool); // Startup migrations must be idempotent.
  await initTaskOrchestrationSchema(pool);
  await initTaskOrchestrationSchema(pool);
  await initTaskAgentNotesSchema(pool);
  await initTaskAgentNotesSchema(pool);
  await initProjectManagerSchema(pool);
  await initProjectManagerSchema(pool); // Idempotent migration on existing projects
  const managerMessageId=randomUUID(),managerRequestId=randomUUID();
  await pool.query("INSERT INTO manager_messages(id,project_id,task_id,actor_id,role,body,status) VALUES($1,$2,$3,$4,'user','Проверить окружность','queued')",[managerMessageId,projectId,taskId,userId]);
  assert.equal((await pool.query('SELECT status FROM manager_messages WHERE id=$1',[managerMessageId])).rows[0].status,'queued','User input is persisted before model invocation');
  await pool.query("UPDATE manager_messages SET status='completed' WHERE id=$1",[managerMessageId]);
  await pool.query("INSERT INTO manager_requests(id,project_id,task_id,source_key,kind,source_id) VALUES($1,$2,$3,'qa:test:original','qa_visual',$4)",[managerRequestId,projectId,taskId,randomUUID()]);
  const duplicate=await pool.query("INSERT INTO manager_requests(id,project_id,task_id,source_key,kind,source_id) VALUES($1,$2,$3,'qa:test:original','qa_visual',$4) ON CONFLICT(task_id,source_key) DO NOTHING RETURNING id",[randomUUID(),projectId,taskId,randomUUID()]);
  assert.equal(duplicate.rowCount,0,'Replayed workflow cannot send duplicate risk request');
  assert.equal((await pool.query('SELECT count(*)::int AS total FROM manager_requests WHERE task_id=$1',[taskId])).rows[0].total,1);

  await initTaskCancellationSchema(pool);
  await initTaskCancellationSchema(pool);
  assert.equal(needsGitHubCleanup({git_branch:null,pr_number:null},true),true,'A failed runner may have pushed its UUID branch before saving task.git_branch');
  assert.equal(needsGitHubCleanup({git_branch:null,pr_number:null},false),false);
  assert.equal(needsGitHubCleanup({git_branch:taskId,pr_number:null},false),true);
  const noteRun=randomUUID();
  const note={projectId,taskId,authorStage:'development',authorName:'AI-разработчик',
   targetStage:'testing',body:'Проверяй на мобильной ширине 360px: иначе стрелки перекрывают край карточки',
   kind:'handoff',sourceKey:'dev:'+noteRun,sourceRunId:noteRun};
  assert.equal(await recordTaskAgentNote(pool,note),true);
  assert.equal(await recordTaskAgentNote(pool,note),false,'Retried Temporal activity must not duplicate comment');
  assert.match(await taskNotesContext(pool,projectId,taskId,'testing'),/360px/);
  assert.equal(await taskNotesContext(pool,projectId,taskId,'analysis'),'[]','Notes addressed only to QA must not leak to analyst');
  await recordTaskAgentNote(pool,{...note,sourceKey:'question:'+noteRun,kind:'question',targetStage:'all',body:'Нужна ли стрелка между последней и первой фигурой?'});
  assert.equal(await pendingAgentQuestions(pool,projectId,taskId),1);
  await pool.query("UPDATE task_agent_notes SET status='answered',answer='Да, окружность замкнута' WHERE project_id=$1 AND task_id=$2 AND kind='question'",[projectId,taskId]);
  assert.equal(await pendingAgentQuestions(pool,projectId,taskId),0);
  assert.match(await taskNotesContext(pool,projectId,taskId,'development'),/окружность замкнута/);
  const cols=await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='documents' AND column_name='created_by_task_id'");
  assert.equal(cols.rowCount,1,'Cancellation documents have explicit task provenance');
  const owner1=randomUUID(),owner2=randomUUID();
  assert.equal(await acquireTaskOrchestration(pool,projectId,taskId,owner1,'task-cycle-'+owner1,'development'),true);
  assert.equal(await acquireTaskOrchestration(pool,projectId,taskId,owner2,'manual-test-'+owner2,'testing'),false,'Second workflow cannot start during analyst or QA preparation');
  await releaseTaskOrchestration(pool,projectId,taskId,owner2);
  assert.equal((await pool.query('SELECT owner_id,state FROM task_orchestration_owners WHERE task_id=$1',[taskId])).rows[0].state,'active','Unrelated owner cannot release an active workflow');
  await releaseTaskOrchestration(pool,projectId,taskId,owner1);
  assert.equal(await acquireTaskOrchestration(pool,projectId,taskId,owner2,'manual-test-'+owner2,'testing'),true,'New QA cycle starts after the first workflow finishes');
  await releaseTaskOrchestration(pool,projectId,taskId,owner2);

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

  // The answer itself is never approval of a behavioral change.
  // With an unanswered question, old review remains blocking.
  const reviewQuestionRun=randomUUID();
  await recordTaskAgentNote(pool,{...note,kind:'question',targetStage:'all',
   sourceKey:'analyst-question:'+reviewQuestionRun,
   body:'Какой порядок сортировки результата должен быть принят?'});
  const pendingClient=await pool.connect();
  try{
   await pendingClient.query('BEGIN');
   const pending=await resolveAgentQuestionsForReview(pendingClient,projectId,taskId,2);
   assert.equal(pending.remaining,1);
   await pendingClient.query('COMMIT');
  }finally{pendingClient.release();}
  await pool.query("UPDATE task_agent_notes SET status='answered',answer='По времени создания' WHERE project_id=$1 AND task_id=$2 AND source_key=$3",
   [projectId,taskId,'analyst-question:'+reviewQuestionRun]);
  const guardClient=await pool.connect();
  try{
   await guardClient.query('BEGIN');
   const decision=await resolveAgentQuestionsForReview(guardClient,projectId,taskId,2);
   assert.equal(decision.remaining,0);
   assert.equal(decision.requiresApproval,true,'An answer cannot auto-approve a material change');
   await guardClient.query('COMMIT');
  }finally{guardClient.release();}
  assert.equal((await pool.query('SELECT status FROM task_requirement_reviews WHERE id=$1',[review.id])).rows[0].status,'needs_approval');

  // An *uncertain* review must be re-run after a human answers the question.
  // Previously the same spec_version and SHA returned old needs_approval forever.
  await pool.query("UPDATE task_requirement_reviews SET classification='uncertain' WHERE id=$1",[review.id]);
  const followupClient=await pool.connect();
  try{
   await followupClient.query('BEGIN');
   const decision=await resolveAgentQuestionsForReview(followupClient,projectId,taskId,2);
   assert.equal(decision.requiresApproval,false);
   await followupClient.query('COMMIT');
  }finally{followupClient.release();}
  assert.equal((await pool.query('SELECT status FROM task_requirement_reviews WHERE id=$1',[review.id])).rows[0].status,'superseded');
  await pool.query("UPDATE tasks SET spec_review_status='pending' WHERE id=$1",[taskId]);
  let askedAgain=0;
  const reconsidered=await reconcileTaskRequirements(pool,{projectId,taskId,commitSha:'sha-1',
   prEvidence:'The updated answer resolves the previously ambiguous implementation'},async()=>{
   askedAgain++;
   return JSON.stringify({classification:'aligned',summary:'The answer resolved all open questions',
    proposed_description:'Users can search by title and filter active results',questions:[]});
  });
  assert.equal(askedAgain,1,'Analyst must actually analyze new answers rather than reuse an old verdict');
  assert.equal(reconsidered,'current');

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
  const testId=randomUUID(),waiverId=randomUUID();
  await pool.query('INSERT INTO ai_test_runs(id) VALUES($1)',[testId]);
  await pool.query('INSERT INTO qa_merge_waivers(id,project_id,task_id,test_run_id,approved_by,justification,commit_sha,spec_version,unverified_cases) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
   [waiverId,projectId,taskId,testId,userId,'Browser missing; temporary merge exception authorized','f'.repeat(40),3,JSON.stringify([{id:'case1',title:'Visual check'}])]);
  const waiver=(await pool.query('SELECT test_run_id,approved_by,commit_sha,spec_version,unverified_cases FROM qa_merge_waivers WHERE id=$1',[waiverId])).rows[0];
  assert.equal(waiver.test_run_id,testId);
  assert.equal(waiver.approved_by,userId);
  assert.equal(waiver.spec_version,3);
  assert.deepEqual(waiver.unverified_cases,[{id:'case1',title:'Visual check'}]);
  assert.equal(waiver.commit_sha,'f'.repeat(40));
 }finally{await pool.end();}
});

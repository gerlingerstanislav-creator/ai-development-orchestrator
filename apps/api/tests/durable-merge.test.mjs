import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {createMergeBatch,finishMergeBatch,installMergeBatchSchema,recoverInterruptedLegacyMergeBatches,loadMergeBatch,readMergeBatch,recoverMergeBatches,saveMergeResult} from '../dist/merge-batch.js';
import {createMergeService} from '../dist/merge-service.js';

test('merge batch survives lost acknowledgements and records one outcome per PR',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='merge_recovery_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY);
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,depends_on_task_id uuid,stage text,title text,
   pr_number int,pr_url text,pr_base_branch text,updated_at timestamptz,created_at timestamptz DEFAULT now(),
   spec_version int DEFAULT 1,spec_reviewed_version int DEFAULT 1,spec_review_status text DEFAULT 'current',spec_reviewed_commit text);
  CREATE TABLE merge_process_runs(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,status text,message text,current_task uuid,
   results jsonb DEFAULT '[]',created_at timestamptz DEFAULT now(),finished_at timestamptz);
  CREATE TABLE process_events(id uuid,project_id uuid,process_id uuid,process_kind text,stage text,detail text,level text);
  CREATE TABLE task_events(id uuid,task_id uuid,actor_id uuid,event text,detail text);
  CREATE TABLE project_git_repositories(project_id uuid,connection_id uuid,repository text,target_branch text,default_branch text);
  CREATE TABLE connections(id uuid,owner_id uuid,secret_encrypted text);
  CREATE TABLE task_deployment_records(task_id uuid PRIMARY KEY,project_id uuid,status text,reason text,merge_sha text,actor_id uuid,updated_at timestamptz);
  CREATE TABLE project_deployment_settings(project_id uuid,mode text);
  CREATE TABLE task_agent_notes(project_id uuid,task_id uuid,kind text,status text,target_stage text,requires_customer boolean);
  CREATE TABLE qa_test_plans(id uuid,project_id uuid,task_id uuid,spec_version int,spec_hash text);
  CREATE TABLE ai_test_runs(id uuid,project_id uuid,task_id uuid,status text,verdict text,report jsonb,qa_spec_version int,qa_plan_snapshot jsonb,
   created_at timestamptz DEFAULT now());
  CREATE TABLE quality_gate_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid,kind text,head_sha text,base_sha text,status text,verdict text,started_at timestamptz DEFAULT now());
 `);
 const [project,actor,parent,child,connection,legacy]=Array.from({length:6},randomUUID);
 const prUrl='https://github.com/example/repo/pull/1';
 await db.query('INSERT INTO projects VALUES($1)',[project]);
 await db.query("INSERT INTO tasks(id,project_id,depends_on_task_id,stage,title,pr_number,pr_url) VALUES($1,$2,$3,'merge_queue','Child',2,'child'),($3,$2,NULL,'merge_queue','Parent',1,$4)",
  [child,project,parent,prUrl]);
 await db.query("INSERT INTO merge_process_runs(id,project_id,actor_id,status) VALUES($1,$2,$3,'running')",[legacy,project,actor]);
 await installMergeBatchSchema(db);
 await recoverInterruptedLegacyMergeBatches(db);
 assert.equal((await readMergeBatch(db,project,legacy)).status,'failed');
 await db.query("INSERT INTO project_git_repositories VALUES($1,$2,'example/repo','main','main')",[project,connection]);
 await db.query("INSERT INTO connections VALUES($1,$2,'fake')",[connection,actor]);
 const [a,b]=await Promise.all([createMergeBatch(db,project,actor),createMergeBatch(db,project,actor)]);
 assert.equal(a.id,b.id);
 assert.deepEqual((await loadMergeBatch(db,a.id)).task_ids,[parent,child]);
 await assert.rejects(recoverMergeBatches(db,async()=>{throw Error('Temporal offline');}),/Temporal offline/);
 assert.equal((await readMergeBatch(db,project,a.id)).status,'queued');
 await recoverMergeBatches(db,async id=>{
  assert.equal(id,a.id);
  throw Object.assign(Error('already started'),{name:'WorkflowExecutionAlreadyStartedError'});
 });
 assert.equal((await readMergeBatch(db,project,a.id)).status,'running');

 const fetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=fetch;});
 let merged=false,puts=0,ciPassed=false;
 const headSha='a'.repeat(40),baseSha='b'.repeat(40);
 globalThis.fetch=async (url,options)=>{
  if(options?.method==='PUT'){
   puts++;
   assert.equal(JSON.parse(options.body).sha,headSha);
   merged=true;
   throw Error('GitHub merged but the connection dropped');
  }
  if(url.endsWith('/branches/main'))return Response.json({name:'main',protection:{required_status_checks:{contexts:['build']}}});
  if(url.includes('/rules/branches/main?'))return Response.json([]);
  if(url.endsWith('/protection/required_status_checks'))return Response.json({checks:[]});
  if(url.includes('/check-runs'))return Response.json({check_runs:ciPassed?[{name:'build',status:'completed',conclusion:'success'}]:[]});
  if(url.includes('/statuses?'))return Response.json([]);
  if(url.includes('/compare/'))return Response.json({status:'ahead'});
  if(options?.method==='PATCH'&&url.endsWith('/pulls/2'))return Response.json({base:{ref:'main'}});
  assert.ok(url.endsWith('/pulls/1'),url);
  return Response.json({merged,state:'open',mergeable:true,base:{ref:'main',sha:baseSha},head:{sha:headSha},merge_commit_sha:'b'.repeat(40)});
 };
 const service=createMergeService(db,()=> 'fake-token');
 const attempt=()=>service.mergeTaskPr(project,parent,actor);
 // The analyst approved the task before development. A new model review of
 // the exact PR SHA is NOT a merge precondition. QA and CI still are.
 await db.query("UPDATE tasks SET spec_review_status='pending',spec_reviewed_version=0,spec_reviewed_commit='' WHERE id=$1",[parent]);
 await assert.rejects(attempt,/Нет QA-плана/);
 const planHash='qa-plan-hash';
 await db.query('INSERT INTO qa_test_plans VALUES($1,$2,$3,1,$4)',[randomUUID(),project,parent,planHash]);
 const testRun=randomUUID(),snapshot={spec_hash:planHash,cases:[{id:randomUUID()}]};
 await db.query("INSERT INTO ai_test_runs(id,project_id,task_id,status,verdict,report,qa_spec_version,qa_plan_snapshot) VALUES($1,$2,$3,'completed','passed',$4,1,$5)",
  [testRun,project,parent,{commit:'c'.repeat(40)},snapshot]);
 await assert.rejects(attempt,/Нет завершённого QA-отчёта/);
 await db.query('UPDATE ai_test_runs SET report=$2,qa_spec_version=2 WHERE id=$1',[testRun,{commit:headSha}]);
 await assert.rejects(attempt,/Нет завершённого QA-отчёта/);
 await db.query('UPDATE ai_test_runs SET qa_spec_version=1,qa_plan_snapshot=$2 WHERE id=$1',[testRun,{...snapshot,spec_hash:'old-plan'}]);
 await assert.rejects(attempt,/Нет завершённого QA-отчёта/);
 await db.query('UPDATE ai_test_runs SET qa_plan_snapshot=$2 WHERE id=$1',[testRun,snapshot]);
 await assert.rejects(attempt,/Нет успешного собственного CI/);
 await db.query('DELETE FROM qa_test_plans WHERE task_id=$1',[parent]);
 const singlePass={singlePass:true,adHoc:true,simplified:true,cases:[{id:'qa-1',title:'Проверка заказа'}]};
 await db.query('UPDATE ai_test_runs SET qa_plan_snapshot=$2 WHERE id=$1',[testRun,singlePass]);
 await assert.rejects(attempt,/Runner не подтвердил/);
 await db.query("UPDATE ai_test_runs SET verdict='blocked',report=$2 WHERE id=$1",[testRun,{
  commit:headSha,executionVerified:true,checks:[],caseResults:[{case_id:'qa-1',result:'not_run',reason:'tool_unavailable',evidence:'Для сценария не установлено окружение'}]
 }]);
 await assert.rejects(attempt,/Сценарии QA не подтверждены/);
 await db.query("UPDATE ai_test_runs SET verdict='passed',report=$2 WHERE id=$1",[testRun,{
  commit:headSha,executionVerified:true,checks:[{result:'passed',details:'node --test → код 0'}],caseResults:[{case_id:'qa-1',result:'passed',evidence:'node --test → код 0'}]
 }]);
 await assert.rejects(attempt,/Нет успешного собственного CI/);
 await db.query("INSERT INTO quality_gate_runs(id,project_id,task_id,kind,head_sha,base_sha,status,verdict) VALUES($1,$2,$3,'ci',$4,$5,'completed','passed'),($6,$2,$3,'review',$4,$5,'completed','passed')",
  [randomUUID(),project,parent,headSha,baseSha,randomUUID()]);
 await assert.rejects(attempt,/build — результат отсутствует/);
 assert.equal(puts,0);
 ciPassed=true;
 await assert.rejects(service.mergeTaskPr(project,parent,actor),/connection dropped/);
 assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[parent])).rows[0].stage,'merge_queue');
 assert.equal((await service.mergeTaskPr(project,parent,actor)).status,'merged');
 assert.equal((await service.mergeTaskPr(project,parent,actor)).status,'merged');
 assert.equal(puts,1);
 assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[parent])).rows[0].stage,'documentation');
 assert.equal((await db.query("SELECT count(*)::int AS count FROM task_events WHERE task_id=$1 AND event='merged'",[parent])).rows[0].count,1);
 await Promise.all([saveMergeResult(db,a.id,{taskId:parent,status:'merged'}),saveMergeResult(db,a.id,{taskId:parent,status:'merged'})]);
 await saveMergeResult(db,a.id,{taskId:child,status:'skipped',reason:'Нужна повторная проверка'});
 await finishMergeBatch(db,a.id);
 const result=await readMergeBatch(db,project,a.id);
 assert.equal(result.status,'partial');
 assert.equal(result.results.length,2);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM process_events WHERE process_id=$1',[a.id])).rows[0].count,2);
});

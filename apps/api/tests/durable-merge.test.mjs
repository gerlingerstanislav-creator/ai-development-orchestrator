import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {createMergeBatch,finishMergeBatch,initMergeBatches,loadMergeBatch,readMergeBatch,recoverMergeBatches,saveMergeResult} from '../dist/merge-batch.js';
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
  CREATE TABLE qa_test_plans(id uuid,project_id uuid,task_id uuid,spec_version int);
  CREATE TABLE ai_task_runs(project_id uuid,task_id uuid,cycle_id uuid);
 `);
 const [project,actor,parent,child,connection,legacy]=Array.from({length:6},randomUUID);
 const prUrl='https://github.com/example/repo/pull/1';
 await db.query('INSERT INTO projects VALUES($1)',[project]);
 await db.query("INSERT INTO tasks(id,project_id,depends_on_task_id,stage,title,pr_number,pr_url) VALUES($1,$2,$3,'merge_queue','Child',2,'child'),($3,$2,NULL,'merge_queue','Parent',1,$4)",
  [child,project,parent,prUrl]);
 await db.query("INSERT INTO merge_process_runs(id,project_id,actor_id,status) VALUES($1,$2,$3,'running')",[legacy,project,actor]);
 await initMergeBatches(db);
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
 let merged=false,puts=0;
 globalThis.fetch=async (url,options)=>{
  if(options?.method==='PUT'){
   puts++;
   assert.equal(JSON.parse(options.body).sha,'a'.repeat(40));
   merged=true;
   throw Error('GitHub merged but the connection dropped');
  }
  if(url.includes('/check-runs'))return Response.json({check_runs:[],total_count:0});
  if(url.endsWith('/status'))return Response.json({statuses:[]});
  if(url.includes('/compare/'))return Response.json({status:'ahead'});
  assert.ok(url.endsWith('/pulls/1'),url);
  return Response.json({merged,state:'open',mergeable:true,base:{ref:'main'},head:{sha:'a'.repeat(40)},merge_commit_sha:'b'.repeat(40)});
 };
 const service=createMergeService(db,()=> 'fake-token');
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

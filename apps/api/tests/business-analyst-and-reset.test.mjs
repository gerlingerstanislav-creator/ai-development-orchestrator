import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {initDocumentationReset,registerDocumentationResetRoutes} from '../dist/documentation-reset.js';
import {registerSafeTaskDeletion} from '../dist/task-deletion.js';
import {registerBusinessAnalystHandoff} from '../dist/business-analyst-handoff.js';
import {toolsForRole,toolAllowedForRole} from '../dist/agent-tools.js';

test('BA can edit documentation, but cannot create technical tasks or owner questions',()=>{
 const tools=toolsForRole('analyst').map(t=>t.name);
 assert.ok(tools.includes('documents.create'));
 assert.ok(tools.includes('documentation.rebuild'));
 assert.ok(!tools.includes('tasks.create'));
 assert.ok(!tools.includes('questions.create'));
 assert.equal(toolAllowedForRole('manager','tasks.create'),true);
 assert.equal(toolAllowedForRole('analyst','tasks.create'),false);
 assert.equal(toolAllowedForRole('business_analyst','tasks.create'),false);
});

test('documentation reset is previewed, project-scoped, one-time and removes only content',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 let opened=false;
 t.after(async()=>{await app.close();if(opened)await db.query('ROLLBACK');await db.end();});
 await db.query('BEGIN');opened=true;
 const schema='docreset_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET LOCAL search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE users(id uuid PRIMARY KEY)',
  'CREATE TABLE projects(id uuid PRIMARY KEY,name text NOT NULL)',
  "CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),parent_id uuid REFERENCES documents(id) ON DELETE SET NULL,title text NOT NULL,body text DEFAULT '',updated_at timestamptz DEFAULT now(),system_key text,knowledge_summary text DEFAULT '',knowledge_tags text[] DEFAULT ARRAY[]::text[],knowledge_key text,knowledge_status text DEFAULT 'approved')",
  "CREATE TABLE document_import_jobs(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),updated_at timestamptz DEFAULT now(),status text DEFAULT 'completed')"
 ].join(';\n')+';');
 const pool={query:(...args)=>db.query(...args),connect:async()=>({
  query:(sql,...args)=>sql==='BEGIN ISOLATION LEVEL SERIALIZABLE'?db.query('SAVEPOINT test_reset'):
   sql==='COMMIT'?db.query('RELEASE SAVEPOINT test_reset'):
   sql==='ROLLBACK'?db.query('ROLLBACK TO SAVEPOINT test_reset'):db.query(sql,...args),
  release(){}
 })};
 await initDocumentationReset(pool);
 const user=randomUUID(),project=randomUUID(),other=randomUUID(),root=randomUUID(),page=randomUUID(),child=randomUUID(),importId=randomUUID();
 await db.query('INSERT INTO users(id) VALUES($1)',[user]);
 await db.query('INSERT INTO projects(id,name) VALUES($1,$2),($3,$4)',[project,'Мой проект',other,'Другой проект']);
 await db.query("INSERT INTO documents(id,project_id,title,system_key) VALUES($1,$2,'Техническое задание','spec')",[root,project]);
 await db.query('INSERT INTO documents(id,project_id,title,parent_id,body) VALUES($1,$2,$3,$4,$5)',[page,project,'Старое ТЗ',root,'Требования']);
 await db.query('INSERT INTO documents(id,project_id,title,parent_id) VALUES($1,$2,$3,$4)',[child,project,'Вложенная страница',page]);
 await db.query("INSERT INTO document_import_jobs(id,project_id,status) VALUES($1,$2,'completed')",[importId,project]);
 const otherPage=randomUUID();
 await db.query("INSERT INTO documents(id,project_id,title,system_key) VALUES($1,$2,'Техническое задание','spec')",[otherPage,other]);
 registerDocumentationResetRoutes(app,{pool,uid:()=>user,access:async()=>true,requireAdmin:async()=>true});
 const url='/api/projects/'+project+'/documentation/reset';
 const preview=await app.inject({method:'POST',url:url+'/preview'});
 assert.equal(preview.statusCode,200,preview.body);
 assert.equal(preview.json().pages,2);
 assert.equal(preview.json().imports,1);
 const staleId=preview.json().intent_id;
 await db.query("UPDATE documents SET body='Изменено после предпросмотра',updated_at=clock_timestamp() WHERE id=$1",[page]);
 const stale=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:staleId,project_name:'Мой проект',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
 assert.equal(stale.statusCode,409,stale.body);
 const next=await app.inject({method:'POST',url:url+'/preview'});
 const denied=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:next.json().intent_id,project_name:'Другое имя',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
 assert.equal(denied.statusCode,409,denied.body);
 const done=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:next.json().intent_id,project_name:'Мой проект',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
 assert.equal(done.statusCode,200,done.body);
 assert.equal(done.json().deleted_pages,2);
 assert.equal((await db.query('SELECT count(*)::int n FROM documents WHERE project_id=$1',[project])).rows[0].n,9);
 assert.equal((await db.query('SELECT count(*)::int n FROM document_import_jobs WHERE project_id=$1',[project])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM documents WHERE project_id=$1',[other])).rows[0].n,1);
 const replay=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:next.json().intent_id,project_name:'Мой проект',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
 assert.equal(replay.statusCode,409,replay.body);
 await db.query('ROLLBACK');opened=false;
});

test('task deletion protects execution history and removes unstarted analyst tasks',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 let opened=false;
 t.after(async()=>{await app.close();if(opened)await db.query('ROLLBACK');await db.end();});
 await db.query('BEGIN');opened=true;
 const schema='taskdelete_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET LOCAL search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  "CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,stage text,display_number int,git_branch text,pr_url text,parent_id uuid REFERENCES tasks(id),depends_on_task_id uuid REFERENCES tasks(id),clarification_questions jsonb DEFAULT '[]',spec_review_status text,spec_version int,position int,created_at timestamptz)",
  'CREATE TABLE ai_task_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid REFERENCES tasks(id))',
  'CREATE TABLE ai_test_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid REFERENCES tasks(id),status text,verdict text,qa_spec_version int,qa_plan_snapshot jsonb,report jsonb,created_at timestamptz)',
  'CREATE TABLE task_agent_notes(project_id uuid,task_id uuid,body text,kind text,status text,target_stage text,requires_customer boolean,created_at timestamptz)',
  'CREATE TABLE task_requirement_reviews(project_id uuid,task_id uuid,spec_version int,status text,classification text)',
  'CREATE TABLE qa_merge_waivers(project_id uuid,task_id uuid)',
  'CREATE TABLE manager_requests(project_id uuid,task_id uuid,source_id uuid,kind text,status text)',
  'CREATE TABLE qa_test_plans(id uuid PRIMARY KEY,project_id uuid,task_id uuid REFERENCES tasks(id))',
  'CREATE TABLE qa_test_cases(id uuid PRIMARY KEY,project_id uuid,source_task_id uuid REFERENCES tasks(id))',
  "CREATE TABLE requirement_review_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid REFERENCES tasks(id),status text DEFAULT 'queued')"
 ].join(';\n')+';');
 const pool={query:(...args)=>db.query(...args),connect:async()=>({
  query:(sql,...args)=>sql.startsWith('BEGIN')?db.query('SAVEPOINT test_delete'):
   sql==='COMMIT'?db.query('RELEASE SAVEPOINT test_delete'):
   sql==='ROLLBACK'?db.query('ROLLBACK TO SAVEPOINT test_delete'):db.query(sql,...args),
  release(){}
 })};
 const project=randomUUID(),removable=randomUUID(),protectedTask=randomUUID(),actor=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[project]);
 await db.query("INSERT INTO tasks(id,project_id,title,stage,display_number) VALUES($1,$2,'Лишний вопрос','analysis',1),($3,$2,'В разработке','development',2)",[removable,project,protectedTask]);
 registerSafeTaskDeletion(app,{pool,uid:()=>actor,access:async()=>true,requireAdmin:async()=>true});
 const path='/api/projects/'+project+'/tasks/';
 const no=await app.inject({method:'DELETE',url:path+removable,payload:{confirm_task_id:protectedTask}});
 assert.equal(no.statusCode,409,no.body);
 const blocked=await app.inject({method:'DELETE',url:path+protectedTask,payload:{confirm_task_id:protectedTask}});
 assert.equal(blocked.statusCode,409,blocked.body);
 const yes=await app.inject({method:'DELETE',url:path+removable,payload:{confirm_task_id:removable}});
 assert.equal(yes.statusCode,200,yes.body);
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks WHERE project_id=$1',[project])).rows[0].n,1);
 const eligible=randomUUID(),stale=randomUUID(),foreign=randomUUID(),other=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[other]);
 await db.query("INSERT INTO tasks(id,project_id,title,stage,display_number,clarification_questions) VALUES($1,$2,'Анализ','analysis',3,$6),($3,$2,'Уточнения','analysis',4,$6),($4,$5,'Другой проект','analysis',5,$6)",
  [eligible,project,stale,foreign,other,JSON.stringify(['Какого цвета круг?'])]);
 await db.query("INSERT INTO task_agent_notes(project_id,task_id,body,kind,status,target_stage) VALUES($1,$2,'Какой цвет использовать?','question','open','all')",[project,protectedTask]);
 const bulk=path+'owner-questions/delete/';
 const preview=await app.inject({method:'GET',url:bulk+'preview'});
 assert.equal(preview.statusCode,200,preview.body);
 assert.deepEqual(preview.json().tasks.map(({id,blocked_reason})=>[id,!!blocked_reason]),[
  [protectedTask,true],[eligible,false],[stale,false]
 ]);
 const confirm=(task_ids,confirm=true)=>app.inject({method:'POST',url:bulk+'confirm',payload:{task_ids,confirm}});
 assert.equal((await confirm([eligible],false)).statusCode,409);
 assert.equal((await confirm([eligible,protectedTask])).statusCode,409);
 assert.equal((await confirm([eligible,foreign])).statusCode,409);
 await db.query("UPDATE tasks SET clarification_questions='[]' WHERE id=$1",[stale]);
 assert.equal((await confirm([eligible,stale])).statusCode,409);
 const removed=await confirm([eligible]);
 assert.equal(removed.statusCode,200,removed.body);
 assert.deepEqual(removed.json().deleted_task_ids,[eligible]);
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,3);
 await db.query('ROLLBACK');opened=false;
});


test('BA-to-SA handoff requires explicit approval and creates an analysis task only on action',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 let opened=false;
 t.after(async()=>{await app.close();if(opened)await db.query('ROLLBACK');await db.end();});
 await db.query('BEGIN');opened=true;
 const schema='bahandoff_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET LOCAL search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  "CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,description text,type text,stage text,analysis_state text,position int)",
  'CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid REFERENCES tasks(id),actor_id uuid,event text,detail text)'
 ].join(';\n')+';');
 const pool={query:(...args)=>db.query(...args),connect:async()=>({
  query:(sql,...args)=>sql==='BEGIN'?db.query('SAVEPOINT handoff'):
   sql==='COMMIT'?db.query('RELEASE SAVEPOINT handoff'):
   sql==='ROLLBACK'?db.query('ROLLBACK TO SAVEPOINT handoff'):db.query(sql,...args),
  release(){}
 })};
 const project=randomUUID(),actor=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[project]);
 registerBusinessAnalystHandoff(app,{pool,uid:()=>actor,access:async()=>true});
 const url='/api/projects/'+project+'/business-analyst/handoff';
 const payload={title:'Согласованный пакет',description:'Владелец согласовал сценарий и границы выбранной функциональности.'};
 const denied=await app.inject({method:'POST',url,payload});
 assert.equal(denied.statusCode,400,denied.body);
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,0);
 const created=await app.inject({method:'POST',url,payload:{...payload,approved:true}});
 assert.equal(created.statusCode,201,created.body);
 const task=(await db.query('SELECT stage,analysis_state FROM tasks WHERE id=$1',[created.json().task_id])).rows[0];
 assert.equal(task.stage,'analysis');
 assert.equal(task.analysis_state,'new');
 await db.query('ROLLBACK');opened=false;
});

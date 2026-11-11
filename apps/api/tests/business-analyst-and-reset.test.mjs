
test('DevOps unification retains custom stage instructions and is idempotent',()=>{
 const own='Проверяй отдельные корпоративные секреты CI перед выкаткой';
 const specialist='Управляй версиями артефактов GitHub Actions';
 const merged=mergeDevopsInstructions(specialist,own);
 assert.match(merged,/Управляй версиями артефактов/);
 assert.match(merged,/корпоративные секреты/);
 assert.equal(mergeDevopsInstructions(merged,own),merged);
 const recovered=mergeDevopsInstructions(specialist,specialist,own);
 assert.match(recovered,/корпоративные секреты/);
 assert.throws(()=>mergeDevopsInstructions('a'.repeat(11990),own),/12000/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {initDocumentationReset,registerDocumentationResetRoutes} from '../dist/documentation-reset.js';
import {registerSafeTaskDeletion} from '../dist/task-deletion.js';
import {registerProjectTeamRoutes,initProjectTeamSchema,mergeDevopsInstructions} from '../dist/project-team.js';
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
  "CREATE TABLE document_import_jobs(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),updated_at timestamptz DEFAULT now(),status text DEFAULT 'completed')",
  "CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),type text DEFAULT 'task',document_id uuid REFERENCES documents(id),title text,description text,question_status text,updated_at timestamptz DEFAULT now())"
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
 const developmentTask=randomUUID();
 await db.query("INSERT INTO tasks(id,project_id,type,title) VALUES($1,$2,'task','Сохранить задачу разработки')",[developmentTask,project]);
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
 assert.equal(next.json().questions,0);
 const newQuestion=randomUUID();
 await db.query("INSERT INTO tasks(id,project_id,type,document_id,title,description,question_status) VALUES($1,$2,'question',$3,'Вопрос к ПО','Нужно решение владельца','open')",[newQuestion,project,page]);
 const staleQuestions=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:next.json().intent_id,project_name:'Мой проект',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
 assert.equal(staleQuestions.statusCode,409,'New analyst questions must invalidate the deletion preview');
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks WHERE id=$1',[newQuestion])).rows[0].n,1);
 const current=await app.inject({method:'POST',url:url+'/preview'});
 assert.equal(current.json().questions,1,'Preview must reveal all analyst-question tasks that will be removed');
 const denied=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:current.json().intent_id,project_name:'Другое имя',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
 assert.equal(denied.statusCode,409,denied.body);
 const done=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:current.json().intent_id,project_name:'Мой проект',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
 assert.equal(done.statusCode,200,done.body);
 assert.equal(done.json().deleted_pages,2);
 assert.equal(done.json().deleted_questions,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks WHERE id=$1',[developmentTask])).rows[0].n,1,'Development tasks must be preserved');
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks WHERE id=$1',[newQuestion])).rows[0].n,0);
 assert.equal((await db.query('SELECT deleted_questions FROM documentation_reset_audit WHERE project_id=$1',[project])).rows[0].deleted_questions,1);

 assert.equal((await db.query('SELECT count(*)::int n FROM documents WHERE project_id=$1',[project])).rows[0].n,1,'Only the existing top-level root remains; no template sections are recreated');
 assert.equal((await db.query('SELECT count(*)::int n FROM document_import_jobs WHERE project_id=$1',[project])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM documents WHERE project_id=$1',[other])).rows[0].n,1);
 const replay=await app.inject({method:'POST',url:url+'/confirm',payload:{intent_id:current.json().intent_id,project_name:'Мой проект',confirmation_phrase:'УДАЛИТЬ ДОКУМЕНТАЦИЮ'}});
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
  "CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,type text NOT NULL DEFAULT 'task',stage text,display_number int,git_branch text,pr_url text,parent_id uuid REFERENCES tasks(id),depends_on_task_id uuid REFERENCES tasks(id),clarification_questions jsonb DEFAULT '[]',spec_review_status text,spec_version int,position int,created_at timestamptz,question_status text,document_id uuid)",
  'CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text)',
  'CREATE TABLE document_import_jobs(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),source_key text,status text)',
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

test('the team excludes platform stages and keeps configured AI agents',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 t.after(async()=>{await app.close();await db.end();});
 await db.query(`
  CREATE TEMP TABLE workflow_stages(project_id uuid,stage text,label text,position int,agent_name text,agent_instructions text);
  CREATE TEMP TABLE project_specialist_agents(project_id uuid,role text,agent_name text,agent_instructions text);
  CREATE TEMP TABLE project_conversation_agents(project_id uuid,role text,agent_name text,agent_instructions text);
  CREATE TEMP TABLE project_agent_models(project_id uuid,role text,model text,updated_at timestamptz DEFAULT now(),UNIQUE(project_id,role));
  CREATE TEMP TABLE project_role_capacity(project_id uuid,role text,capacity int,updated_at timestamptz DEFAULT now(),UNIQUE(project_id,role));
  CREATE TEMP TABLE users(id uuid,email text);
  CREATE TEMP TABLE agent_memory(id uuid,project_id uuid,role text,kind text,body text,evidence text,status text,origin text,author_id uuid,created_at timestamptz,reviewed_at timestamptz);
 `);
 const project=randomUUID(),actor=randomUUID();
 await db.query(`
  INSERT INTO workflow_stages VALUES
  ($1,'backlog','Бэклог',0,'Оператор','Инструкция ПМ для бэклога'),
  ($1,'analysis','Анализ',1,'Системный аналитик','Проверяй требования'),
  ($1,'merge_queue','Ожидает слияния',2,'Интегратор GitHub','Проверь PR'),
  ($1,'done','Готово',3,'Система','Завершение')
 `,[project]);
 await db.query("INSERT INTO project_conversation_agents VALUES($1,'manager','Менеджер проекта','Координируй работу')",[project]);
 registerProjectTeamRoutes(app,{pool:db,uid:()=>actor,access:async()=>true,requireAdmin:async()=>true});
 const response=await app.inject({url:'/api/projects/'+project+'/team'});
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().agents.map(({role,instructions})=>[role,instructions]),[
  ['manager','Координируй работу'],['analysis','Проверяй требования']
 ]);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM workflow_stages WHERE project_id=$1',[project])).rows[0].n,4);
 const invalid=await app.inject({method:'PATCH',url:'/api/projects/'+project+'/team/manager/model',payload:{model:'unsupported-model'}});
 assert.equal(invalid.statusCode,400,'unknown Codex model must be rejected');
 const changed=await app.inject({method:'PATCH',url:'/api/projects/'+project+'/team/manager/model',payload:{model:'gpt-6-sol'}});
 assert.equal(changed.statusCode,200,changed.body);
 const configured=await app.inject({url:'/api/projects/'+project+'/team'});
 assert.equal(configured.json().agents.find(a=>a.role==='manager').model,'gpt-6-sol');
 const reset=await app.inject({method:'PATCH',url:'/api/projects/'+project+'/team/manager/model',payload:{model:null}});
 assert.equal(reset.statusCode,200,reset.body);
 assert.equal((await app.inject({url:'/api/projects/'+project+'/team'})).json().agents.find(a=>a.role==='manager').model,null);
});


test('legacy DevOps workflow instructions survive Team schema initialization',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 let opened=false;
 t.after(async()=>{if(opened)await db.query('ROLLBACK');await db.end();});
 await db.query('BEGIN');opened=true;
 const schema='devopsmerge_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET LOCAL search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE users(id uuid PRIMARY KEY)',
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  "CREATE TABLE agent_memory(id uuid PRIMARY KEY,project_id uuid,role text,kind text,body text,evidence text,status text,created_at timestamptz DEFAULT now())",
  'CREATE TABLE workflow_stages(project_id uuid,stage text,label text,position int,agent_name text,agent_instructions text)',
  'CREATE TABLE project_specialist_agents(project_id uuid,role text,agent_name text,agent_instructions text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(project_id,role))'
 ].join(';\n')+';');
 const project=randomUUID(),stageText='Проверяй требования корпоративного VPN перед каждой выкладкой',specialistText='Контролируй GitHub Actions и блокировки CI';
 await db.query('INSERT INTO projects(id) VALUES($1)',[project]);
 await db.query("INSERT INTO workflow_stages VALUES($1,'deployment','Выкладка',5,'Release Steward',$2)",[project,stageText]);
 await db.query("INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions) VALUES($1,'devops','AI-DevOps',$2)",[project,specialistText]);
 const pool={query:(...args)=>db.query(...args),connect:async()=>({
  query:(sql,...args)=>sql==='BEGIN'?db.query('SAVEPOINT devops_update'):
   sql==='COMMIT'?db.query('RELEASE SAVEPOINT devops_update'):
   sql==='ROLLBACK'?db.query('ROLLBACK TO SAVEPOINT devops_update'):db.query(sql,...args),
  release(){}
 })};
 await initProjectTeamSchema(pool);
 const spec=(await db.query("SELECT agent_name,agent_instructions FROM project_specialist_agents WHERE project_id=$1 AND role='devops'",[project])).rows[0];
 const stage=(await db.query("SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage='deployment'",[project])).rows[0];
 assert.equal(spec.agent_name,'Release Steward');
 assert.equal(stage.agent_name,spec.agent_name);
 assert.equal(stage.agent_instructions,spec.agent_instructions);
 assert.match(spec.agent_instructions,/корпоративного VPN/);
 assert.match(spec.agent_instructions,/блокировки CI/);
 assert.equal((await db.query("SELECT count(*)::int n FROM agent_instruction_history WHERE project_id=$1 AND role='devops'",[project])).rows[0].n,1);
 await initProjectTeamSchema(pool);
 assert.equal((await db.query("SELECT count(*)::int n FROM agent_instruction_history WHERE project_id=$1 AND role='devops'",[project])).rows[0].n,1,'Repeated startup must not duplicate instruction merges');
 await db.query('ROLLBACK');opened=false;
});

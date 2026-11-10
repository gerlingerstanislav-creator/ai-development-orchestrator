import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {agentSessionEffects,initAgentToolsSchema,createAgentSession,finishAgentSession,readAgentSession} from '../dist/agent-tools.js';
import {registerAgentToolRoutes} from '../dist/agent-tool-routes.js';

test('scoped MCP agent tools: migration, auth, document writes, rollback, idempotence and memory',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 const schema='agenttool_'+randomUUID().replaceAll('-','');
 t.after(async()=>{await app.close();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE users(id uuid PRIMARY KEY)',
  'CREATE TABLE projects(id uuid PRIMARY KEY,name text,description text)',
  'CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid,title text,body text,parent_id uuid,system_key text,source_refs jsonb DEFAULT \u0027[]\u0027::jsonb,import_source text,updated_at timestamptz DEFAULT now())',
  'CREATE UNIQUE INDEX idx_docs_src ON documents(project_id,import_source) WHERE import_source IS NOT NULL',
  'CREATE TABLE document_versions(id uuid PRIMARY KEY,document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,body text NOT NULL,task_ids jsonb NOT NULL DEFAULT jsonb_build_array(),created_at timestamptz NOT NULL DEFAULT now())',
  'CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,title text,description text,type text,stage text,analysis_state text,updated_at timestamptz DEFAULT now())',
  'CREATE TABLE task_events(id uuid,task_id uuid,actor_id uuid,event text,detail text)',
  'CREATE TABLE documentation_questions(id uuid,project_id uuid,job_id uuid,topic_key text,question_key text,document_id uuid,question text,status text DEFAULT \u0027open\u0027,answer text,created_at timestamptz DEFAULT now(),UNIQUE(project_id,document_id,question_key))',
  'CREATE TABLE project_rules(project_id uuid,body text,created_at timestamptz DEFAULT now())',
  'CREATE TABLE workflow_stages(project_id uuid,stage text,label text,mode text,agent_name text,agent_instructions text,position int)',
  'CREATE TABLE project_git_repositories(project_id uuid,repository text,target_branch text,default_branch text)',
  'CREATE TABLE document_import_jobs(id uuid,project_id uuid,actor_id uuid,status text,message text,source_url text,source_key text,request_text text,analyst_input jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())',
  'CREATE TABLE ai_task_runs(id uuid,task_id uuid,project_id uuid,status text,message text,created_at timestamptz DEFAULT now(),completed_at timestamptz)',
  'CREATE TABLE process_events(id uuid,project_id uuid,process_id uuid,process_kind text,stage text,detail text)'
 ].join(';\n').replaceAll('\\u0027',"'")+';');
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 await initAgentToolsSchema(pool);
 const project=randomUUID(),other=randomUUID(),user=randomUUID(),root=randomUUID(),foreign=randomUUID();
 await db.query('INSERT INTO users(id) VALUES($1)',[user]);
 await db.query("INSERT INTO projects(id,name,description) VALUES($1,'Coffee','Предзаказ'),($2,'Other','Другой проект')",[project,other]);
 await db.query("INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,'Техническое задание','',NULL,'spec'),($3,$4,'Чужой документ','Текст',NULL,'spec')",[root,project,foreign,other]);
 const startedWorkflows=[];
 const session=await createAgentSession(pool,project,user,'analyst');
 assert.equal((await readAgentSession(pool,session.secret)).project_id,project);
 await app.register(async server=>registerAgentToolRoutes(server,{
  pool,access:async()=>true,requireAdmin:async()=>true,startDocumentationWorkflow:async jobId=>{startedWorkflows.push(jobId);}
 }));
 const call=async(name,args={})=>app.inject({
  method:'POST',url:'/internal/agent-tools/call',
  headers:{'x-agent-token':session.secret},payload:{name,arguments:args}
 });
 const catalog=await app.inject({url:'/internal/agent-tools/catalog',headers:{'x-agent-token':session.secret}});
 assert.equal(catalog.statusCode,200);
 const tools=new Map(catalog.json().tools.map(tool=>[tool.name,tool]));
 for(const name of ['documents.list','documents.read','tasks.list','documentation.request_reset']){
  assert.deepEqual(tools.get(name).annotations,{readOnlyHint:true,openWorldHint:false,destructiveHint:false});
 }
 assert.equal(tools.get('documents.changeset').annotations.readOnlyHint,false);
 const manager=await createAgentSession(pool,project,user,'manager');
 const managerCatalog=await app.inject({url:'/internal/agent-tools/catalog',headers:{'x-agent-token':manager.secret}});
 assert.equal(managerCatalog.json().tools.find(tool=>tool.name==='tasks.list').annotations.readOnlyHint,true);
 const managerReset=await app.inject({method:'POST',url:'/internal/agent-tools/call',
  headers:{'x-agent-token':manager.secret},payload:{name:'documentation.request_reset'}});
 assert.equal(managerReset.statusCode,403);
 assert.equal(tools.has('documentation.reset.confirm'),false);
 assert.deepEqual((await call('documentation.request_reset')).json().result,{requires_user_confirmation:true});
 assert.equal((await agentSessionEffects(pool,session.id)).documentation_reset_requested,true);
 assert.equal((await agentSessionEffects(pool,manager.id)).documentation_reset_requested,false);
 const list=(await call('documents.list')).json().result.documents;
 assert.equal(list.length,1,'The agent only sees its own project');
 assert.equal((await call('documents.read',{document_id:foreign})).statusCode,404);
 assert.equal((await call('documents.create',{title:'Сценарии предзаказа',body:'Описание требований',parent_id:foreign})).statusCode,404);
 const args={title:'Сценарии предзаказа',body:'Описание требований',parent_id:root,idempotency_key:'first-spec-page'};
 const create=await call('documents.create',args);
 assert.equal(create.statusCode,200,create.body);
 const newId=create.json().result.id;
 const duplicate=await call('documents.create',args);
 assert.equal(duplicate.statusCode,200);
 assert.equal(duplicate.json().result.id,newId);
 assert.equal(duplicate.json().cached,true);
 assert.equal((await call('documents.create',{...args,title:'Другая страница'})).statusCode,409,
  'Idempotency keys must not be reused with other arguments');
 assert.equal((await db.query('SELECT count(*)::int n FROM documents WHERE id=$1',[newId])).rows[0].n,1);
 const read=(await call('documents.read',{document_id:newId})).json().result.document;
 assert.ok(read.revision);
 const updated=await call('documents.update',{document_id:newId,expected_revision:read.revision,body:'Новые согласованные условия'});
 assert.equal(updated.statusCode,200,updated.body);
 assert.equal((await db.query('SELECT count(*)::int n FROM document_versions WHERE document_id=$1',[newId])).rows[0].n,1,'Agent changes must be versioned');
 assert.equal((await call('documents.update',{document_id:newId,expected_revision:read.revision,body:'Устаревшие изменения'})).statusCode,409);
 assert.equal((await call('documents.update',{document_id:root,expected_revision:(await call('documents.read',{document_id:root})).json().result.document.revision,title:'Удалить корень'})).statusCode,409);
 const change=await call('documents.changeset',{operations:[
  {op:'create',title:'Внутренний вопрос',body:'Текст',parent_id:root},
  {op:'create',title:'Недопустимый',body:'Текст',parent_id:foreign}
 ]});
 assert.equal(change.statusCode,404);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE title='Внутренний вопрос'")).rows[0].n,0,
  'A failed changeset must roll back all pages');
 // Database writes AND their success audit must be one transaction.
 // If the success event cannot be persisted, the new document must roll back.
 await db.query("CREATE FUNCTION reject_audit_success() RETURNS trigger AS $agentfn$ BEGIN RAISE EXCEPTION 'simulated audit storage failure'; RETURN NEW; END; $agentfn$ LANGUAGE plpgsql");
 await db.query("CREATE TRIGGER reject_audit_success BEFORE INSERT ON agent_tool_events FOR EACH ROW WHEN (NEW.success AND NEW.tool='documents.create') EXECUTE FUNCTION reject_audit_success()");
 const auditFailure=await call('documents.create',{
  title:'Нельзя сохранить без аудита',body:'Текст',parent_id:root,idempotency_key:'audit-failure-atomic'
 });
 assert.equal(auditFailure.statusCode,400,auditFailure.body);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND title='Нельзя сохранить без аудита'",[project])).rows[0].n,0,
  'A successful API write must never survive if the matching audit event failed');
 await db.query('DROP TRIGGER reject_audit_success ON agent_tool_events');
 await db.query('DROP FUNCTION reject_audit_success()');

 const longAction={instructions:'Перераспредели импортированные страницы без удаления данных',idempotency_key:'doc-organize-unique-action'};
 const requested=await call('documentation.organize',longAction);
 assert.equal(requested.statusCode,200,requested.body);
 const jobId=requested.json().result.import_job_id;
 assert.equal(requested.json().result.status,'running');
 assert.equal(startedWorkflows[0],jobId);
 const requestedAgain=await call('documentation.organize',longAction);
 assert.equal(requestedAgain.statusCode,200,requestedAgain.body);
 assert.equal(requestedAgain.json().result.import_job_id,jobId,'Retries reuse one durable Temporal job');
 assert.equal((await db.query('SELECT count(*)::int n FROM document_import_jobs WHERE project_id=$1',[project])).rows[0].n,1);
 const memory=await call('memory.record',{kind:'observation',text:'Сначала изучай полную структуру ТЗ, затем редактируй конкретную страницу.',evidence:'Проверено в тесте'});
 assert.equal(memory.statusCode,200,memory.body);
 assert.equal((await call('memory.list')).json().result.memories.length,1);
 assert.ok((await db.query('SELECT count(*)::int n FROM agent_tool_events WHERE session_id=$1',[session.id])).rows[0].n>=8);
 await finishAgentSession(pool,session.id);
 assert.equal((await call('documents.list')).statusCode,403);

});

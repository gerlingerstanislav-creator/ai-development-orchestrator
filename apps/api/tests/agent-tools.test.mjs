import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import Fastify from 'fastify';
import pg from 'pg';
import {agentSessionEffects,initAgentToolsSchema,createAgentSession,finishAgentSession,readAgentSession} from '../dist/agent-tools.js';
import {initKnowledgeContext} from '../dist/knowledge-context.js';
import {initKnowledgeWorkflow} from '../dist/knowledge-workflow.js';
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
  'CREATE TABLE projects(id uuid PRIMARY KEY,name text,description text,owner_id uuid,deleted_at timestamptz)',
  'CREATE TABLE memberships(project_id uuid,user_id uuid)',
  'CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid,title text,body text,parent_id uuid,system_key text,source_refs jsonb DEFAULT \u0027[]\u0027::jsonb,import_source text,updated_at timestamptz DEFAULT now())',
  'CREATE UNIQUE INDEX idx_docs_src ON documents(project_id,import_source) WHERE import_source IS NOT NULL',
  'CREATE TABLE document_versions(id uuid PRIMARY KEY,document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,body text NOT NULL,task_ids jsonb NOT NULL DEFAULT jsonb_build_array(),created_at timestamptz NOT NULL DEFAULT now())',
  'CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,title text,description text,type text,stage text,analysis_state text,clarification_questions jsonb,depends_on_task_id uuid,pr_url text,document_id uuid,updated_at timestamptz DEFAULT now())',
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
 await initKnowledgeContext(pool);
 await initKnowledgeWorkflow(pool);
 const project=randomUUID(),other=randomUUID(),user=randomUUID(),root=randomUUID(),foreign=randomUUID();
 await db.query('INSERT INTO users(id) VALUES($1)',[user]);
 await db.query("INSERT INTO projects(id,name,description,owner_id) VALUES($1,'Coffee','Предзаказ',$3),($2,'Other','Другой проект',$3)",[project,other,user]);
 await db.query("INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,'Техническое задание','',NULL,'spec'),($3,$4,'Чужой документ','Текст',NULL,'spec')",[root,project,foreign,other]);
 const startedWorkflows=[];
 const runnerSecret='integration-runner-secret-not-for-production';
 const session=await createAgentSession(pool,project,user,'analyst');
 assert.equal((await readAgentSession(pool,session.secret)).project_id,project);
 await app.register(async server=>registerAgentToolRoutes(server,{
  pool,runnerSecret,access:async()=>true,requireAdmin:async()=>true,startDocumentationWorkflow:async jobId=>{startedWorkflows.push(jobId);}
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
 assert.equal(tools.get('documents.delete').annotations.readOnlyHint,false);
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
 assert.equal(await call('tasks.request_owner_question_cleanup').then(res=>res.statusCode),403);
 const managerCleanup=await app.inject({method:'POST',url:'/internal/agent-tools/call',
  headers:{'x-agent-token':manager.secret},payload:{name:'tasks.request_owner_question_cleanup'}});
 assert.deepEqual(managerCleanup.json().result,{requires_user_confirmation:true});
 assert.equal((await agentSessionEffects(pool,manager.id)).owner_question_cleanup_requested,true);

 const list=(await call('documents.list')).json().result.documents;
 assert.ok(list.some(document=>document.id===root));
 assert.ok(list.every(document=>document.id!==foreign),'The agent only sees its own project');
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
 assert.equal((await db.query('SELECT count(*)::int n FROM document_versions WHERE document_id=$1',[newId])).rows[0].n,0,'Agent changes update the same page without a history row');
 assert.equal((await call('documents.update',{document_id:newId,expected_revision:read.revision,body:'Устаревшие изменения'})).statusCode,409);
 assert.equal((await call('documents.update',{document_id:root,expected_revision:(await call('documents.read',{document_id:root})).json().result.document.revision,title:'Удалить корень'})).statusCode,409);
 // The analyst chooses the layout; empty, non-sourced leaves may be cleaned up,
 // but source evidence, content, links, children and system roots remain safe.
 const getRevision=async id=>(await call('documents.read',{document_id:id})).json().result.document.revision;
 const empty=await call('documents.create',{title:'Пустая заготовка',body:'',parent_id:root});
 const emptyId=empty.json().result.id;
 const deleteArgs={document_id:emptyId,expected_revision:await getRevision(emptyId),idempotency_key:'delete-blank-stub'};
 assert.equal((await call('documents.delete',{document_id:foreign,expected_revision:await getRevision(emptyId)})).statusCode,404);
 assert.equal((await call('documents.delete',{document_id:root,expected_revision:await getRevision(root)})).statusCode,409);
 assert.equal((await call('documents.delete',{document_id:newId,expected_revision:await getRevision(newId)})).statusCode,409,'Cannot discard a page with requirements');
 assert.equal((await call('documents.delete',deleteArgs)).statusCode,200);
 assert.equal((await call('documents.delete',deleteArgs)).json().cached,true,'Safe retries do not delete again');
 assert.equal((await call('documents.read',{document_id:emptyId})).statusCode,404);
 const parentPage=(await call('documents.create',{title:'Ненужная папка',parent_id:root})).json().result.id;
 const childPage=(await call('documents.create',{title:'Вложенная заготовка',parent_id:parentPage})).json().result.id;
 assert.equal((await call('documents.delete',{document_id:parentPage,expected_revision:await getRevision(parentPage)})).statusCode,409);
 const childRevision=await getRevision(childPage);
 const batch=await call('documents.changeset',{operations:[
  {op:'delete',document_id:childPage,expected_revision:childRevision},
  {op:'update',document_id:foreign,expected_revision:childRevision,body:'Wrong project'}
 ]});
 assert.equal(batch.statusCode,404,'A failed restructuring batch must roll back deletion');
 assert.equal((await call('documents.read',{document_id:childPage})).statusCode,200);
 assert.equal((await call('documents.delete',{document_id:childPage,expected_revision:childRevision})).statusCode,200);
 assert.equal((await call('documents.delete',{document_id:parentPage,expected_revision:await getRevision(parentPage)})).statusCode,200);
 const linked=(await call('documents.create',{title:'Связанная пустая страница',parent_id:root})).json().result.id;
 await db.query("INSERT INTO tasks(id,project_id,title,description,document_id) VALUES($1,$2,'Связанная задача','Ссылка на страницу',$3)",[randomUUID(),project,linked]);
 assert.equal((await call('documents.delete',{document_id:linked,expected_revision:await getRevision(linked)})).statusCode,409);
 const importedStub=(await call('documents.create',{title:'Импортированная пустая страница',parent_id:root})).json().result.id;
 await db.query("UPDATE documents SET import_source='topic:protected' WHERE id=$1",[importedStub]);
 assert.equal((await call('documents.delete',{document_id:importedStub,expected_revision:await getRevision(importedStub)})).statusCode,409);
 const versioned=(await call('documents.create',{title:'Пустая страница с историей',parent_id:root})).json().result.id;
 await db.query('INSERT INTO document_versions(id,document_id,body) VALUES($1,$2,$3)',[randomUUID(),versioned,'Старая версия']);
 assert.equal((await call('documents.delete',{document_id:versioned,expected_revision:await getRevision(versioned)})).statusCode,409);
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
 const organizeContext=(await db.query('SELECT analyst_input FROM document_import_jobs WHERE id=$1',[jobId])).rows[0].analyst_input;
 assert.equal(organizeContext.autonomous,true,'PM organization must use the autonomous analyst, not imported-topic legacy');
 assert.equal(organizeContext.structureOnly,false);
 assert.equal(organizeContext.rebuildSpec,false);
 const requestedAgain=await call('documentation.organize',longAction);
 assert.equal(requestedAgain.statusCode,200,requestedAgain.body);
 assert.equal(requestedAgain.json().result.import_job_id,jobId,'Retries reuse one durable Temporal job');
 assert.equal((await db.query('SELECT count(*)::int n FROM document_import_jobs WHERE project_id=$1',[project])).rows[0].n,1);
 await db.query("UPDATE document_import_jobs SET status='completed' WHERE id=$1",[jobId]);
 const sourceUrl='https://github.com/gerlingerstanislav-creator/ideas/tree/main/coffee-preorder-43-0.3';
 const imported=await call('documentation.import',{source_url:sourceUrl,idempotency_key:'coffee-import-action'});
 assert.equal(imported.statusCode,200,imported.body);
 const importId=imported.json().result.import_job_id;
 assert.equal(startedWorkflows.at(-1),importId);
 const savedImport=(await db.query('SELECT source_url,analyst_input FROM document_import_jobs WHERE id=$1',[importId])).rows[0];
 assert.equal(savedImport.source_url,sourceUrl);
 assert.equal(savedImport.analyst_input.location.path,'coffee-preorder-43-0.3');
 const memory=await call('memory.record',{kind:'observation',text:'Сначала изучай полную структуру ТЗ, затем редактируй конкретную страницу.',evidence:'Проверено в тесте'});
 assert.equal(memory.statusCode,200,memory.body);
 assert.equal((await call('memory.list')).json().result.memories.length,1);
 assert.ok((await db.query('SELECT count(*)::int n FROM agent_tool_events WHERE session_id=$1',[session.id])).rows[0].n>=8);
 await finishAgentSession(pool,session.id);
 assert.equal((await call('documents.list')).statusCode,403);

 const coffee=JSON.parse(await readFile(new URL('./fixtures/coffee-preorder-43-0.3.json',import.meta.url),'utf8'));
 const requirements=coffee.files.find(file=>file.path.endsWith('/REQUIREMENTS.md'));
 const [docId,taskId,otherTaskId,processId]=Array.from({length:4},randomUUID);
 await db.query("INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,'Coffee Preorder: требования',$3,$4)",[docId,project,requirements.body,root]);
 await db.query("INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'Учесть неоплаченные заказы','Найти правило в ТЗ'),($3,$4,'Чужая задача','Другое ТЗ')",[taskId,project,otherTaskId,other]);
 const readerUrl='/internal/agent-tools/reader-sessions';
 const createReader=(headers,options={})=>app.inject({
  method:'POST',url:readerUrl,headers,payload:{projectId:project,taskId,processId,role:'development',...options}
 });
 assert.equal((await createReader({'x-agent-token':manager.secret})).statusCode,403);
 assert.equal((await createReader({'x-runner-secret':runnerSecret},{taskId:otherTaskId})).statusCode,404);
 const newReaders=[];
 for(const role of ['manager','analyst','business_analyst','analysis','development','testing','documentation','devops']){
  // Documentation readers without an active documentation job are read-only.
  // Running documentation jobs have their own scoped write authority and tests.
  const started=await createReader({'x-runner-secret':runnerSecret},
   {role,...(role==='documentation'?{processId:undefined}:{})});
  assert.equal(started.statusCode,201,started.body);
  const {id,secret}=started.json();
  const headers={'x-agent-token':secret};
  const callReader=(name,args)=>app.inject({method:'POST',url:'/internal/agent-tools/call',headers,payload:{name,arguments:args}});
  const readerCatalog=(await app.inject({url:'/internal/agent-tools/catalog',headers})).json().tools;
  const specialist=['analysis','development','testing','devops'].includes(role);
   if(specialist){
    assert.ok(readerCatalog.some(tool=>tool.name==='blockers.report'&&!tool.annotations.readOnlyHint),
     'Task-scoped specialists can record verified blockers');
    assert.ok(readerCatalog.every(tool=>tool.annotations.readOnlyHint||
     ['agents.consult','blockers.report','blockers.resolve','processes.report'].includes(tool.name)),
     'Scoped specialists may mutate only consultation, blockers and process reports');
   }else assert.ok(readerCatalog.every(tool=>tool.annotations.readOnlyHint),'Reader session must be read-only');
  assert.ok(readerCatalog.some(tool=>tool.name==='knowledge.section'));
  assert.equal((await callReader('documents.update',{document_id:docId,body:'Чужое изменение'})).statusCode,403);
  assert.equal((await callReader('knowledge.read',{document_id:foreign,mode:'full'})).statusCode,404);
  assert.equal((await callReader('tasks.read',{task_id:otherTaskId})).statusCode,403);
  const search=await callReader('knowledge.search',{query:'неоплаченные заказы'});
  assert.equal(search.statusCode,200,search.body);
  assert.ok(search.json().result.results.some(doc=>doc.id===docId));
  const outline=await callReader('knowledge.sections',{document_id:docId});
  assert.equal(outline.statusCode,200,outline.body);
  const section=outline.json().result.sections.find(item=>item.title.includes('неоплаченные заказы'));
  assert.ok(section);
  const read=await callReader('knowledge.section',{document_id:docId,section_id:section.section_id});
  assert.equal(read.statusCode,200,read.body);
  assert.match(read.json().result.body,/заказ/iu);
  newReaders.push({id,role,sectionId:section.section_id});
  assert.equal((await app.inject({method:'DELETE',url:readerUrl,headers:{...headers,'x-runner-secret':runnerSecret}})).statusCode,204);
  assert.equal((await callReader('knowledge.sections',{document_id:docId})).statusCode,403);
 }
 const reads=(await db.query('SELECT task_id,document_id,agent_stage,agent_session_id,section_id,section_title,process_id FROM knowledge_context_reads WHERE agent_session_id=ANY($1::uuid[])',[newReaders.map(x=>x.id)])).rows;
 assert.equal(reads.length,newReaders.length);
 for(const reader of newReaders){
  const row=reads.find(read=>read.agent_session_id===reader.id);
  assert.deepEqual([row.task_id,row.document_id,row.agent_stage,row.section_id],[taskId,docId,reader.role,reader.sectionId]);
  assert.match(row.section_title,/неоплаченные заказы/);
 }

});

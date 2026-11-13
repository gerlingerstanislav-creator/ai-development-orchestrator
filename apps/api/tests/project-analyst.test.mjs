import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {createAssistantService} from '../dist/assistant.js';

test('analyst writes topic drafts, resolves PO questions, resumes and preserves manual edits',async t=>{
 // Verify durable analysis jobs directly; natural-language routing is covered by MCP agent tests.
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 t.after(()=>db.end());
 const app=Fastify();
 t.after(()=>app.close());
 await db.query(String.raw`
  CREATE TEMP TABLE projects (id uuid, name text, description text);
  CREATE TEMP TABLE tasks (id uuid PRIMARY KEY,project_id uuid,title text,description text,type text,stage text,position int DEFAULT 0,analysis_state text,clarification_questions jsonb,related_task_ids jsonb,depends_on_task_id uuid,dependency_source text,document_id uuid,question_key text,question_topic text,question_status text,question_answer text,question_answered_at timestamptz,question_job_id uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX ON tasks(project_id,document_id,question_key) WHERE type='question';
  CREATE TEMP TABLE task_events (id uuid,task_id uuid,actor_id uuid,event text,detail text);
  CREATE TEMP TABLE project_git_repositories (project_id uuid,repository text,default_branch text,target_branch text);
  CREATE TEMP TABLE assistant_usage (id uuid,project_id uuid,actor_id uuid);
  CREATE TEMP TABLE documents (id uuid,project_id uuid,title text,body text,parent_id uuid,import_source text,system_key text,import_synced_hash text,source_refs jsonb DEFAULT '[]'::jsonb,document_kind text,implementation_status text,updated_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX ON documents(project_id,import_source) WHERE import_source IS NOT NULL;
  CREATE TEMP TABLE assistant_messages (id uuid,project_id uuid,task_id uuid,actor_id uuid,role text,body text,created_task_id uuid,created_document_id uuid,channel text,created_at timestamptz DEFAULT now(),documentation_reset_requested boolean DEFAULT false,owner_question_cleanup_requested boolean DEFAULT false,task_deletion_ids uuid[]);
  CREATE TEMP TABLE project_ai_settings (project_id uuid,enabled boolean,model text,reasoning text);
  CREATE TEMP TABLE workflow_stages (project_id uuid,stage text,agent_name text,agent_instructions text);
  CREATE TEMP TABLE project_conversation_agents (project_id uuid,role text,agent_name text,agent_instructions text);
  CREATE TEMP TABLE knowledge_instruction_modules (id uuid,project_id uuid,stage text,title text,body text,mandatory boolean,priority int,status text);
  CREATE TEMP TABLE agent_memory (id uuid,project_id uuid,role text,kind text,body text,evidence text,status text,applicability jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now());
  CREATE TEMP TABLE project_rules (project_id uuid,body text,created_at timestamptz);
  CREATE TEMP TABLE process_instructions (project_id uuid,process_id uuid,body text,created_at timestamptz);
  CREATE TEMP TABLE process_events (id uuid,project_id uuid,process_id uuid,process_kind text,level text,stage text,detail text);
  CREATE TEMP TABLE document_import_jobs (id uuid PRIMARY KEY,project_id uuid,actor_id uuid,status text,message text,source_url text,source_key text,request_text text,analyst_input jsonb,source_snapshot jsonb,source_commit text,rebuild_sources jsonb,rebuild_plan jsonb,draft_result jsonb,result jsonb,source_file_count int,total_chunks int,analyzed_chunks int,saved_documents int DEFAULT 0,updated_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX ON document_import_jobs(project_id) WHERE status='running' AND analyst_input IS NOT NULL;
  CREATE TEMP TABLE document_import_checkpoints (job_id uuid,chunk_index int,file_path text,content_sha text,notes text,created_at timestamptz DEFAULT now(),PRIMARY KEY(job_id,chunk_index));
  CREATE TEMP TABLE document_import_fragments (job_id uuid,fragment_index int,file_path text,heading text,content_sha text,notes text,topics jsonb,exclusion_reason text,PRIMARY KEY(job_id,fragment_index));
  CREATE TEMP TABLE document_import_topics (job_id uuid,topic_key text,title text,status text DEFAULT 'pending',cursor int DEFAULT 0,page_id uuid,draft_body text DEFAULT '',source_refs jsonb DEFAULT '[]'::jsonb,review_suggestion text,rebuild_questions jsonb NOT NULL DEFAULT '[]'::jsonb,updated_at timestamptz DEFAULT now(),PRIMARY KEY(job_id,topic_key));
  CREATE TEMP TABLE document_import_proposals (id uuid,project_id uuid,job_id uuid,topic_key text,document_id uuid,title text,proposed_body text,base_hash text,status text DEFAULT 'open',created_at timestamptz DEFAULT now(),decided_at timestamptz,UNIQUE(job_id,topic_key));
 `.replaceAll('\\`','`'));
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 const projectId=randomUUID(),actorId=randomUUID(),rootId=randomUUID();
 await db.query("INSERT INTO projects VALUES($1,'Coffee','Предзаказ кофе')",[projectId]);
 await db.query("INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,'Техническое задание','',NULL,'spec')",[rootId,projectId]);
 for(const [key,title] of [['architecture','Архитектура и технические решения'],['operations','Запуск и эксплуатация'],['design','Дизайн и интерфейсы'],['research','Исходные материалы и исследования']]){
  await db.query('INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,$3,\'\',NULL,$4)',[randomUUID(),projectId,title,key]);
 }
 await db.query("INSERT INTO project_ai_settings VALUES($1,true,'gpt-6-luna','low')",[projectId]);
 await db.query("INSERT INTO project_conversation_agents VALUES($1,'analyst','Бизнес-аналитик','Зафиксируй правила предзаказа')",[projectId]);
 await db.query("INSERT INTO workflow_stages VALUES($1,'analysis','Системный аналитик','Опиши контракты API')",[projectId]);
 const originalFetch=globalThis.fetch;
 let pageId=null,modelCalls=0,failOnce=false,seenTopicCalls=0;
 let failRebuildOnce=false,rebuildPartCalls=0,rebuildPlanCalls=0;
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'http://codex.test/assistant','Imported sources must not be requested again during follow-up');
  modelCalls++;
  const {prompt}=JSON.parse(options.body);
  if(prompt.includes('Ты бизнес-аналитик проекта и собеседник владельца продукта.')){
   assert.match(prompt,/Зафиксируй правила предзаказа/);
   assert.doesNotMatch(prompt,/Опиши контракты API/);
   assert.ok(prompt.includes('Предзаказ'),'Analyst must see current project documentation for a reasoned critique');
   return Response.json({message:'Структура пока недостаточно подробная: два сценария нужно сгруппировать по подсистемам. Предлагаю разделить функциональные требования, UX и исходные материалы.'});
  }
  if(prompt.includes('Составь план НОВЫХ содержательных тематических страниц')){
   rebuildPlanCalls++;
   assert.match(prompt,/Структура пока недостаточно подробная/,'Reuse actual previously proposed structure; prompt='+prompt.slice(0,2100));
   const old=(await db.query("SELECT id,import_source FROM documents WHERE project_id=$1 AND import_source LIKE 'topic:%' ORDER BY title,id",[projectId])).rows;
   assert.equal(old.length,2);
   return Response.json({message:JSON.stringify({chapters:[
    {key:'customer-preorder',title:'Оформление предзаказа',section:'spec',group:'Покупатель',source_ids:[old[0].id]},
    {key:'handoff',title:'Выдача готового заказа',section:'spec',group:'Покупатель',source_ids:[old[1].id]}
   ]})});
  }
  if(prompt.includes('ПЕРЕПИШИ один фрагмент')){
   rebuildPartCalls++;
   if(failRebuildOnce&&rebuildPartCalls===2){
    failRebuildOnce=false;
    return Response.json({error:'Simulated second-section model failure'},{status:400});
   }
   const body=prompt.includes('Оформление предзаказа')?
    '## Предзаказ покупателя\nПокупатель оформляет заказ. Существующие требования сохранены и согласованные правила не изменены.':
    '## Выдача готового заказа\nБариста передаёт готовый заказ покупателю. Существующие требования и ограничения сохранены.';
   return Response.json({message:JSON.stringify({body,questions:['Как подтверждается готовность заказа?']})});
  }
  if(prompt.includes('Улучши НАВИГАЦИОННУЮ структуру')){
   const found=await db.query("SELECT id FROM documents WHERE project_id=$1 AND import_source LIKE 'topic:%'",[projectId]);
   return Response.json({message:JSON.stringify({items:found.rows.map(d=>({id:d.id,section:'spec',group:'Заказы покупателя'}))})});
  }
  let output;
  if(prompt.includes('Выдели факты')){
   const second=prompt.includes('Выдача заказа');
   output={notes:second?'Выдача заказа бариста после приготовления.':'Покупатель оформляет предзаказ, оплата не определена.',
    topics:[{key:second?'handoff':'preorder',title:second?'Выдача':'Предзаказ'}],exclusion_reason:null};
  }else if(prompt.includes('Сформируй ОДНУ самостоятельную порцию ТЗ')){
   seenTopicCalls++;
   if(failOnce&&seenTopicCalls===2){failOnce=false;return Response.json({error:'simulated temporary failure'},{status:400});}
   output={body:prompt.includes('Тема: Выдача')?'Бариста передаёт готовый заказ клиенту. Уточнить порядок выдачи.':'Покупатель может оформить предварительный заказ. Способ оплаты требует уточнения.',
    questions:prompt.includes('Тема: Выдача')?[]:['Где оплачивается заказ?']};
  }else if(prompt.includes('Составь одну задачу разработки')){
   output={title:'Добавить два круга',description:'Отобразить внешний и внутренний контуры.',questions:['Круги вокруг каждой фигуры или всей группы?']};
  }else if(prompt.includes('Владельцем продукта дан ответ')){
   assert.ok(prompt.includes('Оплата при получении'),prompt.slice(0,300));
   output={addition:'Покупатель оформляет заказ и оплачивает его при получении.',summary:'Требование по оплате уточнено.'};
  }else{
   assert.ok(prompt.includes('Оплата при получении'),prompt.slice(0,300));
   assert.ok(prompt.includes(pageId));
   output={reply:'Требование по оплате уточнено.',operations:[{op:'update',id:pageId,title:'Предзаказ',body:'Покупатель оформляет заказ и оплачивает его при получении.'}]};
  }
  return Response.json({message:JSON.stringify(output)});
 };
 t.after(()=>{globalThis.fetch=originalFetch;});
 const service=createAssistantService({pool,codexUrl:'http://codex.test',runnerKey:'test',decryptToken:()=>''});
 const started=[];
 service.registerRoutes(app,{pool,uid:()=>actorId,access:async()=>true,requireAdmin:async()=>true,startDocumentationWorkflow:async id=>started.push(id)});
 const queueJob=async({message,attachments=[],structureOnly=false,rebuildSpec=false,sourceKey}={})=>{
  const jobId=randomUUID();
  await db.query("INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,source_key,request_text,analyst_input) VALUES($1,$2,$3,'running','Запуск аналитика',$4,$5,$6)",
   [jobId,projectId,actorId,sourceKey||'analyst:'+jobId,message||'Подготовь документацию',JSON.stringify({
    location:null,attachments,mode:'documentation',documentId:null,structureOnly,rebuildSpec
   })]);
  return jobId;
 };
 assert.equal((await db.query("SELECT count(*)::int n FROM tasks WHERE type<>'question'")).rows[0].n,0);
 const attachments=[{name:'coffee.md',body:'# Предзаказ\nПокупатель оформляет заказ.'},{name:'barista.md',body:'# Выдача заказа\nБариста выдаёт заказ.'}];
 failOnce=true;
 const jobId=await queueJob({message:'Составь ТЗ по темам',attachments,sourceKey:'attachments:coffee-source'});
 await service.runDocumentationJob(jobId);
 assert.equal((await db.query('SELECT status FROM document_import_jobs WHERE id=$1',[jobId])).rows[0].status,'failed');
 const saved=(await db.query("SELECT id,body FROM documents WHERE import_source LIKE 'topic:%'")).rows;
 assert.equal(saved.length,1,'Completed first topic is visible even after a later failure');
 pageId=saved[0].id;
 const resume=await app.inject({method:'POST',url:'/api/projects/'+projectId+'/document-import/'+jobId+'/resume'});
 assert.equal(resume.statusCode,202,resume.body);
 assert.equal(resume.json().import_job_id,jobId,'Resume must reuse the same process');
 await service.runDocumentationJob(jobId);
 const completed=(await db.query('SELECT status,result FROM document_import_jobs WHERE id=$1',[jobId])).rows[0];
 assert.equal(completed.status,'completed');
 assert.equal(completed.result.generated_documents,2);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE import_source LIKE 'topic:%'")).rows[0].n,2);
 // Preserve an earlier owner/analyst design decision as factual conversation history.
 const previousDecision='Структура пока недостаточно подробная: два сценария нужно сгруппировать по подсистемам. Предлагаю разделить функциональные требования, UX и исходные материалы.';
 await db.query("INSERT INTO assistant_messages(id,project_id,task_id,role,body,channel,created_at) VALUES($1,$2,NULL,'assistant',$3,'documentation',now())",
  [randomUUID(),projectId,previousDecision]);
 // Simulate an older completed import, from before raw-source archiving existed.
 // Organizing must recover all originals from the pinned snapshot without asking GitHub again.
 await db.query("DELETE FROM documents WHERE project_id=$1 AND import_source LIKE 'source:%'",[projectId]);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND import_source LIKE 'source:%'",[projectId])).rows[0].n,0);
 const restructuringJob=await queueJob({message:'Сгруппируй страницы по системным разделам',structureOnly:true});
 await service.runDocumentationJob(restructuringJob);
 const organized=(await db.query('SELECT id,body,parent_id FROM documents WHERE import_source LIKE $1',['topic:%'])).rows;
 assert.equal(organized.length,2);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND import_source LIKE 'source:%'",[projectId])).rows[0].n,2,'Legacy source files are recovered from saved import snapshots');
 assert.equal(organized.find(x=>x.id===pageId).id,pageId,'Document ID survives reorganization');
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE import_source LIKE 'structure:%'")).rows[0].n,1);
 assert.equal(organized[0].parent_id,organized[1].parent_id,'Related pages are grouped under the same navigation node');
 assert.equal((await db.query("SELECT count(*)::int n FROM tasks WHERE type<>'question'")).rows[0].n,0);
 const checkpointCalls=modelCalls;
 await service.runDocumentationJob(jobId);
 assert.equal(modelCalls,checkpointCalls,'Completed jobs must not replay');
 const questions=(await app.inject('/api/projects/'+projectId+'/documentation/questions')).json();
 assert.ok(questions.length>=1,'Product-owner clarification is created and linked to the document');
 assert.equal(questions[0].document_id,pageId);
 const answered=await app.inject({method:'POST',url:'/api/projects/'+projectId+'/documentation/questions/'+questions[0].id+'/answer',payload:{answer:'Оплата при получении'}});
 assert.equal(answered.statusCode,202,answered.body);
 await service.runDocumentationJob(answered.json().import_job_id);
 assert.equal((await db.query("SELECT question_status AS status FROM tasks WHERE id=$1",[questions[0].id])).rows[0].status,'resolved');
 assert.match((await db.query('SELECT body FROM documents WHERE id=$1',[pageId])).rows[0].body,/оплачивает его при получении/);
 assert.equal((await db.query("SELECT count(*)::int n FROM tasks WHERE type<>'question'")).rows[0].n,0,'Documentation questions never create development tasks');

 // User edits an imported page. Reimport the same named sources and preserve it.
 await db.query("UPDATE documents SET body='Ручная правка владельца',updated_at=now() WHERE id=$1",[pageId]);
 const rerunId=await queueJob({message:'Повторная сверка источников',attachments,sourceKey:'attachments:coffee-source'});
 await service.runDocumentationJob(rerunId);
 assert.equal((await db.query('SELECT body FROM documents WHERE id=$1',[pageId])).rows[0].body,'Ручная правка владельца');
 const proposals=(await db.query("SELECT id,document_id,status FROM document_import_proposals WHERE document_id=$1",[pageId])).rows;
 assert.equal(proposals.length,1,'Conflicting import creates review proposal');
 assert.equal(proposals[0].status,'open');
 const reject=await app.inject({method:'POST',url:'/api/projects/'+projectId+'/documentation/proposals/'+proposals[0].id+'/decision',payload:{decision:'reject'}});
 // This standalone assistant fixture does not register the general index.ts route.
 assert.equal(reject.statusCode,404);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE import_source LIKE 'topic:%'")).rows[0].n,2,'No duplicate topics on repeated import');

 // The user's real follow-up is a COMMAND, not a request for another opinion.
 // Build two new substantive pages; a simulated failure must not move old docs.
 const oldVersions=(await db.query("SELECT id,title,body,parent_id,source_refs FROM documents WHERE project_id=$1 AND import_source LIKE 'topic:%' ORDER BY title,id",[projectId])).rows;
 assert.equal(oldVersions.length,2);
 failRebuildOnce=true;rebuildPartCalls=0;
 const rewriteMessage='Ок, давай перепиши текущее ТЗ в соответствии с предложенной тобой структурой, а текущие материалы можешь перенести в исходники';
 const rewriteId=await queueJob({message:rewriteMessage,rebuildSpec:true});
 const flag=(await db.query('SELECT analyst_input FROM document_import_jobs WHERE id=$1',[rewriteId])).rows[0].analyst_input;
 assert.equal(flag.rebuildSpec,true,'The explicit conversational command must choose the rewrite workflow');
 await service.runDocumentationJob(rewriteId);
 assert.equal((await db.query('SELECT status FROM document_import_jobs WHERE id=$1',[rewriteId])).rows[0].status,'failed');
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND import_source LIKE 'rebuild:%'",[projectId])).rows[0].n,1,
  'The first completed rewritten page must already be persisted. Job: '+JSON.stringify((await db.query('SELECT status,message,rebuild_plan FROM document_import_jobs WHERE id=$1',[rewriteId])).rows[0]));
 for(const oldDoc of oldVersions){
  const current=(await db.query('SELECT body,parent_id FROM documents WHERE id=$1',[oldDoc.id])).rows[0];
  assert.equal(current.body,oldDoc.body);
  assert.equal(current.parent_id,oldDoc.parent_id,'Old documents stay where they were before all new pages are complete');
 }
 const planCallsBeforeResume=rebuildPlanCalls;
 const resumeRewrite=await app.inject({method:'POST',url:'/api/projects/'+projectId+'/document-import/'+rewriteId+'/resume'});
 assert.equal(resumeRewrite.statusCode,202,resumeRewrite.body);
 await service.runDocumentationJob(rewriteId);
 const finished=(await db.query('SELECT status,rebuild_sources,rebuild_plan,result FROM document_import_jobs WHERE id=$1',[rewriteId])).rows[0];
 assert.equal(finished.status,'completed');
 assert.equal(finished.rebuild_sources.length,2);
 assert.equal(finished.rebuild_plan.chapters.length,2);
 assert.equal(finished.result.generated_documents,2);
 assert.equal(rebuildPlanCalls,planCallsBeforeResume,'The same structure plan must be reused after failure');
 assert.equal(rebuildPartCalls,3,'On resume only the failed second page is regenerated');
 const rewritten=(await db.query("SELECT id,title,body,parent_id,import_source FROM documents WHERE project_id=$1 AND import_source LIKE 'rebuild:%' ORDER BY title",[projectId])).rows;
 assert.equal(rewritten.length,2);
 assert.ok(rewritten.every(d=>d.body.includes('## Исходные материалы')),'Each new page identifies original source documents');
 assert.ok(rewritten.every(d=>oldVersions.some(o=>d.body.includes(o.id))),'New text links to the underlying original pages');
 const oldArchive=(await db.query("SELECT id FROM documents WHERE project_id=$1 AND import_source=$2",[projectId,'rebuild-archive:'+rewriteId])).rows[0];
 assert.ok(oldArchive,'Previous versions are grouped under Research');
 const research=(await db.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='research'",[projectId])).rows[0];
 assert.equal((await db.query('SELECT parent_id FROM documents WHERE id=$1',[oldArchive.id])).rows[0].parent_id,research.id);
 for(const original of oldVersions){
  const current=(await db.query('SELECT id,title,body,parent_id,source_refs,import_source FROM documents WHERE id=$1',[original.id])).rows[0];
  assert.equal(current.id,original.id);
  assert.equal(current.title,original.title);
  assert.equal(current.body,original.body,'Exact historical version is not rewritten or deleted');
  assert.deepEqual(current.source_refs,original.source_refs);
  assert.equal(current.parent_id,oldArchive.id,'Previous pages are moved to Research after successful rewrite');
  assert.match(current.import_source,/^archived-topic:/);
 }
 assert.equal((await db.query("SELECT count(*)::int n FROM tasks WHERE type<>'question'")).rows[0].n,0,'Rebuilding does not launch development');
 assert.equal((await db.query("SELECT count(*)::int n FROM tasks WHERE type='question' AND question_job_id=$1",[rewriteId])).rows[0].n,2,
  'Open product-owner questions are linked to rewritten pages');
 const beforeReplay=rebuildPartCalls;
 await service.runDocumentationJob(rewriteId);
 assert.equal(rebuildPartCalls,beforeReplay,'A completed rewrite is not rerun');
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND import_source LIKE 'rebuild:%'",[projectId])).rows[0].n,2);

});

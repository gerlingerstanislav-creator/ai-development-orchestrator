import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {createAssistantService,isExplicitTaskCreation,isExplicitDocumentationChange,isDocumentationStructureCommand} from '../dist/assistant.js';

test('task commands are explicit even in the analyst chat',()=>{
 assert.equal(isExplicitTaskCreation('Создай задачу, а в ней уже спроси'),true);
 assert.equal(isExplicitTaskCreation('Пожалуйста, создай новую задачу: обновить документацию'),true);
 assert.equal(isExplicitTaskCreation('Как создать задачу из документации?'),false);
 assert.equal(isExplicitTaskCreation('Создай документ, в котором есть список задач'),false);
});

test('analyst distinguishes questions, critique and explicit structural edits',()=>{
 assert.equal(isExplicitDocumentationChange('Тебя устраивает структура нашего ТЗ?'),false);
 assert.equal(isDocumentationStructureCommand('Тебя устраивает структура нашего ТЗ?'),false);
 assert.equal(isExplicitDocumentationChange('Как бы ты улучшил структуру документации?'),false);
 assert.equal(isDocumentationStructureCommand('Улучши структуру нашей документации'),true);
 assert.equal(isDocumentationStructureCommand('Перестрой структуру ТЗ'),true);
 assert.equal(isExplicitDocumentationChange('Добавь в ТЗ критерии приёмки'),true);
 assert.equal(isExplicitDocumentationChange('Давай обсудим риски проекта'),false);
});

test('analyst writes topic drafts, resolves PO questions, resumes and preserves manual edits',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 t.after(()=>db.end());
 const app=Fastify();
 t.after(()=>app.close());
 await db.query(String.raw`
  CREATE TEMP TABLE projects (id uuid, name text, description text);
  CREATE TEMP TABLE tasks (id uuid,project_id uuid,title text,description text,type text,stage text,analysis_state text,clarification_questions jsonb,related_task_ids jsonb,depends_on_task_id uuid,dependency_source text,created_at timestamptz DEFAULT now());
  CREATE TEMP TABLE task_events (id uuid,task_id uuid,actor_id uuid,event text,detail text);
  CREATE TEMP TABLE project_git_repositories (project_id uuid,repository text,default_branch text,target_branch text);
  CREATE TEMP TABLE assistant_usage (id uuid,project_id uuid,actor_id uuid);
  CREATE TEMP TABLE documents (id uuid,project_id uuid,title text,body text,parent_id uuid,import_source text,system_key text,import_synced_hash text,source_refs jsonb DEFAULT '[]'::jsonb,document_kind text,implementation_status text,updated_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX ON documents(project_id,import_source) WHERE import_source IS NOT NULL;
  CREATE TEMP TABLE assistant_messages (id uuid,project_id uuid,task_id uuid,actor_id uuid,role text,body text,created_task_id uuid,created_document_id uuid,channel text,created_at timestamptz DEFAULT now());
  CREATE TEMP TABLE project_ai_settings (project_id uuid,enabled boolean,model text,reasoning text);
  CREATE TEMP TABLE workflow_stages (project_id uuid,stage text,agent_name text,agent_instructions text);
  CREATE TEMP TABLE project_rules (project_id uuid,body text,created_at timestamptz);
  CREATE TEMP TABLE process_instructions (project_id uuid,process_id uuid,body text,created_at timestamptz);
  CREATE TEMP TABLE process_events (id uuid,project_id uuid,process_id uuid,process_kind text,level text,stage text,detail text);
  CREATE TEMP TABLE document_import_jobs (id uuid PRIMARY KEY,project_id uuid,actor_id uuid,status text,message text,source_url text,source_key text,request_text text,analyst_input jsonb,source_snapshot jsonb,source_commit text,draft_result jsonb,result jsonb,source_file_count int,total_chunks int,analyzed_chunks int,saved_documents int DEFAULT 0,updated_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX ON document_import_jobs(project_id) WHERE status='running' AND analyst_input IS NOT NULL;
  CREATE TEMP TABLE document_import_checkpoints (job_id uuid,chunk_index int,file_path text,content_sha text,notes text,created_at timestamptz DEFAULT now(),PRIMARY KEY(job_id,chunk_index));
  CREATE TEMP TABLE document_import_fragments (job_id uuid,fragment_index int,file_path text,heading text,content_sha text,notes text,topics jsonb,exclusion_reason text,PRIMARY KEY(job_id,fragment_index));
  CREATE TEMP TABLE document_import_topics (job_id uuid,topic_key text,title text,status text DEFAULT 'pending',cursor int DEFAULT 0,page_id uuid,draft_body text DEFAULT '',source_refs jsonb DEFAULT '[]'::jsonb,review_suggestion text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(job_id,topic_key));
  CREATE TEMP TABLE document_import_proposals (id uuid,project_id uuid,job_id uuid,topic_key text,document_id uuid,title text,proposed_body text,base_hash text,status text DEFAULT 'open',created_at timestamptz DEFAULT now(),decided_at timestamptz,UNIQUE(job_id,topic_key));
  CREATE TEMP TABLE documentation_questions (id uuid,project_id uuid,job_id uuid,topic_key text,question_key text,document_id uuid,question text,answer text,status text DEFAULT 'open',created_at timestamptz DEFAULT now(),answered_at timestamptz,UNIQUE(project_id,document_id,question_key));
 `.replaceAll('\\`','`'));
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 const projectId=randomUUID(),actorId=randomUUID(),rootId=randomUUID();
 await db.query("INSERT INTO projects VALUES($1,'Coffee','Предзаказ кофе')",[projectId]);
 await db.query("INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,'Техническое задание','',NULL,'spec')",[rootId,projectId]);
 for(const [key,title] of [['architecture','Архитектура и технические решения'],['operations','Запуск и эксплуатация'],['design','Дизайн и интерфейсы'],['research','Исходные материалы и исследования']]){
  await db.query('INSERT INTO documents(id,project_id,title,body,parent_id,system_key) VALUES($1,$2,$3,\'\',NULL,$4)',[randomUUID(),projectId,title,key]);
 }
 await db.query("INSERT INTO project_ai_settings VALUES($1,true,'gpt-6-luna','low')",[projectId]);
 const originalFetch=globalThis.fetch;
 let pageId=null,modelCalls=0,failOnce=false,seenTopicCalls=0;
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'http://codex.test/assistant','Imported sources must not be requested again during follow-up');
  modelCalls++;
  const {prompt}=JSON.parse(options.body);
  if(prompt.includes('Ты системный аналитик проекта и собеседник владельца продукта.')){
   assert.ok(prompt.includes('Предзаказ'),'Analyst must see current project documentation for a reasoned critique');
   return Response.json({message:'Структура пока недостаточно подробная: два сценария нужно сгруппировать по подсистемам. Предлагаю разделить функциональные требования, UX и исходные материалы.'});
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
 const send=(payload)=>app.inject({method:'POST',url:'/api/projects/'+projectId+'/assistant',payload});
 const attachments=[{name:'coffee.md',body:'# Предзаказ\nПокупатель оформляет заказ.'},{name:'barista.md',body:'# Выдача заказа\nБариста выдаёт заказ.'}];
 failOnce=true;
 const first=await send({mode:'documentation',message:'Составь ТЗ по темам',attachments});
 assert.equal(first.statusCode,202,first.body);
 const jobId=first.json().import_job_id;
 assert.deepEqual(started,[jobId]);
 assert.equal((await send({mode:'documentation',message:'Ещё запрос'})).statusCode,409);
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
 const beforeDialogue=(await db.query('SELECT count(*)::int n FROM document_import_jobs')).rows[0].n;
 const dialogue=await send({mode:'documentation',message:'Тебя устраивает структура нашего ТЗ?'});
 assert.equal(dialogue.statusCode,200,dialogue.body);
 assert.match(dialogue.json().message,/Структура пока недостаточно подробная/);
 assert.equal((await db.query('SELECT count(*)::int n FROM document_import_jobs')).rows[0].n,beforeDialogue,'Questions must never enqueue editing jobs');
 const savedConversation=(await app.inject('/api/projects/'+projectId+'/assistant/messages?mode=documentation')).json();
 assert.ok(savedConversation.some(m=>m.role==='assistant'&&m.body.includes('Структура пока недостаточно')),'Critical response is persisted');

 const reorganize=await send({mode:'documentation',message:'Улучши структуру документации: сгруппируй наши страницы по системным разделам'});
 assert.equal(reorganize.statusCode,202,reorganize.body);
 const restructuringJob=reorganize.json().import_job_id;
 await service.runDocumentationJob(restructuringJob);
 const organized=(await db.query('SELECT id,body,parent_id FROM documents WHERE import_source LIKE $1',['topic:%'])).rows;
 assert.equal(organized.length,2);
 assert.equal(organized.find(x=>x.id===pageId).id,pageId,'Document ID survives reorganization');
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE import_source LIKE 'structure:%'")).rows[0].n,1);
 assert.equal(organized[0].parent_id,organized[1].parent_id,'Related pages are grouped under the same navigation node');
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,0);
 const checkpointCalls=modelCalls;
 await service.runDocumentationJob(jobId);
 assert.equal(modelCalls,checkpointCalls,'Completed jobs must not replay');
 const questions=(await app.inject('/api/projects/'+projectId+'/documentation/questions')).json();
 assert.ok(questions.length>=1,'Product-owner clarification is created and linked to the document');
 assert.equal(questions[0].document_id,pageId);
 const answered=await app.inject({method:'POST',url:'/api/projects/'+projectId+'/documentation/questions/'+questions[0].id+'/answer',payload:{answer:'Оплата при получении'}});
 assert.equal(answered.statusCode,202,answered.body);
 await service.runDocumentationJob(answered.json().import_job_id);
 assert.equal((await db.query("SELECT status FROM documentation_questions WHERE id=$1",[questions[0].id])).rows[0].status,'resolved');
 assert.match((await db.query('SELECT body FROM documents WHERE id=$1',[pageId])).rows[0].body,/оплачивает его при получении/);
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,0,'Documentation questions never create development tasks');

 // User edits an imported page. Reimport the same named sources and preserve it.
 await db.query("UPDATE documents SET body='Ручная правка владельца',updated_at=now() WHERE id=$1",[pageId]);
 const rerun=await send({mode:'documentation',message:'Сверь исходники повторно',attachments});
 assert.equal(rerun.statusCode,202,rerun.body);
 await service.runDocumentationJob(rerun.json().import_job_id);
 assert.equal((await db.query('SELECT body FROM documents WHERE id=$1',[pageId])).rows[0].body,'Ручная правка владельца');
 const proposals=(await db.query("SELECT id,document_id,status FROM document_import_proposals WHERE document_id=$1",[pageId])).rows;
 assert.equal(proposals.length,1,'Conflicting import creates review proposal');
 assert.equal(proposals[0].status,'open');
 const reject=await app.inject({method:'POST',url:'/api/projects/'+projectId+'/documentation/proposals/'+proposals[0].id+'/decision',payload:{decision:'reject'}});
 // This standalone assistant fixture does not register the general index.ts route.
 assert.equal(reject.statusCode,404);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE import_source LIKE 'topic:%'")).rows[0].n,2,'No duplicate topics on repeated import');
});

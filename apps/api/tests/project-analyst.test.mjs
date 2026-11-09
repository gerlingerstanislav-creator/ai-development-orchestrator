import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {createAssistantService,isExplicitTaskCreation} from '../dist/assistant.js';

test('task commands are explicit even inside the documentation chat',()=>{
 assert.equal(isExplicitTaskCreation('Создай задачу, а в ней уже спроси'),true);
 assert.equal(isExplicitTaskCreation('Пожалуйста, создай новую задачу: обновить документацию'),true);
 assert.equal(isExplicitTaskCreation('Как создать задачу из документации?'),false);
 assert.equal(isExplicitTaskCreation('Создай документ, в котором есть список задач'),false);
});

test('analyst persists material analysis and applies a follow-up to the same specification page',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 t.after(()=>db.end());
 const app=Fastify();
 t.after(()=>app.close());
 await db.query(`
  CREATE TEMP TABLE projects (id uuid, name text, description text);
  CREATE TEMP TABLE tasks (id uuid,project_id uuid,title text,description text,type text,stage text,analysis_state text,clarification_questions jsonb,related_task_ids jsonb,depends_on_task_id uuid,dependency_source text,created_at timestamptz DEFAULT now());
  CREATE TEMP TABLE task_events (id uuid,task_id uuid,actor_id uuid,event text,detail text);
  CREATE TEMP TABLE project_git_repositories (project_id uuid,repository text,default_branch text,target_branch text);
  CREATE TEMP TABLE assistant_usage (id uuid,project_id uuid,actor_id uuid);
  CREATE TEMP TABLE documents (id uuid,project_id uuid,title text,body text,parent_id uuid,import_source text,document_kind text,implementation_status text,updated_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX ON documents(project_id,import_source) WHERE import_source IS NOT NULL;
  CREATE TEMP TABLE assistant_messages (id uuid,project_id uuid,task_id uuid,actor_id uuid,role text,body text,created_task_id uuid,created_document_id uuid,channel text,created_at timestamptz DEFAULT now());
  CREATE TEMP TABLE project_ai_settings (project_id uuid,enabled boolean,model text,reasoning text);
  CREATE TEMP TABLE workflow_stages (project_id uuid,stage text,agent_name text,agent_instructions text);
  CREATE TEMP TABLE project_rules (project_id uuid,body text,created_at timestamptz);
  CREATE TEMP TABLE process_instructions (project_id uuid,process_id uuid,body text,created_at timestamptz);
  CREATE TEMP TABLE process_events (id uuid,project_id uuid,process_id uuid,process_kind text,level text,stage text,detail text);
  CREATE TEMP TABLE document_import_jobs (id uuid PRIMARY KEY,project_id uuid,actor_id uuid,status text,message text,source_url text,source_key text,request_text text,analyst_input jsonb,source_snapshot jsonb,draft_result jsonb,result jsonb,source_file_count int,total_chunks int,analyzed_chunks int,saved_documents int,updated_at timestamptz);
  CREATE UNIQUE INDEX ON document_import_jobs(project_id) WHERE status='running' AND analyst_input IS NOT NULL;
  CREATE TEMP TABLE document_import_checkpoints (job_id uuid,chunk_index int,file_path text,content_sha text,notes text,created_at timestamptz DEFAULT now(),PRIMARY KEY(job_id,chunk_index));
 `);
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 const projectId=randomUUID(),actorId=randomUUID();
 await db.query("INSERT INTO projects VALUES($1,'Coffee','Предзаказ кофе')",[projectId]);
 await db.query("INSERT INTO project_ai_settings VALUES($1,true,'gpt-6-luna','low')",[projectId]);
 const originalFetch=globalThis.fetch;
 let pageId=null,modelCalls=0;
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'http://codex.test/assistant','A previous GitHub URL must not be used on follow-up');
  modelCalls++;
  const {prompt}=JSON.parse(options.body);
  let output;
  if(prompt.includes('извлеки факты'))output={notes:'Покупатель оформляет заказ. Способ оплаты не определён.'};
  else if(prompt.includes('Составь план самостоятельных страниц'))output={collection_title:'ТЗ предзаказа',documents:[{title:'Заказы',scope:'Оформление и оплата заказа',sources:['Вложение: coffee.md']}],notes:'Заказы. Каким способом оплачивается заказ?'};
  else if(prompt.includes('Напиши одну страницу ТЗ'))output={body:'Покупатель может оформить заказ. Способ оплаты требует уточнения.'};
  else if(prompt.includes('Составь одну задачу разработки'))output={title:'Добавить два круга',description:'Отобразить внешний и внутренний контуры.',questions:['Круги вокруг каждой фигуры или всей группы?']};
  else{
   assert.ok(prompt.includes('Оплата при получении'));
   assert.ok(prompt.includes(pageId));
   output={reply:'Требование по оплате уточнено.',operations:[{op:'update',id:pageId,title:'Заказы',body:'Покупатель оформляет заказ и оплачивает его при получении.'}]};
  }
  return Response.json({message:JSON.stringify(output)});
 };
 t.after(()=>{globalThis.fetch=originalFetch;});
 const service=createAssistantService({pool,codexUrl:'http://codex.test',runnerKey:'test',decryptToken:()=>''});
 const started=[];
 service.registerRoutes(app,{pool,uid:()=>actorId,access:async()=>true,requireAdmin:async()=>true,startDocumentationWorkflow:async id=>started.push(id)});
 const send=(payload)=>app.inject({method:'POST',url:'/api/projects/'+projectId+'/assistant',payload});
 const first=await send({mode:'documentation',message:'Составь ТЗ',attachments:[{name:'coffee.md',body:'Покупатель оформляет заказ.'}]});
 assert.equal(first.statusCode,202,first.body);
 const jobId=first.json().import_job_id;
 assert.deepEqual(started,[jobId]);
 assert.equal((await send({mode:'documentation',message:'Ещё запрос'})).statusCode,409);
 await service.runDocumentationJob(jobId);
 const completed=(await db.query('SELECT status,result FROM document_import_jobs WHERE id=$1',[jobId])).rows[0];
 assert.equal(completed.status,'completed');
 assert.match(completed.result.message,/Каким способом оплачивается заказ/);
 const initial=(await db.query("SELECT id,body FROM documents WHERE title='Заказы'")).rows[0];
 pageId=initial.id;
 assert.match(initial.body,/coffee\.md/);
 await service.runDocumentationJob(jobId);
 assert.equal(modelCalls,3,'Replaying a completed job must not call Codex again');
 await db.query("UPDATE assistant_messages SET body=body||' https://github.com/example/old/tree/main/docs' WHERE role='user'");
 const next=await send({mode:'documentation',message:'Оплата при получении.',documentId:pageId});
 assert.equal(next.statusCode,202,next.body);
 await service.runDocumentationJob(next.json().import_job_id);
 const updated=(await db.query('SELECT body FROM documents WHERE id=$1',[pageId])).rows[0];
 assert.match(updated.body,/оплачивает его при получении/);
 assert.equal((await db.query('SELECT count(*)::int AS total FROM documents')).rows[0].total,2);

 const taskResponse=await send({mode:'documentation',message:'Создай задачу: добавить два круга вокруг фигур.'});
 assert.equal(taskResponse.statusCode,200,taskResponse.body);
 const taskId=taskResponse.json().created_task_id;
 const task=(await db.query('SELECT stage,analysis_state,clarification_questions FROM tasks WHERE id=$1',[taskId])).rows[0];
 assert.deepEqual(task,{stage:'analysis',analysis_state:'needs_clarification',clarification_questions:['Круги вокруг каждой фигуры или всей группы?']});
 assert.equal(started.length,2,'Task creation must bypass the specification workflow');
 const dialogue=(await app.inject('/api/projects/'+projectId+'/assistant/messages?mode=documentation')).json();
 assert.equal(dialogue.at(-1).created_task_id,taskId);

});

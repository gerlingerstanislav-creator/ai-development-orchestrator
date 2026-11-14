import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {toolsForRole,createAgentReaderSession} from '../dist/agent-tools.js';
import {executeAgentTool} from '../dist/agent-tool-executor.js';
import {inspectGitHubProjectSource} from '../dist/documentation-preparation.js';

test('the delegated documentation agent can write and finish, but other specialists cannot',()=>{
 const docs=toolsForRole('documentation').map(x=>x.name);
 const pm=toolsForRole('manager').map(x=>x.name);
 for(const name of ['project.source','documents.list','documents.create','documents.update','documents.delete','documents.changeset','documentation.complete','documentation.request_input'])assert.ok(docs.includes(name),name);
 for(const name of ['tasks.delete','qa.retry','documentation.resume_spec','pm.orders.update'])assert.ok(!docs.includes(name),name);
 assert.ok(pm.includes('documentation.resume_spec'));
 assert.ok(!pm.includes('documentation.complete'));
 assert.ok(!toolsForRole('testing').some(x=>x.name==='documents.create'));
});

test('the agent chooses paths within an immutable GitHub tree',async()=>{
 const sha='a'.repeat(40),tree='b'.repeat(40),root='https://api.github.com/repos/org/site';
 const fixture=new Map([
  [root+'/commits/main',{sha,commit:{tree:{sha:tree}}}],
  [root+'/commits/'+sha,{sha,commit:{tree:{sha:tree}}}],
  [root+'/git/trees/'+tree+'?recursive=1',{tree:[{type:'blob',path:'index.php',size:50},{type:'blob',path:'.env',size:90}],truncated:false}],
  [root+'/contents/index.php?ref='+sha,{type:'file',encoding:'base64',content:Buffer.from('<?php echo 123;').toString('base64')}]
 ]);
 const http=async(url)=>new Response(JSON.stringify(fixture.get(url)||{}),{status:fixture.has(url)?200:404});
 const list=await inspectGitHubProjectSource('org/site','main','token',undefined,http);
 assert.equal(list.commit,sha);
 assert.ok(list.paths.some(f=>f.path==='index.php'));
 const file=await inspectGitHubProjectSource('org/site',sha,'token','index.php',http);
 assert.equal(file.file.content,'<?php echo 123;');
 await assert.rejects(()=>inspectGitHubProjectSource('org/site',sha,'token','.env',http),/текстового файла/);
});

test('terminal artifacts are verified, and a PM clarification resumes exactly one new continuation',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='autodocs_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();});
 await admin.query('SET search_path TO '+schema+',public');
 await admin.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid,deleted_at timestamptz)',
  'CREATE TABLE memberships(project_id uuid,user_id uuid)',
  'CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid)',
  'CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid,title text,body text)',
  'CREATE TABLE document_import_jobs(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,status text,message text,request_text text,source_key text,analyst_input jsonb,result jsonb,saved_documents int,updated_at timestamptz DEFAULT now())',
  "CREATE TABLE agent_sessions(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,token_hash text,expires_at timestamptz,read_only boolean,task_id uuid,process_id uuid,status text DEFAULT 'running')",
  'CREATE TABLE project_pm_goals(id uuid PRIMARY KEY,project_id uuid,status text)',
  'CREATE TABLE agent_work_assignments(id uuid PRIMARY KEY,project_id uuid,goal_id uuid,task_id uuid,role text,status text)',
  'CREATE TABLE agent_tool_events(id uuid PRIMARY KEY,session_id uuid,project_id uuid,tool text,arguments jsonb,result jsonb,success boolean,created_at timestamptz DEFAULT now())'
 ].join(';')+';');
 const project=randomUUID(),user=randomUUID(),job=randomUUID(),doc=randomUUID();
 await admin.query('INSERT INTO projects(id,owner_id) VALUES($1,$2)',[project,user]);
 await admin.query("INSERT INTO document_import_jobs(id,project_id,actor_id,status,request_text,analyst_input) VALUES($1,$2,$3,'running','Изучи проект',$4::jsonb)",[job,project,user,JSON.stringify({mode:'documentation',autonomous:true})]);
 await admin.query("INSERT INTO documents VALUES($1,$2,'Спецификация','Описание функций и приемочных критериев сайта')",[doc,project]);
 const session=await createAgentReaderSession(pool,{projectId:project,actorId:user,role:'documentation',processId:job});
 assert.ok(session);
 assert.equal((await pool.query('SELECT read_only FROM agent_sessions WHERE id=$1',[session.id])).rows[0].read_only,false);
 const actor={id:session.id,project_id:project,actor_id:user,role:'documentation',status:'running',process_id:job,task_id:null,expires_at:new Date(),read_only:false};
 await assert.rejects(()=>executeAgentTool(pool,actor,'documentation.complete',{document_ids:[randomUUID()],summary:'Проверил документы и считаю задачу готовой'},async()=>{}),/Не все документы/);
 const result=await executeAgentTool(pool,actor,'documentation.complete',{document_ids:[doc],summary:'Проверил существующее ТЗ и подтвердил его полноту'},async()=>{});
 assert.equal(result.status,'completed');
 assert.equal(result.saved_documents,0,'existing verified docs need no artificial edits');
 const blocked=randomUUID();
 await admin.query("INSERT INTO document_import_jobs(id,project_id,actor_id,status,request_text,analyst_input) VALUES($1,$2,$3,'running','Изучи код',$4::jsonb)",[blocked,project,user,JSON.stringify({mode:'documentation',autonomous:true})]);
 const question=await executeAgentTool(pool,{...actor,process_id:blocked},'documentation.request_input',{question:'Где найти исходный код или документы проекта?',context:'В базе недостаточно фактов'},async()=>{});
 assert.equal(question.status,'waiting_input');
 const resumed=await executeAgentTool(pool,{...actor,role:'manager'},'documentation.resume_spec',{job_id:blocked,answer:'Материалы находятся в репозитории проекта'},async()=>{});
 assert.equal(resumed.status,'queued');
 assert.equal(resumed.resumes,blocked);
 assert.equal((await pool.query('SELECT status FROM document_import_jobs WHERE id=$1',[blocked])).rows[0].status,'continued');
 assert.equal((await pool.query('SELECT status FROM document_import_jobs WHERE id=$1',[resumed.import_job_id])).rows[0].status,'queued');
 await assert.rejects(()=>executeAgentTool(pool,{...actor,role:'manager'},'documentation.resume_spec',{job_id:blocked,answer:'Повтор'},async()=>{}),/не ожидает ответа/);
});

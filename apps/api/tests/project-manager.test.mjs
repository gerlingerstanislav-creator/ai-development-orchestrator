import {executeAgentTool} from '../dist/agent-tool-executor.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {checkedWithActualCapabilities,isVisualAcceptanceCase} from '../dist/qa-evidence.js';
import {acceptAnalysisAnswer,isPrEvidenceRequest,managerRequestText,registerProjectManagerRoutes,tasksWithCustomerQuestions} from '../dist/project-manager.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('browserless QA cannot certify a visual circle layout by reading CSS',()=>{
 const planned=[{id:'circle',title:'Фигуры расположены по окружности и стрелки видны',
  steps:[{action:'Открыть страницу в браузере',expected:'Фигуры по окружности, стрелки не пересекаются'}]}];
 const reported=[{case_id:'circle',result:'passed',reason:'executed',evidence:'Read CSS and concluded that positions are correct'}];
 const result=checkedWithActualCapabilities(planned,reported,
  'chromium: unavailable\nchromium-browser: unavailable\ngoogle-chrome: unavailable\nplaywright: unavailable');
 assert.equal(isVisualAcceptanceCase(planned[0]),true);
 assert.equal(result.visualToolGap,true);
 assert.equal(result.cases[0].result,'blocked');
 assert.equal(result.cases[0].reason,'tool_unavailable');
 assert.match(result.cases[0].evidence,/не запускалась/);
});
test('real browser capability does not replace actual per-case evidence',()=>{
 const planned=[{id:'layout',title:'Responsive layout'}];
 const reported=[{case_id:'layout',result:'not_run',reason:'unknown',evidence:'No checks'}];
 const result=checkedWithActualCapabilities(planned,reported,'chromium: available\nplaywright: available');
 assert.equal(result.visualToolGap,false);
 assert.equal(result.cases[0].result,'not_run');
});
test('non-visual server checks may pass without browser',()=>{
 const planned=[{id:'api',title:'API returns 200 and schema matches'}];
 const reported=[{case_id:'api',result:'passed',reason:'executed',evidence:'curl returned 200 and API schema matched'}];
 const result=checkedWithActualCapabilities(planned,reported,'chromium: unavailable');
 assert.equal(result.visualToolGap,false);
 assert.equal(result.cases[0].result,'passed');
});
test('the manager asks for an explicit decision without asserting that skipped tests passed',()=>{
 const message=managerRequestText('qa_visual',{assessment:{passed:2,total:5,unverified:[
  {title:'Circle layout',evidence:'Chrome browser not installed'},
  {title:'Responsive arrows',evidence:'No browser screenshot tool'},
  {title:'Viewport 360',evidence:'No device emulator'}
 ]}});
 assert.match(message,/Менеджер|Тестировщик|Тестировщик/);
 assert.match(message,/не смог проверить 3 сценариев/);
 assert.match(message,/ждём появления инструментов/);
 assert.match(message,/не объявляю эти проверки успешными/);
});

test('legacy requests for PR evidence are distinct from acceptance decisions',()=>{
 assert.equal(isPrEvidenceRequest('Аналитику нужен полный diff PR по ветке задачи'),true);
 assert.equal(isPrEvidenceRequest('Предоставьте доступ к исходному коду'),true);
 assert.equal(isPrEvidenceRequest('Нужно ли оставлять стрелки между фигурами?'),false);
 assert.equal(isPrEvidenceRequest('Согласовать изменение критериев приёмки?'),false);
});

test('a durable manager turn continues idle development and respects open decisions',async t=>{
 const app=Fastify();
 t.after(()=>app.close());
 const projectId='00000000-0000-4000-8000-000000000001';
 const taskId='00000000-0000-4000-8000-000000000002';
 const messageId='00000000-0000-4000-8000-000000000003';
 const actorId='00000000-0000-4000-8000-000000000004';
 let requests=[],active=[],calls=0;
 const pool={query:async sql=>{
  if(sql.startsWith('SELECT m.actor_id'))return {rows:[{actor_id:actorId,email:'admin@example.org'}]};
  if(sql.startsWith('SELECT id,stage,spec_review_status'))return {rows:[{stage:'development'}]};
  if(sql.startsWith('SELECT id,title,description,stage'))return {rowCount:1,rows:[{stage:'development'}]};
  if(sql.startsWith('SELECT id,kind,source_id'))return {rows:requests};
  if(sql.startsWith('SELECT workflow_id,kind'))return {rows:active};
  return {rows:[]};
 }};
 registerProjectManagerRoutes(app,{pool,workerSecret:'worker-test-secret',uid:req=>req.userId,
  decideAction:async()=>{throw Error('Legacy recovery does not interpret chat');},
  workerAuthorization:async actor=>{assert.equal(actor,actorId);return 'Bearer scoped-test';},
  access:async caller=>caller.userId===actorId,requireAdmin:async caller=>caller.userId===actorId,
  startManagerWorkflow:async()=>{},recoverTask:async input=>{
   calls++;
   assert.deepEqual(input,{projectId,taskId,auth:'Bearer scoped-test',cookie:''});
   return {ok:true,status:202,message:'Разработка запущена'};
  }
 });
 const turn=secret=>app.inject({method:'POST',url:'/internal/manager/continue',
  headers:{'x-runner-secret':secret},payload:{projectId,taskId,messageId}});
 assert.equal((await turn('wrong')).statusCode,403);
 assert.deepEqual((await turn('worker-test-secret')).json(),{message:'Разработка запущена'});
 requests=[{kind:'requirements',status:'open'}];
 assert.deepEqual((await turn('worker-test-secret')).json(),{message:''});
 requests=[];active=[{kind:'development'}];
 assert.match((await turn('worker-test-secret')).json().message,/уже работает/);
 assert.equal(calls,1);
});

test('owner answers persist for analyst rerun; do not start development before reinterpretation',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='pm_answers_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await pool.query(`
 CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,stage text,analysis_state text,clarification_questions jsonb,updated_at timestamptz);
 CREATE TABLE task_agent_notes(id uuid PRIMARY KEY,project_id uuid,task_id uuid,author_stage text,author_name text,target_stage text,
  kind text,body text,source_kind text,source_key text,actor_id uuid,status text,requires_customer boolean,
  answer text,answered_at timestamptz,answered_by uuid,answer_author text,processing_at timestamptz,
  UNIQUE(task_id,source_key));
 CREATE TABLE manager_requests(id uuid PRIMARY KEY,project_id uuid,task_id uuid,status text,decision text,decided_by uuid,
  resolved_at timestamptz,kind text,source_id uuid);
 CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid,actor_id uuid,event text,detail text);
 `);
 const projectId=randomUUID(),taskId=randomUUID(),actorId=randomUUID();
 const notes=[{id:randomUUID(),text:'Где должны быть расположены круги?'},{id:randomUUID(),text:'Как меняется размер при изменении окна?'}];
 await pool.query("INSERT INTO tasks(id,project_id,stage,analysis_state,clarification_questions) VALUES($1,$2,'analysis','waiting_questions','[]'::jsonb)",[taskId,projectId]);
 for(const [i,n] of notes.entries()){
  await pool.query("INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,actor_id,status,requires_customer,source_key) VALUES($1,$2,$3,'analysis','Системный аналитик','all','question',$4,'agent',$5,'open',true,$6)",
   [n.id,projectId,taskId,n.text,actorId,'question:'+i]);
 }
 await pool.query("INSERT INTO manager_requests(id,project_id,task_id,status,kind,source_id) VALUES($1,$2,$3,'open','question',$4)",[randomUUID(),projectId,taskId,notes[0].id]);
 const answer='Круги расположены один внутри другого. При изменении размеров окна они пропорционально уменьшаются и увеличиваются.';
 const result=await acceptAnalysisAnswer(pool,projectId,taskId,actorId,answer);
 assert.equal(result.accepted,true);
 assert.equal(result.answered,2);
 const task=(await pool.query('SELECT stage,analysis_state,clarification_questions FROM tasks WHERE id=$1',[taskId])).rows[0];
 assert.equal(task.stage,'analysis','Receiving an answer must not start development');
 assert.equal(task.analysis_state,'new','Analyst has to reinterpret the newly received answer');
 assert.deepEqual(task.clarification_questions,[]);
 const saved=(await pool.query("SELECT status,answer,answered_by,answered_at FROM task_agent_notes WHERE task_id=$1 ORDER BY source_key",[taskId])).rows;
 assert.equal(saved.length,2);
 for(const note of saved){
  assert.equal(note.status,'answered');
  assert.equal(note.answer,answer);
  assert.equal(note.answered_by,actorId);
  assert.ok(note.answered_at);
 }
 assert.equal((await pool.query("SELECT count(*)::int total FROM manager_requests WHERE status='open'")).rows[0].total,0);
 assert.equal((await pool.query("SELECT count(*)::int total FROM task_events WHERE event='agent_question_answered'")).rows[0].total,1);
 assert.equal((await acceptAnalysisAnswer(pool,projectId,taskId,actorId,answer)).accepted,false,'Repeated answer is idempotent');
});

test('legacy analysis card without question IDs accepts an authenticated historic owner answer once',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='legacy_answer_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await pool.query(`
 CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,stage text,analysis_state text,clarification_questions jsonb,updated_at timestamptz);
 CREATE TABLE task_agent_notes(id uuid PRIMARY KEY,project_id uuid,task_id uuid,author_stage text,author_name text,target_stage text,
  kind text,body text,source_kind text,source_key text,actor_id uuid,status text,requires_customer boolean,
  answer text,answered_at timestamptz,answered_by uuid,answer_author text,processing_at timestamptz,
  created_at timestamptz DEFAULT now(),UNIQUE(task_id,source_key));
 CREATE TABLE manager_requests(id uuid PRIMARY KEY,project_id uuid,task_id uuid,status text,decision text,decided_by uuid,
  resolved_at timestamptz,kind text,source_id uuid);
 CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid,actor_id uuid,event text,detail text);
 `);
 const project=randomUUID(),task=randomUUID(),actor=randomUUID(),sourceMessage=randomUUID();
 await pool.query("INSERT INTO tasks(id,project_id,stage,analysis_state,clarification_questions) VALUES($1,$2,'analysis','waiting_questions','[]'::jsonb)",[task,project]);
 const answer='Круги находятся друг внутри друга, а при изменении окна все круги пропорционально масштабируются.';
 const result=await acceptAnalysisAnswer(pool,project,task,actor,answer,sourceMessage);
 assert.equal(result.accepted,true);
 assert.equal(result.answered,0,'Legacy state has no saved question IDs');
 assert.equal((await pool.query('SELECT analysis_state FROM tasks WHERE id=$1',[task])).rows[0].analysis_state,'new');
 const rows=(await pool.query("SELECT body,kind,target_stage,source_key FROM task_agent_notes WHERE task_id=$1",[task])).rows;
 assert.equal(rows.length,1);
 assert.equal(rows[0].body,answer);
 assert.equal(rows[0].kind,'resolution');
 assert.equal(rows[0].target_stage,'analysis');
 assert.equal(rows[0].source_key,'owner-answer:'+sourceMessage);
 assert.equal((await acceptAnalysisAnswer(pool,project,task,actor,answer,sourceMessage)).accepted,false,'Delivery must be idempotent');
 await pool.query("INSERT INTO tasks(id,project_id,stage,analysis_state,clarification_questions) VALUES($1,$2,'analysis','new','[]'::jsonb)",[randomUUID(),project]);
 const unrelated=(await pool.query("SELECT id FROM tasks WHERE id<>$1",[task])).rows[0].id;
 assert.equal((await acceptAnalysisAnswer(pool,project,unrelated,actor,answer,randomUUID())).accepted,false,
  'Do not turn random PM instructions into analyst answers when nobody asked a question');
});

test('owner questions project onto the board without changing task stages',async()=>{
 const defaults={open_notes:[],material_review:false,blocked_qa:null};
 const rows=[
  {...defaults,id:'new',stage:'analysis',clarification_questions:['Какого цвета должен быть круг?']},
  {...defaults,id:'internal',stage:'development',open_notes:['Аналитику нужен полный diff PR по ветке задачи']},
  {...defaults,id:'later',stage:'testing',open_notes:['Нужно ли оставлять стрелки?']},
  {...defaults,id:'resolved',stage:'analysis',clarification_questions:[]},
  {...defaults,id:'review',stage:'merge_queue',spec_review_status:'needs_approval',material_review:true},
  {...defaults,id:'documentation-question',type:'question',stage:'backlog',question_status:'open',document_id:'doc-1'},
  {...defaults,id:'answered-documentation-question',type:'question',stage:'backlog',question_status:'answered',document_id:'doc-1'},
  {...defaults,id:'finished-question',type:'question',stage:'done',question_status:'resolved',document_id:'doc-1'}
 ];
 const db={query:async(_sql,params)=>{
  assert.deepEqual(params,['project']);
  return {rows};
 }};
 const tasks=await tasksWithCustomerQuestions(db,'project');
 assert.deepEqual(tasks.map(task=>[task.id,task.stage,task.awaits_product_owner]),[
  ['new','analysis',true],['internal','development',false],['later','testing',true],
  ['resolved','analysis',false],['review','merge_queue',true],
  ['documentation-question','backlog',true],['answered-documentation-question','backlog',true],['finished-question','done',false]
 ]);
 const result=await executeAgentTool(db,{project_id:'project',role:'manager'},'tasks.list',
  {product_owner_questions_only:true});
 assert.deepEqual(result.tasks.map(task=>[task.id,task.stage]),[
  ['new','analysis'],['later','testing'],['review','merge_queue'],
  ['documentation-question','backlog'],['answered-documentation-question','backlog']
 ]);
});

test('a pending manager reply can be interrupted without cancelling the task workflow',async t=>{
 const app=Fastify();
 t.after(()=>app.close());
 const projectId='00000000-0000-4000-8000-000000000001';
 const taskId='00000000-0000-4000-8000-000000000002';
 const messageId='00000000-0000-4000-8000-000000000003';
 const actorId='00000000-0000-4000-8000-000000000004';
 let status='processing',cancelled=0;
 const pool={query:async(sql,params)=>{
  if(sql.startsWith("UPDATE manager_messages SET status='cancelled'")){
   if(status!=='processing')return {rowCount:0,rows:[]};
   assert.deepEqual(params,[messageId,projectId,taskId,actorId]);
   status='cancelled';
   return {rowCount:1,rows:[{id:messageId}]};
  }
  return {rows:[],rowCount:0};
 }};
 registerProjectManagerRoutes(app,{pool,workerSecret:'worker-test-secret',uid:()=>actorId,
  access:async()=>true,requireAdmin:async()=>true,workerAuthorization:async()=>'',decideAction:async()=>({action:'reply'}),
  startManagerWorkflow:async()=>{},stopManagerWorkflow:async id=>{assert.equal(id,messageId);cancelled++;},
  recoverTask:async()=>{throw Error('Stopping a PM reply must not resume or cancel task execution');}
 });
 const url='/api/projects/'+projectId+'/tasks/'+taskId+'/manager/messages/'+messageId+'/stop';
 const first=await app.inject({method:'POST',url,payload:{}});
 assert.equal(first.statusCode,200,first.body);
 assert.equal(first.json().status,'cancelled');
 assert.equal(cancelled,1);
 const duplicate=await app.inject({method:'POST',url,payload:{}});
 assert.equal(duplicate.statusCode,409,duplicate.body);
 assert.equal(cancelled,1);
});

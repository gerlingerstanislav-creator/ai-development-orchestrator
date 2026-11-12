import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {registerProjectManagerInbox,checkProjectManagerWatch,initProjectManagerInbox,deliverProjectManagerInbox,pmInboxWorkflowId,failProjectManagerInbox,publishOwnerQuestionsToPmChat,ensureProjectManagerActionOrder,shouldCreateProjectManagerOrder} from '../dist/project-manager-inbox.js';
import {executeAgentTool} from '../dist/agent-tool-executor.js';
import {toolsForRole} from '../dist/agent-tools.js';

test('project manager inbox acknowledges durable turns, deduplicates submissions and recovers dispatch', {timeout:15000},async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pminbox_'+randomUUID().replaceAll('-','');
 const app=Fastify();
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await app.close();await pool.end();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid,deleted_at timestamptz)',
  'CREATE TABLE users(id uuid PRIMARY KEY)',
  "CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,title text,display_number int,stage text DEFAULT 'analysis',type text DEFAULT 'task',analysis_state text DEFAULT 'new',spec_version int DEFAULT 1,clarification_questions jsonb DEFAULT '[]',updated_at timestamptz DEFAULT now())",
  "CREATE TABLE task_agent_notes(id uuid PRIMARY KEY,project_id uuid,task_id uuid,author_stage text,author_name text,target_stage text,kind text,body text,source_kind text,source_key text,status text,requires_customer boolean,created_at timestamptz DEFAULT now(),UNIQUE(task_id,source_key))",
  "CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,task_id uuid,role text,body text,channel text DEFAULT 'project',status text DEFAULT 'completed',reply_to uuid,topic_id uuid,pm_order_id uuid,created_task_id uuid,created_at timestamptz DEFAULT now())",
  "CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,source_message_id uuid,topic_id uuid,status text DEFAULT 'queued',summary text,updated_at timestamptz DEFAULT now())",
  "CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid,created_at timestamptz DEFAULT now())",
  "CREATE TABLE project_chat_topics(id uuid PRIMARY KEY,project_id uuid,title text,status text DEFAULT 'open')",
  'CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id))',
  'CREATE TABLE project_iterations(id uuid PRIMARY KEY,project_id uuid,title text)',
  'CREATE TABLE iteration_planning_runs(id uuid PRIMARY KEY,iteration_id uuid,status text,message text,plan_id uuid,created_at timestamptz DEFAULT now())'
 ].join(';')+';');
 const project=randomUUID(),user=randomUUID(),topic=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[project]);
 await db.query('INSERT INTO users(id) VALUES($1)',[user]);
 await db.query("INSERT INTO project_chat_topics(id,project_id,title) VALUES($1,$2,'Согласование итерации')",[topic,project]);
 await initProjectManagerInbox(pool);
 await initProjectManagerInbox(pool);
 const deliveries=[];
 let held=null;
 const start=async turn=>{
  deliveries.push(pmInboxWorkflowId(turn));
  if(held)await held;
 };
 registerProjectManagerInbox(app,{pool,uid:()=>user,access:async()=>true,requireAdmin:async()=>true,start});
 const url='/api/projects/'+project+'/manager/inbox';
 const send=(payload,path=url)=>app.inject({method:'POST',url:path,payload});
 const until=async condition=>{
  for(let attempt=0;attempt<120;attempt++){
   if(await condition())return;
   await delay(20);
  }
  assert.fail('Timed out waiting for PM delivery');
 };
 const read=async id=>(await db.query('SELECT * FROM assistant_messages WHERE id=$1',[id])).rows[0];

 const key=randomUUID();
 const [first,duplicate]=await Promise.all([send({message:'Уточни задачу',requestId:key}),send({message:'Уточни задачу',requestId:key})]);
 assert.equal(first.statusCode,202,first.body);
 assert.deepEqual(duplicate.json(),first.json());
 const firstId=first.json().id;
 await until(async()=>!!(await read(firstId)).pm_dispatched_at);
 assert.equal(deliveries.filter(id=>id==='project-pm-'+firstId).length,1);
 assert.equal((await send({message:'Другой текст',requestId:key})).statusCode,409);
 assert.equal(first.json().order_id,null,'plain chat is not an order');
 assert.equal((await db.query('SELECT count(*)::int AS count FROM project_pm_orders')).rows[0].count,0);

 // Simulate an existing owner question emitted by the PM after an earlier action.
 const waitingOrder=randomUUID();
 await db.query("INSERT INTO project_pm_orders(id,project_id,actor_id,source_message_id,status,summary) VALUES($1,$2,$3,$4,'waiting_user','Вопрос ПМ')",[waitingOrder,project,user,firstId]);
 await db.query('UPDATE assistant_messages SET pm_order_id=$2 WHERE id=$1',[firstId,waitingOrder]);
 const answerKey=randomUUID();
 const answer={message:'Выбираю 5 минут',replyTo:firstId,topicId:topic,requestId:answerKey};
 const ownerAnswer=await send(answer);
 assert.equal(ownerAnswer.statusCode,202,ownerAnswer.body);
 const replyId=ownerAnswer.json().id;
 await until(async()=>!!(await read(replyId)).pm_dispatched_at);
 const reply=await read(replyId);
 assert.equal(reply.reply_to,firstId);
 assert.equal(reply.topic_id,topic);
 assert.equal(reply.pm_order_id,waitingOrder);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM project_pm_orders')).rows[0].count,1,'answer reuses the waiting order');
 await db.query("UPDATE project_chat_topics SET status='closed' WHERE id=$1",[topic]);
 assert.deepEqual((await send(answer)).json(),ownerAnswer.json(),'lost receipt can be recovered after the topic closes');
 assert.equal((await send({message:'Ответ',replyTo:randomUUID()})).statusCode,400);

 let rejectDelivery;
 held=new Promise((_resolve,reject)=>{rejectDelivery=reject;});
 const outage=await send({message:'Сохрани при недоступном Temporal',requestId:randomUUID()});
 assert.equal(outage.statusCode,202,outage.body);
 const id=outage.json().id;
 await until(()=>deliveries.includes('project-pm-'+id));
 assert.equal((await read(id)).status,'queued');
 assert.equal((await read(id)).pm_dispatched_at,null);
 rejectDelivery(Error('Temporal unavailable'));
 held=null;
 await until(async()=>new Date((await read(id)).pm_next_dispatch_at).getTime()>Date.now());
 assert.equal((await read(id)).status,'queued');
 await db.query('UPDATE assistant_messages SET pm_next_dispatch_at=now() WHERE id=$1',[id]);
 // A restart or lost RPC acknowledgement can encounter a workflow that already exists.
 await deliverProjectManagerInbox(pool,async turn=>{
  deliveries.push(pmInboxWorkflowId(turn));
  throw Object.assign(Error('already started'),{name:'WorkflowExecutionAlreadyStartedError'});
 },()=>assert.fail('Duplicate workflow ID is a successful delivery'));
 assert.ok((await read(id)).pm_dispatched_at);
 assert.deepEqual(deliveries.filter(value=>value==='project-pm-'+id),['project-pm-'+id,'project-pm-'+id]);
 await deliverProjectManagerInbox(pool,()=>assert.fail('Acknowledged turns are not redelivered'),()=>{});

 await failProjectManagerInbox(pool,project,id,1);
 assert.equal((await read(id)).status,'failed');
 const retried=await send(undefined,url+'/'+id+'/retry');
 assert.equal(retried.statusCode,202,retried.body);
 await until(async()=>!!(await read(id)).pm_dispatched_at);
 assert.equal(deliveries.at(-1),'project-pm-'+id+'-retry-2');
 await failProjectManagerInbox(pool,project,id,1);
 assert.equal((await read(id)).status,'queued','older workflow cannot fail the new attempt');
 const taskId=randomUUID();
 await db.query('UPDATE projects SET owner_id=$2 WHERE id=$1',[project,user]);
 await db.query("INSERT INTO tasks(id,project_id,title,display_number,clarification_questions) VALUES($1,$2,'Расписание',11,$3::jsonb)",
  [taskId,project,JSON.stringify(['Какой часовой пояс выбрать?'])]);
 await db.query("INSERT INTO task_agent_notes(id,project_id,task_id,kind,body,source_key,status,requires_customer) VALUES($1,$2,$3,'question','Внутренний вопрос','internal','open',false)",[randomUUID(),project,taskId]);
 await Promise.all([publishOwnerQuestionsToPmChat(pool),publishOwnerQuestionsToPmChat(pool)]);
 await publishOwnerQuestionsToPmChat(pool);
 const questions=(await db.query("SELECT body FROM assistant_messages WHERE created_task_id=$1",[taskId])).rows;
 assert.equal(questions.length,0,'analyst and internal questions stay in the task');
 const notes=(await db.query("SELECT body,author_stage FROM task_agent_notes WHERE task_id=$1 AND requires_customer",[taskId])).rows;
 assert.deepEqual(notes,[{body:'Какой часовой пояс выбрать?',author_stage:'analysis'}]);
 const task=(await db.query('SELECT analysis_state,clarification_questions FROM tasks WHERE id=$1',[taskId])).rows[0];
 assert.deepEqual(task,{analysis_state:'waiting_questions',clarification_questions:[]});
 const session={project_id:project,actor_id:user,role:'manager'};
 const open=(args)=>executeAgentTool(pool,session,'discussions.open',args,async()=>{});
 await assert.rejects(open({title:'Пустая тема'}),/opening_message/);
 const firstTopic=await open({title:'Проверка решения',opening_message:'Как подтвердить этот вариант?'});
 const sameTopic=await open({title:'Проверка решения',opening_message:'Повтор'});
 assert.equal(firstTopic.topic.id,sameTopic.topic.id);
 assert.deepEqual((await db.query("SELECT body FROM assistant_messages WHERE topic_id=$1",[firstTopic.topic.id])).rows,
  [{body:'Как подтвердить этот вариант?'}]);
});

test('PM reports completed delegated iteration only once and never reports a requeued draft as ready',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pmwatch_'+randomUUID().replaceAll('-','');
 t.after(async()=>{await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  "CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,role text,body text,channel text,status text,topic_id uuid,pm_order_id uuid,actor_id uuid)",
  "CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,source_message_id uuid,topic_id uuid,status text DEFAULT 'queued',summary text,updated_at timestamptz DEFAULT now())",
  "CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid,created_at timestamptz DEFAULT now())",
  'CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id))',
  'CREATE TABLE project_iterations(id uuid PRIMARY KEY,project_id uuid,title text)',
  'CREATE TABLE iteration_planning_runs(id uuid PRIMARY KEY,iteration_id uuid,status text,message text,plan_id uuid,created_at timestamptz DEFAULT now())'
 ].join(';')+';');
 const project=randomUUID(),iteration=randomUUID(),run=randomUUID(),next=randomUUID(),plan=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[project]);
 await db.query("INSERT INTO project_iterations(id,project_id,title) VALUES($1,$2,'MVP')",[iteration,project]);
 await db.query("INSERT INTO iteration_planning_runs(id,iteration_id,status,message) VALUES($1,$2,'completed','Поступили новые ответы владельца; подготовка перезапущена')",[run,iteration]);
 await db.query("INSERT INTO iteration_planning_runs(id,iteration_id,status,message,created_at) VALUES($1,$2,'running','Аналитик работает',now()+interval '1 second')",[next,iteration]);
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 const watch={projectId:project,processId:run,kind:'iteration_plan'};
 assert.equal(await checkProjectManagerWatch(pool,watch),'pending');
 await db.query("UPDATE iteration_planning_runs SET status='completed',plan_id=$2,message='Готово' WHERE id=$1",[next,plan]);
 assert.equal(await checkProjectManagerWatch(pool,watch),'completed');
 assert.equal(await checkProjectManagerWatch(pool,watch),'completed');
 const messages=(await db.query('SELECT body FROM assistant_messages')).rows;
 assert.equal(messages.length,1);
 assert.match(messages[0].body,/План разработки/);
 const orderId=randomUUID(),actorId=randomUUID(),secondRun=randomUUID(),secondPlan=randomUUID();
 await db.query("INSERT INTO project_pm_orders(id,project_id,actor_id,summary) VALUES($1,$2,$3,'Подготовить итерацию')",[orderId,project,actorId]);
 await db.query("INSERT INTO iteration_planning_runs(id,iteration_id,status,message,plan_id) VALUES($1,$2,'completed','Второй план готов',$3)",[secondRun,iteration,secondPlan]);
 const resumeWatch={projectId:project,processId:secondRun,kind:'iteration_plan',orderId,actorId};
 assert.equal(await checkProjectManagerWatch(pool,resumeWatch),'completed');
 assert.equal(await checkProjectManagerWatch(pool,resumeWatch),'completed');
 const resumed=(await db.query("SELECT id FROM assistant_messages WHERE channel='pm-internal' AND pm_order_id=$1",[orderId])).rows;
 assert.equal(resumed.length,1,'system follow-up queued once for the same order');
 const checkpoint=(await db.query("SELECT detail FROM project_pm_order_events WHERE order_id=$1 AND kind='resume'",[orderId])).rows;
 assert.equal(checkpoint.length,1);
 assert.equal(checkpoint[0].detail,resumed[0].id);
});

test('QA retry is available to PM only and delegates to the protected testing endpoint',()=>{
 assert.ok(toolsForRole('manager').some(tool=>tool.name==='qa.retry'));
 assert.ok(!toolsForRole('analyst').some(tool=>tool.name==='qa.retry'));
 assert.ok(!toolsForRole('business_analyst').some(tool=>tool.name==='qa.retry'));
});

test('PM observes QA retry cycle once and resumes after an infrastructure failure',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pmqa_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query(`
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,title text,stage text);
  CREATE TABLE task_orchestration_owners(task_id uuid,project_id uuid,owner_id uuid,kind text,state text);
  CREATE TABLE ai_test_runs(id uuid PRIMARY KEY,project_id uuid,task_id uuid,cycle_id uuid,status text,message text,verdict text,report jsonb,created_at timestamptz DEFAULT now());
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,body text,channel text,status text,topic_id uuid,pm_order_id uuid);
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid,created_at timestamptz DEFAULT now());
  CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id));
 `);
 const project=randomUUID(),actor=randomUUID(),task=randomUUID(),cycle=randomUUID(),order=randomUUID(),run=randomUUID();
 await db.query("INSERT INTO tasks VALUES($1,$2,'Расписание','testing')",[task,project]);
 await db.query("INSERT INTO task_orchestration_owners VALUES($1,$2,$3,'testing','active')",[task,project,cycle]);
 await db.query("INSERT INTO project_pm_orders VALUES($1,'waiting_agents',now())",[order]);
 const watch={projectId:project,processId:cycle,kind:'testing',orderId:order,actorId:actor};
 assert.equal(await checkProjectManagerWatch(pool,watch),'pending');
 await db.query("INSERT INTO ai_test_runs(id,project_id,task_id,cycle_id,status,message) VALUES($1,$2,$3,$4,'failed','Codex завершился с кодом 1')",[run,project,task,cycle]);
 await db.query("UPDATE task_orchestration_owners SET state='finished' WHERE owner_id=$1",[cycle]);
 assert.equal(await checkProjectManagerWatch(pool,watch),'completed');
 assert.equal(await checkProjectManagerWatch(pool,watch),'completed');
 const messages=(await db.query('SELECT role,body,channel FROM assistant_messages ORDER BY role')).rows;
 assert.equal(messages.length,2,'one visible report and one internal PM followup');
 assert.equal(messages.filter(m=>m.role==='assistant'&&m.channel==='project').length,1);
 assert.match(messages.find(m=>m.role==='assistant').body,/Codex завершился с кодом 1/);
 assert.equal(messages.filter(m=>m.channel==='pm-internal').length,1);
 assert.equal((await db.query("SELECT status FROM project_pm_orders WHERE id=$1",[order])).rows[0].status,'queued');
 const rows=(await db.query("SELECT * FROM project_pm_order_events WHERE kind='resume'")).rows;
 assert.equal(rows.length,1,'one durable PM wakeup for each QA cycle');
});


test('PM tracks real tool actions without creating orders for chat reads',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pmaction_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query(`
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,pm_order_id uuid);
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,source_message_id uuid,topic_id uuid,status text,summary text);
  CREATE TABLE project_pm_decisions(id uuid PRIMARY KEY,project_id uuid,source_message_id uuid,order_id uuid);
  CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text);
 `);
 const projectId=randomUUID(),actorId=randomUUID(),messageId=randomUUID();
 await db.query('INSERT INTO assistant_messages(id,project_id) VALUES($1,$2)',[messageId,projectId]);
 const base={projectId,messageId,actorId,topicId:null,summary:'Проверь статус',events:[]};
 assert.equal(await ensureProjectManagerActionOrder(pool,base),null);
 assert.equal(await ensureProjectManagerActionOrder(pool,{...base,events:[
  {tool:'tasks.read',result:{id:randomUUID()}},
  {tool:'pm.orders.list',result:{orders:[]}},
  {tool:'processes.report',result:{ok:true}},
  {tool:'memory.record',result:{ok:true}}
 ]}),null);
 assert.equal(shouldCreateProjectManagerOrder([{tool:'pm.decisions.record',result:{recorded:false}}]),false);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM project_pm_orders')).rows[0].n,0);
 const decision=randomUUID();
 await db.query('INSERT INTO project_pm_decisions(id,project_id,source_message_id) VALUES($1,$2,$3)',[decision,projectId,messageId]);
 const action={...base,summary:'Создай задачу',events:[{tool:'tasks.create',result:{id:randomUUID()}}]};
 const orderId=await ensureProjectManagerActionOrder(pool,action);
 assert.ok(orderId);
 assert.equal(await ensureProjectManagerActionOrder(pool,action),orderId,'retries reuse the order');
 assert.deepEqual((await db.query('SELECT status,summary,source_message_id FROM project_pm_orders')).rows,
  [{status:'working',summary:'Создай задачу',source_message_id:messageId}]);
 assert.equal((await db.query('SELECT pm_order_id FROM assistant_messages WHERE id=$1',[messageId])).rows[0].pm_order_id,orderId);
 assert.equal((await db.query('SELECT order_id FROM project_pm_decisions WHERE id=$1',[decision])).rows[0].order_id,orderId,'decision is linked to the eventual order');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM project_pm_order_events')).rows[0].n,1);
 const second=randomUUID();
 await db.query('INSERT INTO assistant_messages(id,project_id) VALUES($1,$2)',[second,projectId]);
 assert.ok(await ensureProjectManagerActionOrder(pool,{...base,messageId:second,events:[],delegated:true}),
  'delegated work is visible as an order');
});

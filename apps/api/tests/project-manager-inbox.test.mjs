import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {registerProjectManagerInbox,checkProjectManagerWatch,initProjectManagerInbox,deliverProjectManagerInbox,pmInboxWorkflowId,failProjectManagerInbox,publishOwnerQuestionsToPmChat} from '../dist/project-manager-inbox.js';

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
 assert.equal((await db.query('SELECT count(*)::int AS count FROM project_pm_orders')).rows[0].count,1);

 const waitingOrder=first.json().order_id;
 await db.query("UPDATE project_pm_orders SET status='waiting_user' WHERE id=$1",[waitingOrder]);
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
 const questions=(await db.query("SELECT id,body,pm_order_id FROM assistant_messages WHERE created_task_id=$1",[taskId])).rows;
 assert.equal(questions.length,1,'explicit owner question is published once, internal question stays private');
 assert.match(questions[0].body,/#11.*Расписание/s);
 assert.match(questions[0].body,/Какой часовой пояс выбрать/);
 const linked=(await db.query("SELECT n.body,o.actor_id,o.status FROM project_pm_order_events e JOIN task_agent_notes n ON n.id=e.process_id JOIN project_pm_orders o ON o.id=e.order_id WHERE e.order_id=$1",[questions[0].pm_order_id])).rows[0];
 assert.deepEqual(linked,{body:'Какой часовой пояс выбрать?',actor_id:user,status:'waiting_user'});
 const task=(await db.query('SELECT analysis_state,clarification_questions FROM tasks WHERE id=$1',[taskId])).rows[0];
 assert.deepEqual(task,{analysis_state:'waiting_questions',clarification_questions:[]});
 const response=await send({message:'По часовому поясу пользователя',replyTo:questions[0].id});
 assert.equal(response.statusCode,202,response.body);
 assert.equal(response.json().order_id,questions[0].pm_order_id,'reply resumes the exact question order');
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

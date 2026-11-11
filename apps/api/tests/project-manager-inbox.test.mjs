import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {registerProjectManagerInbox,checkProjectManagerWatch} from '../dist/project-manager-inbox.js';

test('project manager inbox persists independent turns and safely retries failed dispatches',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pminbox_'+randomUUID().replaceAll('-','');
 const app=Fastify();
 t.after(async()=>{await app.close();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  'CREATE TABLE users(id uuid PRIMARY KEY)',
  "CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,task_id uuid,role text,body text,channel text DEFAULT 'project',status text DEFAULT 'completed',reply_to uuid,topic_id uuid,pm_order_id uuid,created_at timestamptz DEFAULT now())",
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
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 const started=[];
 let fail=false;
 registerProjectManagerInbox(app,{pool,uid:()=>user,access:async()=>true,requireAdmin:async()=>true,start:async(_,messageId)=>{
  if(fail)throw Error('Temporal unavailable');
  started.push(messageId);
 }});
 const url='/api/projects/'+project+'/manager/inbox';
 const first=await app.inject({method:'POST',url,payload:{message:'Уточни задачу'}}); 
 assert.equal(first.statusCode,202,first.body);
 const firstId=first.json().id;
 const reply=await app.inject({method:'POST',url,payload:{message:'Согласую этот этап',replyTo:firstId,topicId:topic}});
 assert.equal(reply.statusCode,202,reply.body);
 const messages=(await db.query("SELECT id,reply_to,topic_id,status FROM assistant_messages ORDER BY created_at,id")).rows;
 assert.equal(messages.length,2);
 assert.equal(messages.find(x=>x.id===reply.json().id).reply_to,firstId);
 assert.equal(messages.find(x=>x.id===reply.json().id).topic_id,topic);
 assert.equal(started.length,2);
 const waitingOrder=(await db.query('SELECT pm_order_id FROM assistant_messages WHERE id=$1',[firstId])).rows[0].pm_order_id;
 await db.query("UPDATE project_pm_orders SET status='waiting_user' WHERE id=$1",[waitingOrder]);
 const ownerAnswer=await app.inject({method:'POST',url,payload:{message:'Выбираю 5 минут с настройкой в боте',replyTo:firstId}});
 assert.equal(ownerAnswer.statusCode,202,ownerAnswer.body);
 assert.equal((await db.query('SELECT pm_order_id FROM assistant_messages WHERE id=$1',[ownerAnswer.json().id])).rows[0].pm_order_id,waitingOrder,'reply continues the waiting order');
 assert.equal(started.length,3);
 const invalid=await app.inject({method:'POST',url,payload:{message:'Ответ',replyTo:randomUUID()}});
 assert.equal(invalid.statusCode,400);
 fail=true;
 const failed=await app.inject({method:'POST',url,payload:{message:'Не потеряй эту задачу'}});
 assert.equal(failed.statusCode,202);
 const id=failed.json().id;
 assert.equal((await db.query('SELECT status FROM assistant_messages WHERE id=$1',[id])).rows[0].status,'queued',
  'Temporal outage preserves the queued message for durable recovery');
 fail=false;
 const pendingRetry=await app.inject({method:'POST',url:url+'/'+id+'/retry'});
 assert.equal(pendingRetry.statusCode,409,'queued messages are recovered automatically instead of manually retried');
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

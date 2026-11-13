import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {reportPmWatchCompletion} from '../dist/modules/planning/application/pm-watch-report.js';

test('PM watch reports and Temporal retries share one transactional, durable resume',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pmreport_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{
  await pool.end();
  await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
  await db.end();
 });
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query(`
  CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id));
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,body text,channel text,status text,topic_id uuid,pm_order_id uuid);
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid,created_at timestamptz DEFAULT now());
 `);
 const project=randomUUID(),process=randomUUID(),order=randomUUID(),actor=randomUUID(),topic=randomUUID();
 await db.query("INSERT INTO project_pm_orders(id,status) VALUES($1,'waiting_agents')",[order]);
 const watch={projectId:project,processId:process,orderId:order,actorId:actor,topicId:topic,kind:'testing'};
 const text='Повторный QA завершился с ошибкой, исправления требуются';
 const payload={message:text,resumeInstruction:' Проверь дефекты и продолжи прежнее поручение.'};
 const statuses=await Promise.all(Array.from({length:8},()=>reportPmWatchCompletion(pool,watch,payload)));
 assert.deepEqual(statuses,Array(8).fill('completed'));
 const reports=(await db.query('SELECT project_id,process_id,kind FROM project_pm_process_reports')).rows;
 assert.equal(reports.length,1);
 assert.deepEqual(reports[0],{project_id:project,process_id:process,kind:'testing'});
 const messages=(await db.query('SELECT id,actor_id,role,body,channel,status,topic_id,pm_order_id FROM assistant_messages ORDER BY role')).rows;
 assert.equal(messages.length,2,'one owner report and one PM resume');
 const owner=messages.find(m=>m.role==='assistant');
 const resumed=messages.find(m=>m.role==='user');
 assert.equal(owner.body,text);
 assert.equal(owner.channel,'project');
 assert.equal(owner.topic_id,topic);
 assert.equal(owner.pm_order_id,order);
 assert.equal(resumed.body,'СИСТЕМНОЕ СОБЫТИЕ: '+text+payload.resumeInstruction);
 assert.equal(resumed.channel,'pm-internal');
 assert.equal(resumed.status,'queued');
 assert.equal(resumed.actor_id,actor);
 assert.equal((await db.query('SELECT status FROM project_pm_orders WHERE id=$1',[order])).rows[0].status,'queued');
 const events=(await db.query("SELECT kind,detail,process_id FROM project_pm_order_events WHERE order_id=$1",[order])).rows;
 assert.deepEqual(events,[{kind:'resume',detail:resumed.id,process_id:process}]);
 assert.equal(await reportPmWatchCompletion(pool,watch,payload),'completed');
 assert.equal((await db.query('SELECT count(*)::int AS count FROM assistant_messages')).rows[0].count,2);
});

test('visible PM reports preserve 3500-character bound without truncating internal context',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pmreport_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query(`
  CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id));
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,body text,channel text,status text,topic_id uuid,pm_order_id uuid);
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid,created_at timestamptz DEFAULT now());
 `);
 const project=randomUUID(),process=randomUUID(),order=randomUUID(),actor=randomUUID();
 await db.query("INSERT INTO project_pm_orders(id,status) VALUES($1,'waiting_agents')",[order]);
 const message='X'.repeat(3700);
 const watch={projectId:project,processId:process,kind:'document_import',orderId:order,actorId:actor};
 assert.equal(await reportPmWatchCompletion(pool,watch,{message,visibleLimit:3500,resumeInstruction:' Continue.'}),'completed');
 const msgs=(await db.query('SELECT role,body FROM assistant_messages')).rows;
 assert.equal(msgs.find(m=>m.role==='assistant').body.length,3500);
 assert.equal(msgs.find(m=>m.role==='user').body,'СИСТЕМНОЕ СОБЫТИЕ: '+message+' Continue.');
});

test('any failed downstream write rolls back completion marker so Temporal can retry safely',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pmreport_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query(`
  CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id));
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,body text,channel text,status text,topic_id uuid,pm_order_id uuid,CHECK(body<>'BLOCKED'));
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid,created_at timestamptz DEFAULT now());
 `);
 const watch={projectId:randomUUID(),processId:randomUUID(),kind:'iteration_execution'};
 await assert.rejects(reportPmWatchCompletion(pool,watch,{message:'BLOCKED',resumeInstruction:''}),/check constraint/i);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM project_pm_process_reports')).rows[0].count,0,'marker must not be orphaned');
 await db.query('ALTER TABLE assistant_messages DROP CONSTRAINT assistant_messages_body_check');
 assert.equal(await reportPmWatchCompletion(pool,watch,{message:'BLOCKED',resumeInstruction:''}),'completed');
 assert.equal((await db.query('SELECT count(*)::int AS count FROM project_pm_process_reports')).rows[0].count,1);
 assert.deepEqual((await db.query('SELECT role,body FROM assistant_messages')).rows,[{role:'assistant',body:'BLOCKED'}],'unowned process has no internal PM turn');
});

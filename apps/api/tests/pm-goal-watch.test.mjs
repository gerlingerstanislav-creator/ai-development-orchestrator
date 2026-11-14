import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {openPmGoal,installPmGoalSchema,installPmCapabilityProposalSchema} from '../dist/modules/planning/infrastructure/pm-goals.js';
import {checkProjectManagerWatch} from '../dist/project-manager-inbox.js';

test('Temporal returns an unfulfilled goal to its original PM conversation exactly once',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='pmgoalwatch_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();});
 await admin.query('CREATE SCHEMA '+schema);
 await pool.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY);
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,project_id uuid,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,
   body text,channel text,status text,topic_id uuid,pm_order_id uuid);
  CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid);
  CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id));
 `);
 await installPmGoalSchema(pool);
 await installPmCapabilityProposalSchema(pool);
 const projectId=randomUUID(),actorId=randomUUID(),messageId=randomUUID(),orderId=randomUUID();
 await pool.query('INSERT INTO projects VALUES($1)',[projectId]);
 await pool.query("INSERT INTO project_pm_orders(id,project_id,status) VALUES($1,$2,'working')",[orderId,projectId]);
 await pool.query("INSERT INTO assistant_messages VALUES($1,$2,$3,'user','Сделай аудит сайта','project','processing',NULL,$4)",
  [messageId,projectId,actorId,orderId]);
 const goal=await openPmGoal(pool,{projectId,actorId,sourceMessageId:messageId,
  objective:'Выполнить проверку сайта и предоставить результат',
  criteria:['Проверяемый отчёт с доказательствами о выполненной проверке']});
 const watch={projectId,processId:goal.id,goalId:goal.id,kind:'goal',orderId,actorId};
 assert.equal(await checkProjectManagerWatch(pool,watch),'completed');
 assert.equal(await checkProjectManagerWatch(pool,watch),'completed');
 const main=await pool.query("SELECT body FROM assistant_messages WHERE role='assistant' AND channel='project'");
 const internal=await pool.query("SELECT body FROM assistant_messages WHERE role='user' AND channel='pm-internal'");
 assert.equal(main.rowCount,1,'one user-visible PM report');
 assert.equal(internal.rowCount,1,'one durable continuation back to PM');
 assert.match(main.rows[0].body,/не привязаны проверяемые результаты/);
 assert.match(internal.rows[0].body,/Продолжай ИСХОДНУЮ цель/);
 assert.equal((await pool.query('SELECT status FROM project_pm_orders WHERE id=$1',[orderId])).rows[0].status,
  'queued','original conversation becomes actionable again');
});

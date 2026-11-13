import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PM_GOAL_POLICY,annotatePmToolResult,pmOrderStateFromResults} from '../dist/pm-goal-policy.js';
import {readPmTaskGoal} from '../dist/pm-task-goal.js';
import {authorizePmDestructiveSource} from '../dist/pm-source-authorization.js';
import {checkProjectManagerWatch} from '../dist/project-manager-inbox.js';
import {executeAgentTool} from '../dist/agent-tool-executor.js';
import {toolsForRole} from '../dist/agent-tools.js';

test('PM can recover from delete/close failures rather than declaring the goal impossible',()=>{
 assert.match(PM_GOAL_POLICY,/конечн|результат/);
 assert.match(PM_GOAL_POLICY,/tasks\.cancel/);
 const deletion=annotatePmToolResult('tasks.delete',{status:'blocked',reason:'Уже есть PR #9'});
 assert.equal(deletion.goal_reached,false);
 assert.ok(deletion.alternatives.some(v=>v.tool==='tasks.cancel'));
 const close=annotatePmToolResult('tasks.close',{status:'blocked',reason:'QA не подтверждён'});
 assert.ok(close.alternatives.some(v=>v.tool==='workflow.move_task'));
 const blocked=[{tool:'tasks.delete',result:deletion}];
 assert.equal(pmOrderStateFromResults(blocked,0),'waiting_user');
 assert.equal(pmOrderStateFromResults([...blocked,{tool:'tasks.cancel',result:{status:'cancelled'}}],0),'completed',
  'a successful cancellation must resolve the earlier failed deletion');
 assert.equal(pmOrderStateFromResults([{tool:'pm.orders.watch_task',result:{status:'watching'}}],1),'waiting_agents');
 assert.equal(pmOrderStateFromResults([{tool:'pm.orders.watch_task',result:{status:'needs_action'}}],0),'waiting_user');
 assert.ok(toolsForRole('manager').some(t=>t.name==='pm.orders.watch_task'));
 assert.ok(!toolsForRole('analyst').some(t=>t.name==='pm.orders.watch_task'));
});

test('task-goal watch reports stalled QA to the same PM order and resumes exactly once',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='pm_goals_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid,title text,display_number int,stage text,type text DEFAULT 'task',analysis_state text DEFAULT 'new');
  CREATE TABLE task_orchestration_owners(task_id uuid,project_id uuid,state text);
  CREATE TABLE ai_task_runs(task_id uuid,project_id uuid,status text);
  CREATE TABLE ai_test_runs(task_id uuid,project_id uuid,status text);
  CREATE TABLE agent_analysis_runs(task_id uuid,project_id uuid,status text);
  CREATE TABLE requirement_review_runs(task_id uuid,project_id uuid,status text);
  CREATE TABLE project_pm_process_reports(project_id uuid,process_id uuid,kind text,PRIMARY KEY(project_id,process_id));
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,body text,channel text,status text,topic_id uuid,pm_order_id uuid);
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,source_message_id uuid,topic_id uuid,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE project_pm_order_events(id uuid PRIMARY KEY,order_id uuid,kind text,detail text,process_id uuid,created_at timestamptz DEFAULT now());
 `);
 const project=randomUUID(),task=randomUUID(),owner=randomUUID(),order=randomUUID(),watchId=randomUUID();
 await db.query("INSERT INTO tasks(id,project_id,title,display_number,stage) VALUES($1,$2,'Разработать страницу с десятью кругами',32,'testing')",[task,project]);
 await db.query("INSERT INTO task_orchestration_owners VALUES($1,$2,'active')",[task,project]);
 await db.query("INSERT INTO project_pm_orders(id,project_id,actor_id,status) VALUES($1,$2,$3,'waiting_agents')",[order,project,owner]);
 const session={id:randomUUID(),project_id:project,actor_id:owner,role:'manager',read_only:false};
 const unbound=await executeAgentTool(db,session,'pm.orders.watch_task',{task_id:task},async()=>{});
 assert.equal(unbound.status,'needs_action','task chat must not claim an unregistered Temporal watch');
 const turn=randomUUID();
 await db.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,body,channel,status) VALUES($1,$2,$3,'user','Доведи задачу до конца','project','processing')",[turn,project,owner]);
 session.process_id=turn;
 const read=await executeAgentTool(db,session,'pm.orders.watch_task',{task_id:task},async()=>{});
 assert.equal(read.status,'watching');
 assert.ok(read.watch_id);
 const watch={projectId:project,processId:watchId,taskId:task,kind:'task_goal',orderId:order,actorId:owner};
 assert.equal(await checkProjectManagerWatch(db,watch),'pending');
 await db.query("UPDATE task_orchestration_owners SET state='completed' WHERE task_id=$1",[task]);
 const now=await readPmTaskGoal(db,project,task);
 assert.equal(now.status,'needs_action','QA completed does not imply task completed');
 assert.equal(await checkProjectManagerWatch(db,watch),'completed');
 assert.equal(await checkProjectManagerWatch(db,watch),'completed');
 const [visible,internal]=await Promise.all([
  db.query("SELECT body FROM assistant_messages WHERE channel='project' AND pm_order_id=$1",[order]),
  db.query("SELECT body FROM assistant_messages WHERE channel='pm-internal' AND pm_order_id=$1",[order])
 ]);
 assert.equal(visible.rowCount,1);
 assert.match(visible.rows[0].body,/Цель пока не достигнута/);
 assert.equal(internal.rowCount,1);
 assert.match(internal.rows[0].body,/проверь состояние|Проверь состояние/);
 const status=(await db.query('SELECT status FROM project_pm_orders WHERE id=$1',[order])).rows[0].status;
 assert.equal(status,'queued','Temporal must continue the original order');
 const next=await executeAgentTool(db,session,'pm.orders.watch_task',{task_id:task},async()=>{});
 assert.equal(next.status,'needs_action');
 assert.equal(next.watch_registered,false,'no infinite re-watch without new work');
 await db.query("UPDATE tasks SET stage='done' WHERE id=$1",[task]);
 const done=await readPmTaskGoal(db,project,task);
 assert.equal(done.status,'done');
 const finished={...watch,processId:randomUUID()};
 assert.equal(await checkProjectManagerWatch(db,finished),'completed');
 const results=(await db.query("SELECT body FROM assistant_messages WHERE channel='project' AND role='assistant' ORDER BY body")).rows;
 assert.equal(results.length,2);
 assert.ok(results.some(v=>/Цель достигнута/.test(v.body)));
});

test('destructive PM action uses authenticated current owner message, not a word matcher',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='pm_owner_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await pool.query(`
  CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,channel text,pm_order_id uuid);
  CREATE TABLE project_pm_orders(id uuid PRIMARY KEY,project_id uuid,source_message_id uuid);
  CREATE TABLE manager_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text);
 `);
 const project=randomUUID(),otherProject=randomUUID(),owner=randomUUID(),otherActor=randomUUID();
 const first=randomUUID(),second=randomUUID(),outsider=randomUUID(),internal=randomUUID(),order=randomUUID();
 await pool.query("INSERT INTO assistant_messages VALUES($1,$2,$3,'user','project',NULL),($4,$2,$3,'user','project',NULL),($5,$6,$7,'user','project',NULL)",
  [first,project,owner,second,outsider,otherProject,otherActor]);
 const allow=async(currentMessageId,sourceMessageId,actorId=owner)=>authorizePmDestructiveSource(pool,{
  projectId:project,actorId,currentMessageId,sourceMessageId
 });
 await allow(first,first);
 await assert.rejects(allow(first,second),/текущего поручения/);
 await assert.rejects(allow(first,outsider),/текущего поручения/);
 await assert.rejects(allow(null,first),/Нет текущего сообщения/);
 await pool.query('INSERT INTO project_pm_orders VALUES($1,$2,$3)',[order,project,first]);
 await pool.query("INSERT INTO assistant_messages VALUES($1,$2,$3,'user','pm-internal',$4)",[internal,project,owner,order]);
 await allow(internal,first);
 await assert.rejects(allow(internal,second),/текущего поручения/);
 await pool.query('UPDATE assistant_messages SET pm_order_id=$2 WHERE id=$1',[second,order]);
 await allow(internal,second);
 const taskChat=randomUUID();
 await pool.query("INSERT INTO manager_messages VALUES($1,$2,$3,'user')",[taskChat,project,owner]);
 await allow(taskChat,taskChat);
 await assert.rejects(allow(taskChat,first),/текущего поручения/);
});

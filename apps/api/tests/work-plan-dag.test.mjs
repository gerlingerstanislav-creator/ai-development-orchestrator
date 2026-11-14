import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {orderWorkPlan} from '../dist/modules/agents/domain/work-plan.js';
import {planWork} from '../dist/modules/agents/infrastructure/work-assignments.js';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';

const devops={key:'env',role:'devops',objective:'Prepare a usable isolated test environment',acceptance:'Environment starts without exposing secrets',needs:[]};
const qa={key:'capture',role:'testing',objective:'Capture verified browser screenshots',acceptance:'Real desktop and mobile screenshots attached',needs:['env']};
const docs={key:'docs',role:'documentation',objective:'Document the verified results',acceptance:'Documentation cites real QA evidence',needs:['capture']};

test('arbitrary work-plan DAG is topologically ordered without keyword rules',()=>{
 assert.deepEqual(orderWorkPlan([docs,qa,devops]).map(step=>step.key),['env','capture','docs']);
 assert.deepEqual(orderWorkPlan([qa,devops]).map(step=>step.key),['env','capture']);
 assert.throws(()=>orderWorkPlan([]),/от 1 до 12/);
 assert.throws(()=>orderWorkPlan([{...qa,needs:['missing']}]),/Неизвестная зависимость/);
 assert.throws(()=>orderWorkPlan([devops,{...devops}]),/Повторяется ключ/);
 assert.throws(()=>orderWorkPlan([{...devops,needs:['env']}]),/самого себя/);
 assert.throws(()=>orderWorkPlan([{...devops,needs:['capture']},qa]),/Циклическая зависимость/);
 assert.throws(()=>orderWorkPlan([{...devops,needs:['capture','capture']},qa]),/Некорректные зависимости/);
});

test('PostgreSQL v14 stores atomic generic plans with same-task prerequisites and no Kanban bypass',async t=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='ado_work_plan_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 t.after(async()=>{
  await pool.end();
  await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
  await admin.end();
 });
 await runSchemaMigrations(pool,coreSchemaMigrations({analysis:'Аналитика'}));
 const projectId=randomUUID(),userId=randomUUID(),taskId=randomUUID(),otherTaskId=randomUUID();
 await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'dag-test@example.test','hash')",[userId]);
 await pool.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Work DAG test',$2)",[projectId,userId]);
 await pool.query("INSERT INTO tasks(id,project_id,title,type,stage) VALUES($1,$2,'Plan browser verification','task','analysis'),($3,$2,'Another task','task','analysis')",
  [taskId,projectId,otherTaskId]);
 const tx=await pool.connect();
 let plan;
 try{
  await tx.query('BEGIN');
  plan=await planWork(tx,{projectId,taskId,sourceRole:'manager',steps:[docs,qa,devops]});
  await tx.query('COMMIT');
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 assert.equal(plan.assignments.length,3);
 // Replaying the identical instruction (including after a PM process restart)
 // must reuse the existing graph and dependency IDs rather than enqueueing it again.
 const replay=await planWork(pool,{projectId,taskId,sourceRole:'manager',steps:[docs,qa,devops]});
 assert.equal(replay.duplicate,true);
 assert.equal(replay.plan_id,plan.plan_id);
 assert.deepEqual(replay.assignments,plan.assignments);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_work_assignments WHERE task_id=$1',[taskId])).rows[0].n,3);
 assert.deepEqual(plan.assignments.map(x=>x.key),['env','capture','docs']);
 assert.deepEqual(plan.assignments[1].depends_on,[plan.assignments[0].id]);
 assert.deepEqual(plan.assignments[2].depends_on,[plan.assignments[1].id]);
 assert.equal((await pool.query('SELECT stage FROM tasks WHERE id=$1',[taskId])).rows[0].stage,'analysis');
 const dependencies=(await pool.query('SELECT count(*)::int AS count FROM agent_work_plan_dependencies WHERE project_id=$1 AND task_id=$2',[projectId,taskId])).rows[0];
 assert.equal(dependencies.count,2);
 const eligible=()=>pool.query(`SELECT a.id FROM agent_work_assignments a
  WHERE a.task_id=$1 AND a.status='queued'
  AND NOT EXISTS(SELECT 1 FROM agent_work_plan_dependencies d
   JOIN agent_work_assignments requires ON requires.id=d.requires_id
   WHERE d.assignment_id=a.id AND requires.status<>'completed') ORDER BY a.created_at,a.id`,[taskId]);
 assert.deepEqual((await eligible()).rows.map(x=>x.id),[plan.assignments[0].id]);
 await pool.query("UPDATE agent_work_assignments SET status='completed',evidence='Verified environment' WHERE id=$1",[plan.assignments[0].id]);
 assert.deepEqual((await eligible()).rows.map(x=>x.id),[plan.assignments[1].id]);
 await pool.query("UPDATE agent_work_assignments SET status='blocked' WHERE id=$1",[plan.assignments[1].id]);
 assert.deepEqual((await eligible()).rows,[]);
 await pool.query("UPDATE agent_work_assignments SET status='completed',evidence='Screenshots verified' WHERE id=$1",[plan.assignments[1].id]);
 assert.deepEqual((await eligible()).rows.map(x=>x.id),[plan.assignments[2].id]);
 const otherId=randomUUID();
 await pool.query("INSERT INTO agent_work_assignments(id,project_id,task_id,source_role,role,objective,acceptance,spec_version) VALUES($1,$2,$3,'manager','testing','Check another feature','Verify another feature',1)",
  [otherId,projectId,otherTaskId]);
 await assert.rejects(pool.query(
  'INSERT INTO agent_work_plan_dependencies(project_id,task_id,assignment_id,requires_id) VALUES($1,$2,$3,$4)',
  [projectId,taskId,plan.assignments[2].id,otherId]),e=>e?.code==='23503');
 await assert.rejects(planWork(pool,{projectId,taskId,sourceRole:'manager',steps:[{...devops,needs:['capture']},qa]}),/Циклическая/);
 const total=(await pool.query('SELECT count(*)::int AS n FROM agent_work_assignments WHERE task_id=$1',[taskId])).rows[0].n;
 assert.equal(total,3,'Rejected cyclic plan must not insert partial work');
});

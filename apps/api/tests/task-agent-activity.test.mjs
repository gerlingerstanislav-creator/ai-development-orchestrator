import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readAgentActivity,recordAgentActivity} from '../dist/task-agent-activity.js';

test('task chat shows parallel agent runs and retains one outcome per completed run',async()=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 try{
  await db.query(`
   CREATE TEMP TABLE process_events (id uuid,project_id uuid,task_id uuid,process_id uuid,process_kind text,stage text,detail text,level text,created_at timestamptz DEFAULT clock_timestamp());
   CREATE TEMP TABLE ai_task_runs (id uuid,project_id uuid,task_id uuid,status text,message text,pr_url text,created_at timestamptz DEFAULT now(),completed_at timestamptz);
   CREATE TEMP TABLE ai_test_runs (id uuid,project_id uuid,task_id uuid,status text,message text,verdict text,report jsonb,created_at timestamptz DEFAULT now(),completed_at timestamptz);
   CREATE TEMP TABLE requirement_review_runs (id uuid,project_id uuid,task_id uuid,status text,message text,created_at timestamptz DEFAULT now(),completed_at timestamptz);
   CREATE TEMP TABLE task_agent_notes (task_id uuid,source_key text,body text);
  `);
  const projectId=randomUUID(),taskId=randomUUID(),otherTaskId=randomUUID();
  const devId=randomUUID(),qaId=randomUUID(),analysisId=randomUUID();
  await db.query("INSERT INTO ai_task_runs(id,project_id,task_id,status,message) VALUES($1,$2,$3,'running','Работа идёт')",[devId,projectId,taskId]);
  await db.query("INSERT INTO ai_test_runs(id,project_id,task_id,status,message) VALUES($1,$2,$3,'running','Проверки идут')",[qaId,projectId,taskId]);
  await recordAgentActivity(db,projectId,[otherTaskId],randomUUID(),'documentation','running','Другая задача');
  const active=await readAgentActivity(db,projectId,taskId);
  assert.deepEqual(active.map(run=>run.kind).sort(),['development','testing']);
  assert.ok(active.every(run=>run.status==='running'));

  await db.query("UPDATE ai_task_runs SET status='completed',completed_at=now(),pr_url='https://github.com/example/repo/pull/1' WHERE id=$1",[devId]);
  await db.query("INSERT INTO task_agent_notes VALUES($1,$2,'Реализован поиск по названию.')",[taskId,'developer:'+devId]);
  await db.query("UPDATE ai_test_runs SET status='completed',verdict='blocked',report=$2,completed_at=now() WHERE id=$1",[qaId,{summary:'Браузер недоступен.'}]);
  await recordAgentActivity(db,projectId,[taskId],analysisId,'analysis','running','Начался анализ');
  await recordAgentActivity(db,projectId,[taskId],analysisId,'analysis','completed','Критерии уточнены.');

  const results=await readAgentActivity(db,projectId,taskId);
  assert.equal(results.length,3);
  assert.ok(results.every(run=>run.status==='completed'));
  assert.equal(results.find(run=>run.id===devId).summary,'Реализован поиск по названию.');
  assert.match(results.find(run=>run.id===qaId).summary,/заблокирована.*Браузер недоступен/);
  assert.equal(results.find(run=>run.id===analysisId).summary,'Критерии уточнены.');
 }finally{await db.end();}
});

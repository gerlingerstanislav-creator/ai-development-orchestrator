import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {readProjectTaskCurrentWork} from '../dist/task-current-work.js';

async function isolated(fn){
 const name='ado_activate_board_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:3});
 try{await fn(db);}finally{
  await db.end();await admin.query('DROP SCHEMA "'+name+'" CASCADE');await admin.end();
 }
}
async function seed(db){
 const ids={user:randomUUID(),project:randomUUID(),legacy:randomUUID(),newTask:randomUUID(),postponed:randomUUID()};
 await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[ids.user,'board-execution@example.test','pass']);
 await db.query('INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,$2,$3,true)',[ids.project,'Work',ids.user]);
 for(const taskId of [ids.legacy,ids.newTask,ids.postponed])
  await db.query("INSERT INTO tasks(id,project_id,title,stage,board_status) VALUES($1,$2,'Task','backlog','backlog')",[taskId,ids.project]);
 return ids;
}
async function assign(db,id,taskId,status='queued'){
 const key=randomUUID();
 await db.query(`INSERT INTO agent_work_assignments
 (id,project_id,task_id,source_role,role,objective,acceptance,spec_version,status)
 VALUES($1,$2,$3,'manager','documentation','Сделать подтверждённые снимки экрана',
 'Desktop и mobile изображения с одинаковым SHA',1,$4)`,[key,id.project,taskId,status]);
 return key;
}
test('v22 automatically moves old and newly assigned tasks into In progress with atomic event',async()=>{
 await isolated(async db=>{
  const migrations=coreSchemaMigrations({analysis:'Аналитика'});
  assert.equal(migrations.at(-1).version,22);
  await runSchemaMigrations(db,migrations.filter(x=>x.version<=21));
  const ids=await seed(db);
  await assign(db,ids,ids.legacy);
  assert.equal((await db.query('SELECT board_status FROM tasks WHERE id=$1',[ids.legacy])).rows[0].board_status,'backlog');
  assert.deepEqual(await runSchemaMigrations(db,migrations),[22]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  assert.equal((await db.query('SELECT board_status FROM tasks WHERE id=$1',[ids.legacy])).rows[0].board_status,'in_progress');

  const aid=await assign(db,ids,ids.newTask);
  const card=(await db.query('SELECT stage,board_status FROM tasks WHERE id=$1',[ids.newTask])).rows[0];
  assert.deepEqual(card,{stage:'backlog',board_status:'in_progress'},'technical stage remains independent');
  const events=(await db.query("SELECT event FROM task_events WHERE task_id=$1 AND event='board_activated_by_work'",[ids.newTask])).rows;
  assert.equal(events.length,1);
  await db.query("UPDATE agent_work_assignments SET status='running' WHERE id=$1",[aid]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND event='board_activated_by_work'",[ids.newTask])).rows[0].n,1);
  const work=await readProjectTaskCurrentWork(db,ids.project);
  assert.ok(work.get(ids.newTask)?.some(w=>w.role==='documentation'&&w.detail.includes('снимки')));

  await db.query("UPDATE tasks SET postponed_at=now() WHERE id=$1",[ids.postponed]);
  await assert.rejects(assign(db,ids,ids.postponed),e=>e.code==='23514');
  assert.equal((await db.query('SELECT board_status FROM tasks WHERE id=$1',[ids.postponed])).rows[0].board_status,'backlog');
 });
});

test('postponed and accepted cards never start background work just because an agent queues it',async()=>{
 await isolated(async db=>{
  await runSchemaMigrations(db,coreSchemaMigrations({analysis:'Аналитика'}));
  const ids=await seed(db);
  await db.query("UPDATE tasks SET board_status='done' WHERE id=$1",[ids.newTask]);
  await assert.rejects(assign(db,ids,ids.newTask),e=>e.code==='23514');
  assert.equal((await db.query('SELECT board_status FROM tasks WHERE id=$1',[ids.newTask])).rows[0].board_status,'done');
 });
});

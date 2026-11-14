import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {boardStateForStage,canPlanBoardMove} from '../dist/task-board.js';
import {registerTaskBoardRoutes} from '../dist/task-board-routes.js';

async function withSchema(fn){
 const name='ado_universal_board_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:4});
 try{await fn(db);}finally{
  await db.end();await admin.query('DROP SCHEMA "'+name+'" CASCADE');await admin.end();
 }
}

test('planning statuses never grant permission to bypass technical QA or PR',()=>{
 assert.equal(boardStateForStage('backlog'),'backlog');
 assert.equal(boardStateForStage('testing'),'in_progress');
 assert.equal(boardStateForStage('done'),'acceptance');
 assert.equal(boardStateForStage('done','automatic'),'done');
 assert.equal(canPlanBoardMove('backlog','backlog','todo'),true);
 assert.equal(canPlanBoardMove('backlog','todo','in_progress'),true);
 assert.equal(canPlanBoardMove('testing','in_progress','done'),false);
 assert.equal(canPlanBoardMove('testing','in_progress','acceptance'),false);
 assert.equal(canPlanBoardMove('done','acceptance','done'),false);
});

test('v21 migrates old tasks and protects owner acceptance with real PostgreSQL',async()=>{
 await withSchema(async db=>{
  const migrations=coreSchemaMigrations({analysis:'Аналитика'});
  assert.equal(migrations.at(-1).version,21);
  await runSchemaMigrations(db,migrations.filter(x=>x.version<21));
  const ids={user:randomUUID(),project:randomUUID(),oldDone:randomUUID(),testing:randomUUID(),backlog:randomUUID(),auto:randomUUID(),question:randomUUID()};
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[ids.user,'board@example.test','test']);
  await db.query('INSERT INTO projects(id,name,owner_id) VALUES($1,$2,$3)',[ids.project,'Board',ids.user]);
  for(const [taskId,stage] of [[ids.oldDone,'done'],[ids.testing,'testing'],[ids.backlog,'backlog'],[ids.auto,'testing']]){
   await db.query('INSERT INTO tasks(id,project_id,title,stage) VALUES($1,$2,$3,$4)',[taskId,ids.project,'Legacy task',stage]);
  }
  assert.deepEqual(await runSchemaMigrations(db,migrations),[21]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const rows=await db.query('SELECT id,stage,board_status,acceptance_mode FROM tasks WHERE project_id=$1',[ids.project]);
  const task=id=>rows.rows.find(x=>x.id===id);
  assert.equal(task(ids.oldDone).board_status,'done','previously closed tasks are grandfathered');
  assert.equal(task(ids.testing).board_status,'in_progress');
  assert.equal(task(ids.backlog).board_status,'backlog');
  assert.equal(task(ids.testing).acceptance_mode,'undecided');
  // Resolved documentation questions cannot require human acceptance because
  // they are answered inside their own question flow, not task detail controls.
  await db.query("INSERT INTO tasks(id,project_id,title,type,stage) VALUES($1,$2,'Question','question','backlog')",[ids.question,ids.project]);
  await db.query("UPDATE tasks SET stage='done' WHERE id=$1",[ids.question]);
  assert.equal((await db.query('SELECT board_status FROM tasks WHERE id=$1',[ids.question])).rows[0].board_status,'done');


  const app=Fastify();
  registerTaskBoardRoutes(app,{
   pool:db,uid:()=>ids.user,access:async()=>true,requireAdmin:async()=>true
  });
  const action=(taskId,body)=>app.inject({
   method:'PATCH',url:'/api/projects/'+ids.project+'/tasks/'+taskId+'/board',payload:body
  });
  try{
   assert.equal((await action(ids.testing,{action:'move',status:'done'})).statusCode,409);
   assert.equal((await action(ids.testing,{action:'accept'})).statusCode,409);
   assert.equal((await action(ids.backlog,{action:'move',status:'todo'})).statusCode,200);
   assert.equal((await action(ids.backlog,{action:'postpone',until:'2026-12-15'})).statusCode,200);
   let state=(await db.query('SELECT board_status,postponed_at,postponed_until FROM tasks WHERE id=$1',[ids.backlog])).rows[0];
   assert.equal(state.board_status,'backlog');
   assert.ok(state.postponed_at);
   assert.equal(state.postponed_until instanceof Date?state.postponed_until.toISOString().slice(0,10):String(state.postponed_until).slice(0,10),'2026-12-15');
   assert.equal((await action(ids.backlog,{action:'resume'})).statusCode,200);
   assert.equal((await db.query('SELECT board_status FROM tasks WHERE id=$1',[ids.backlog])).rows[0].board_status,'todo');

   // Trigger is the ONLY bridge from the existing legacy stage machine.
   await db.query("UPDATE tasks SET stage='done' WHERE id=$1",[ids.testing]);
   state=(await db.query('SELECT board_status,accepted_at FROM tasks WHERE id=$1',[ids.testing])).rows[0];
   assert.equal(state.board_status,'acceptance');
   assert.equal(state.accepted_at,null);
   assert.equal((await action(ids.testing,{action:'request_changes',reason:'Сломано поведение пустой формы'})).statusCode,200);
   assert.equal((await db.query('SELECT board_status,acceptance_feedback FROM tasks WHERE id=$1',[ids.testing])).rows[0].acceptance_feedback,'Сломано поведение пустой формы');
   assert.equal((await action(ids.testing,{action:'accept'})).statusCode,200);
   state=(await db.query('SELECT board_status,accepted_at,accepted_by,acceptance_feedback FROM tasks WHERE id=$1',[ids.testing])).rows[0];
   assert.equal(state.board_status,'done');
   assert.ok(state.accepted_at);
   assert.equal(state.accepted_by,ids.user);
   assert.equal(state.acceptance_feedback,null);
   assert.equal((await action(ids.testing,{action:'archive'})).statusCode,200);
   assert.equal((await action(ids.testing,{action:'move',status:'in_progress'})).statusCode,409);
   assert.equal((await action(ids.testing,{action:'restore'})).statusCode,200);

   assert.equal((await action(ids.auto,{action:'set_acceptance',mode:'automatic'})).statusCode,200);
   await db.query("UPDATE tasks SET stage='done' WHERE id=$1",[ids.auto]);
   const automatic=(await db.query('SELECT board_status,accepted_at FROM tasks WHERE id=$1',[ids.auto])).rows[0];
   assert.equal(automatic.board_status,'done');
   assert.ok(automatic.accepted_at);
  }finally{await app.close();}
 });
});

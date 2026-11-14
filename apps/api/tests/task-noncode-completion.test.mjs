import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {completeNonCodeTask} from '../dist/task-noncode-completion.js';
import {registerTaskBoardRoutes} from '../dist/task-board-routes.js';

async function isolated(fn){
 const name='ado_noncode_result_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:4});
 try{await runSchemaMigrations(db,coreSchemaMigrations({analysis:'Аналитика'}));await fn(db);}
 finally{await db.end();await admin.query('DROP SCHEMA "'+name+'" CASCADE');await admin.end();}
}
async function prepare(db,role='documentation',status='completed'){
 const id={user:randomUUID(),project:randomUUID(),task:randomUUID(),assignment:randomUUID()};
 await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[id.user,'noncode@example.test','hash']);
 await db.query('INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,$2,$3,true)',[id.project,'Docs',id.user]);
 await db.query("INSERT INTO tasks(id,project_id,title,stage,board_status) VALUES($1,$2,'Написать исследование','backlog','in_progress')",[id.task,id.project]);
 await db.query(`INSERT INTO agent_work_assignments
  (id,project_id,task_id,source_role,role,objective,acceptance,spec_version,status,result,evidence,reviewer_note)
  VALUES($1,$2,$3,'manager',$4,'Подготовить качественное исследование',
   'Проверить источники и приложить выводы',1,$5,$6,$7,$8)`,
  [id.assignment,id.project,id.task,role,status,
   'Документ создан, источники прочитаны и сравнены по заданным критериям',
   'Результат проверен по документу в проектной базе',
   'PM проверил все критерии и подтверждённые артефакты']);
 return id;
}
const complete=(db,id)=>completeNonCodeTask(db,{projectId:id.project,taskId:id.task,actorId:id.user,
 kind:'documentation',summary:'Исследование подготовлено, факты и выводы сохранены в документации',
 evidence:'Проверен сохранённый документ, его содержимое и подтверждённая работа исполнителя'});

test('accepted non-code work completes technical result but still waits for owner acceptance',async()=>{
 await isolated(async db=>{
  const id=await prepare(db);
  const result=await complete(db,id);
  assert.equal(result.status,'completed');
  assert.equal(result.verified_assignments,1);
  assert.equal(result.board_status,'acceptance');
  assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[id.task])).rows[0].stage,'done');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND event='noncode_completed'",[id.task])).rows[0].n,1);
  const replay=await complete(db,id);assert.equal(replay.status,'existing');
  const app=Fastify();
  registerTaskBoardRoutes(app,{pool:db,uid:()=>id.user,access:async()=>true,requireAdmin:async()=>true});
  try{
   const reply=await app.inject({method:'PATCH',url:'/api/projects/'+id.project+'/tasks/'+id.task+'/board',payload:{action:'accept'}});
   assert.equal(reply.statusCode,200,reply.body);
   const accepted=(await db.query('SELECT board_status,accepted_by FROM tasks WHERE id=$1',[id.task])).rows[0];
   assert.equal(accepted.board_status,'done');assert.equal(accepted.accepted_by,id.user);
  }finally{await app.close();}
 });
});

test('non-code completion refuses submitted work, code roles and Git changes instead of bypassing QA/PR',async()=>{
 for(const [role,status,branchName] of [
  ['documentation','submitted',null],['development','completed',null],['documentation','completed','feature/coding']
 ]){
  await isolated(async db=>{
   const id=await prepare(db,role,status);
   if(branchName)await db.query('UPDATE tasks SET git_branch=$2 WHERE id=$1',[id.task,branchName]);
   await assert.rejects(complete(db,id),error=>error.statusCode===409);
   assert.equal((await db.query('SELECT stage,board_status FROM tasks WHERE id=$1',[id.task])).rows[0].stage,'backlog');
   assert.equal((await db.query("SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND event='noncode_completed'",[id.task])).rows[0].n,0);
  });
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {storePmCaptureImages,readPmCaptureArtifacts} from '../dist/pm-browser-capture.js';
import {completeNonCodeTask} from '../dist/task-noncode-completion.js';
import {toolsForRole} from '../dist/agent-tools.js';

const sha='f'.repeat(40);
const image=(width,height)=>{
 const b=Buffer.alloc(220,width===390?123:78);
 b[0]=255;b[1]=216;b[b.length-2]=255;b[b.length-1]=217;
 return {name:width+'x'+height+'-'+randomUUID()+'.jpg',
  mime:'image/jpeg',origin:'isolated-local-browser',viewport:{width,height},
  sha256:createHash('sha256').update(b).digest('hex'),data:b.toString('base64')};
};
async function isolated(fn){
 const n='pm_capture_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+n+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+n,max:3});
 try{await runSchemaMigrations(db,coreSchemaMigrations({analysis:'Анализ'}));await fn(db);}
 finally{await db.end();await admin.query('DROP SCHEMA "'+n+'" CASCADE');await admin.end();}
}
async function seed(db,stage='backlog'){
 const ids={user:randomUUID(),project:randomUUID(),task:randomUUID(),capture:randomUUID()};
 await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'pm-browser@example.test','hash')",[ids.user]);
 await db.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Screenshots',$2)",[ids.project,ids.user]);
 await db.query("INSERT INTO tasks(id,project_id,title,stage,board_status) VALUES($1,$2,'Capture', $3,'in_progress')",
  [ids.task,ids.project,stage]);
 await db.query(`INSERT INTO pm_browser_captures(
  id,project_id,task_id,actor_id,repository,branch,revision_mode,requested_sha)
  VALUES($1,$2,$3,$4,'example/web','main','latest',NULL)`,
  [ids.capture,ids.project,ids.task,ids.user]);
 return ids;
}
const upload=(db,id,artifacts)=>storePmCaptureImages(db,{
 captureId:id.capture,projectId:id.project,taskId:id.task,sourceSha:sha,artifacts
});
test('browser.capture tool is visible only to PM, never an analyst or specialist',()=>{
 assert.ok(toolsForRole('manager').some(t=>t.name==='browser.capture'));
 for(const role of ['analyst','development','testing','documentation','architect','devops']){
  assert.ok(!toolsForRole(role).some(t=>t.name==='browser.capture'),role);
 }
});
test('v23 stores two real same-SHA Chromium receipts, refuses tampering and permits PM completion without delegate/QA',async()=>{
 await isolated(async db=>{
  const id=await seed(db);
  const good=[image(1440,900),image(390,844)];
  await assert.rejects(upload(db,id,[good[0],{...good[1],sha256:'a'.repeat(64)}]),/SHA256/);
  await assert.rejects(upload(db,id,[good[0],image(1440,900)]),/desktop и mobile/);
  const result=await upload(db,id,good);
  assert.equal(result.length,2);
  assert.ok(result.every(Boolean));
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM pm_browser_capture_artifacts WHERE capture_id=$1',
   [id.capture])).rows[0].n,2);
  await db.query("UPDATE pm_browser_captures SET status='completed',source_sha=$2 WHERE id=$1",[id.capture,sha]);
  const artifacts=await readPmCaptureArtifacts(db,id.project,id.task);
  assert.equal(artifacts.length,2);
  assert.ok(artifacts.every(x=>x.url.startsWith('/api/projects/'+id.project+'/tasks/'+id.task+'/pm-browser-artifacts/')));
  const out=await completeNonCodeTask(db,{
   projectId:id.project,taskId:id.task,actorId:id.user,kind:'screenshots',
   summary:'ПМ снял настоящие desktop и mobile скриншоты актуального сайта',
   evidence:'Проверены оба SHA256 браузерных изображений и закреплённый исходный commit'
  });
  assert.equal(out.status,'completed');
  assert.equal(out.verified_screenshots.length,2);
  assert.equal(out.verified_assignments,0);
  assert.equal(out.board_status,'acceptance');
 });
});
test('direct screenshot evidence cannot complete a task with a real code PR',async()=>{
 await isolated(async db=>{
  const id=await seed(db);
  await upload(db,id,[image(1440,900),image(390,844)]);
  await db.query("UPDATE pm_browser_captures SET status='completed',source_sha=$2 WHERE id=$1",[id.capture,sha]);
  await db.query("UPDATE tasks SET git_branch='feature/implementation' WHERE id=$1",[id.task]);
  await assert.rejects(completeNonCodeTask(db,{
   projectId:id.project,taskId:id.task,actorId:id.user,kind:'screenshots',
   summary:'Отчёт об изображениях не отменяет обязательную QA',
   evidence:'Подлинные изображения не являются проверкой изменённого кода'
  }),e=>e.statusCode===409);
 });
});

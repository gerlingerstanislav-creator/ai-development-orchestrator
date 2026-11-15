import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {storeProjectBrowserArtifacts,attachProjectCaptureToPmReply}
 from '../dist/project-browser-capture.js';
import {toolsForRole} from '../dist/agent-tools.js';
import {PM_EXECUTION_GUIDANCE} from '../dist/pm-execution-guidance.js';

const sha='a'.repeat(40);
const jpeg=Buffer.concat([
 Buffer.from([255,216,255,224]),Buffer.alloc(750,120),Buffer.from([255,217])
]);
const artifact=(path='/')=>({
 name:'1920x1080-'+randomUUID()+'.jpg',
 mime:'image/jpeg',data:jpeg.toString('base64'),
 sha256:createHash('sha256').update(jpeg).digest('hex'),
 viewport:{width:1920,height:1080},origin:'isolated-local-browser',
 fullPage:true,pagePath:path,title:path==='/'?'Главная':'Контакты',
 pixelWidth:2880,pixelHeight:6800
});
async function fixture(run){
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='pm_project_capture_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
  options:'-c search_path='+schema,max:3});
 try{
  await runSchemaMigrations(pool,coreSchemaMigrations({analysis:'Анализ'}));
  const ids={user:randomUUID(),project:randomUUID(),capture:randomUUID(),
   message:randomUUID()};
  await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'project-capture@example.test','hash')",[ids.user]);
  await pool.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'Project captures',$2)",[ids.project,ids.user]);
  await pool.query("INSERT INTO assistant_messages(id,project_id,role,body,channel,status) VALUES($1,$2,'assistant','Готовые снимки','project','completed')",[ids.message,ids.project]);
  await pool.query("INSERT INTO project_browser_captures(id,project_id,actor_id,repository,branch,mode,status,requested_sha) VALUES($1,$2,$3,'org/site','main','all_pages','running',$4)",
   [ids.capture,ids.project,ids.user,sha]);
  await run(pool,ids);
 }finally{await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
}

test('project browser evidence belongs to project and does not require or alter tasks',async()=>{
 await fixture(async(db,id)=>{
  const tasks=await db.query('SELECT count(*)::int AS n FROM tasks WHERE project_id=$1',[id.project]);
  assert.equal(tasks.rows[0].n,0,'no active or inactive tasks are required');
  const files=[artifact('/'),artifact('/contacts')];
  const result=await storeProjectBrowserArtifacts(db,{
   captureId:id.capture,projectId:id.project,sourceSha:sha,mode:'all_pages',artifacts:files
  });
  assert.equal(result.length,2);
  await db.query("UPDATE project_browser_captures SET status='completed',source_sha=$2 WHERE id=$1",
   [id.capture,sha]);
  assert.equal(await attachProjectCaptureToPmReply(db,{
   projectId:id.project,captureId:id.capture,messageId:id.message
  }),1);
  const attached=await db.query(
   'SELECT a.page_path,a.pixel_width,a.pixel_height,a.sha256,c.assistant_message_id '+
   'FROM project_browser_artifacts a JOIN project_browser_captures c ON c.id=a.capture_id '+
   'WHERE c.project_id=$1 AND c.assistant_message_id=$2 ORDER BY a.page_path',
   [id.project,id.message]);
  assert.equal(attached.rowCount,2);
  assert.deepEqual(attached.rows.map(x=>x.page_path),['/','/contacts']);
  assert.ok(attached.rows.every(x=>x.pixel_width===2880&&x.pixel_height===6800));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tasks WHERE project_id=$1',[id.project])).rows[0].n,0);
  await assert.rejects(attachProjectCaptureToPmReply(db,{
   projectId:id.project,captureId:id.capture,messageId:id.message
  }),/Не удалось привязать/);
 });
});
test('project capture rejects simulated images, wrong SHA, duplicate paths and cross-project access',async()=>{
 await fixture(async(db,id)=>{
  await assert.rejects(storeProjectBrowserArtifacts(db,{
   captureId:id.capture,projectId:id.project,sourceSha:'b'.repeat(40),mode:'all_pages',
   artifacts:[artifact()]
  }),/SHA не соответствует/);
  await assert.rejects(storeProjectBrowserArtifacts(db,{
   captureId:id.capture,projectId:id.project,sourceSha:sha,mode:'all_pages',
   artifacts:[{...artifact(),fullPage:false}]
  }),/проверку метаданных/);
  await assert.rejects(storeProjectBrowserArtifacts(db,{
   captureId:id.capture,projectId:id.project,sourceSha:sha,mode:'all_pages',
   artifacts:[{...artifact(),sha256:'f'.repeat(64)}]
  }),/контрольная сумма/);
  await assert.rejects(storeProjectBrowserArtifacts(db,{
   captureId:id.capture,projectId:randomUUID(),sourceSha:sha,mode:'all_pages',
   artifacts:[artifact()]
  }),/Съёмка проекта закрыта/);
  await assert.rejects(storeProjectBrowserArtifacts(db,{
   captureId:id.capture,projectId:id.project,sourceSha:sha,mode:'all_pages',
   artifacts:[artifact('/'),artifact('/')]
  }),/проверку метаданных/);
 });
});
test('project-wide PM capture exists for manager, not specialists, and guidance forbids task gating',()=>{
 assert.ok(toolsForRole('manager').some(tool=>tool.name==='browser.capture_project'));
 for(const role of ['analysis','testing','development','documentation','devops','architect','analyst']){
  assert.ok(!toolsForRole(role).some(tool=>tool.name==='browser.capture_project'),role);
 }
 assert.match(PM_EXECUTION_GUIDANCE,/browser\.capture_project/);
 assert.match(PM_EXECUTION_GUIDANCE,/mode=all_pages/);
 assert.match(PM_EXECUTION_GUIDANCE,/НЕ отказывай из-за закрытых/);
});

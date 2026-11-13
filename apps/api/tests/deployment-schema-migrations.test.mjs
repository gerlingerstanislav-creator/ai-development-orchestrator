import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {initAutomaticDeployment} from '../dist/deployment-automation.js';

const migrations=coreSchemaMigrations({analysis:'Аналитика'});
async function withSchema(fn){
 const schema='ado_deployment_v9_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 try{await fn(db);}
 finally{await db.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
}
test('fresh schema migrates deployment settings and per-project execution constraints to v9',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const objects=(await db.query(`SELECT
   to_regclass('deployment_runs') IS NOT NULL AS runs,
   to_regclass('project_deployment_ssh') IS NOT NULL AS credentials,
   to_regclass('idx_deployment_active_project') IS NOT NULL AS unique_active,
   to_regclass('idx_deployment_runs_task') IS NOT NULL AS task_index`)).rows[0];
  assert.ok(Object.values(objects).every(Boolean),JSON.stringify(objects));
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=9')).rows[0].checksum,
   'ado-deployment-automation-storage-v9');
  const before=(await db.query('SELECT version,name,checksum FROM schema_migrations WHERE version<9 ORDER BY version')).rows;
  assert.equal(before.length,8);
  assert.deepEqual(before.map(v=>v.version),[1,2,3,4,5,6,7,8]);
 });
});
test('adopt historical startup deployment storage without dropping active runs or encrypted SSH configuration',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.filter(m=>m.version<=8)),[1,2,3,4,5,6,7,8]);
  // Previous API versions installed this schema at every startup.
  await initAutomaticDeployment(db);
  const user=randomUUID(),project=randomUUID(),task=randomUUID(),run=randomUUID(),session=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'deployment-v9@example.test','hash')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Live deployment',$2,true)",[project,user]);
  await db.query("INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Release validated SHA')",[task,project]);
  // Directly inserted fixtures bypass the application's project-creation route.
  await db.query('INSERT INTO project_deployment_settings(project_id) VALUES($1) ON CONFLICT DO NOTHING',[project]);
  await db.query("UPDATE project_deployment_settings SET mode='automatic',health_url='https://example.test/health',environment='staging' WHERE project_id=$1",[project]);
  await db.query("INSERT INTO project_deployment_ssh(project_id,host,username,remote_path,private_key_encrypted,known_hosts) VALUES($1,'deploy.example.test','deployer','/srv/app','encrypted:private-key','deploy.example.test ssh-ed25519 placeholder')",[project]);
  await db.query("INSERT INTO deployment_runs(id,project_id,task_id,actor_id,sha,status,message) VALUES($1,$2,$3,$4,$5,'running','release underway')",[run,project,task,user,'a'.repeat(40)]);
  await db.query("INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,status,expires_at,task_id) VALUES($1,$2,$3,'development','v9-session','running',now()+interval '4 hours',$4)",[session,project,user,task]);
  await db.query("INSERT INTO task_deployment_records(task_id,project_id,status,reason,merge_sha) VALUES($1,$2,'automatic_verified','pinned SHA checked',$3)",[task,project,'a'.repeat(40)]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[9]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  assert.deepEqual((await db.query('SELECT mode,health_url,environment FROM project_deployment_settings WHERE project_id=$1',[project])).rows[0],
   {mode:'automatic',health_url:'https://example.test/health',environment:'staging'});
  assert.equal((await db.query('SELECT private_key_encrypted FROM project_deployment_ssh WHERE project_id=$1',[project])).rows[0].private_key_encrypted,'encrypted:private-key');
  assert.deepEqual((await db.query('SELECT status,message FROM deployment_runs WHERE id=$1',[run])).rows[0],
   {status:'running',message:'release underway'});
  assert.equal((await db.query('SELECT status FROM agent_sessions WHERE id=$1',[session])).rows[0].status,'running');
  assert.equal((await db.query('SELECT agents_running FROM projects WHERE id=$1',[project])).rows[0].agents_running,true);
  assert.equal((await db.query('SELECT status FROM task_deployment_records WHERE task_id=$1',[task])).rows[0].status,'automatic_verified');
  await assert.rejects(
   db.query("INSERT INTO deployment_runs(id,project_id,task_id,actor_id,sha,status) VALUES($1,$2,$3,$4,$5,'queued')",[randomUUID(),project,task,user,'b'.repeat(40)]),
   e=>e?.code==='23505'
  );
 });
});

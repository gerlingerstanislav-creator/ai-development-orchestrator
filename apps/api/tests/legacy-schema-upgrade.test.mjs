import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {applyLegacySchema,pauseAllProjectAgents} from '../dist/database/legacy-bootstrap.js';

const baseline={
 version:1,name:'legacy-schema-baseline',checksum:'ado-legacy-schema-baseline-v1',
 up:database=>applyLegacySchema(database,{analysis:'Системный анализ'})
};
async function withSchema(run){
 const name='ado_upgrade_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+name+'"');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+name,max:3});
 try{
  assert.equal((await db.query('SELECT current_schema() AS name')).rows[0].name,name);
  await run(db);
 }finally{
  await db.end();
  await admin.query('DROP SCHEMA "'+name+'" CASCADE');
  await admin.end();
 }
}

test('full baseline bootstraps fresh database transactionally and only once',async()=>{
 await withSchema(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,[baseline]),[1]);
  assert.deepEqual(await runSchemaMigrations(db,[baseline]),[]);
  const objects=await db.query(`SELECT
   to_regclass('users') IS NOT NULL AS users,
   to_regclass('tasks') IS NOT NULL AS tasks,
   to_regclass('documents') IS NOT NULL AS documents,
   to_regclass('schema_migrations') IS NOT NULL AS migrations`);
  assert.deepEqual(objects.rows[0],{users:true,tasks:true,documents:true,migrations:true});
 });
});

test('existing installation adoption preserves users, tasks and documentation',async()=>{
 await withSchema(async db=>{
  await applyLegacySchema(db,{analysis:'Системный анализ'});
  const user=randomUUID(),project=randomUUID(),task=randomUUID();
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[user,'legacy@example.test','hash-placeholder']);
  await db.query('INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,$2,$3,true)',[project,'Legacy project',user]);
  await db.query('INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,$3,$4)',[task,project,'Original task','Preserve description']);
  const before=await db.query('SELECT id,title,body,system_key FROM documents WHERE project_id=$1 ORDER BY id',[project]);
  assert.ok(before.rowCount>=5);
  assert.deepEqual(await runSchemaMigrations(db,[baseline]),[1]);
  assert.equal((await db.query('SELECT description FROM tasks WHERE id=$1',[task])).rows[0].description,'Preserve description');
  assert.equal((await db.query('SELECT name FROM projects WHERE id=$1',[project])).rows[0].name,'Legacy project');
  const after=await db.query('SELECT id,title,body,system_key FROM documents WHERE project_id=$1 ORDER BY id',[project]);
  assert.deepEqual(after.rows,before.rows);
  // Runtime policy must remain outside versioned DDL and still execute per deployment.
  assert.equal((await db.query('SELECT agents_running FROM projects WHERE id=$1',[project])).rows[0].agents_running,true);
  await pauseAllProjectAgents(db);
  assert.equal((await db.query('SELECT agents_running FROM projects WHERE id=$1',[project])).rows[0].agents_running,false);
 });
});

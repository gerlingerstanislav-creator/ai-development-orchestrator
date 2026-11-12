import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';

test('versioned migrations are atomic, idempotent and detect schema drift in PostgreSQL',async()=>{
 const schema='ado_migrations_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 const first={version:1,name:'baseline',checksum:'baseline-v1',up:async db=>{
  await db.query('CREATE TABLE smoke_counter(id integer PRIMARY KEY)');
  await db.query('INSERT INTO smoke_counter(id) VALUES(1)');
 }};
 try{
  assert.deepEqual(await runSchemaMigrations(pool,[first]),[1]);
  assert.deepEqual(await runSchemaMigrations(pool,[first]),[]);
  const count=await pool.query('SELECT count(*)::int AS n FROM smoke_counter');
  assert.equal(count.rows[0].n,1);

  const failing={version:2,name:'feature',checksum:'feature-v1',up:async db=>{
   await db.query('CREATE TABLE failed_write(id integer)');
   throw new Error('forced migration failure');
  }};
  await assert.rejects(runSchemaMigrations(pool,[first,failing]),/forced migration failure/);
  const rows=await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.rows.map(row=>row.version),[1]);
  assert.equal((await pool.query("SELECT to_regclass('failed_write') AS table_name")).rows[0].table_name,null);
  const recovered={...failing,up:async db=>{await db.query('CREATE TABLE final_write(id integer)')}};
  assert.deepEqual(await runSchemaMigrations(pool,[first,recovered]),[2]);
  await assert.rejects(runSchemaMigrations(pool,[{...first,checksum:'mutated'},recovered]),/integrity mismatch/);
  await assert.rejects(runSchemaMigrations(pool,[first]),/Unknown schema migration version 2/);
 }finally{
  await pool.end();
  await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
  await admin.end();
 }
});

test('concurrent migrators serialize on the same advisory lock',async()=>{
 const schema='ado_migrations_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const opts={connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:2};
 const a=new pg.Pool(opts),b=new pg.Pool(opts);
 const migration={version:1,name:'single-flight',checksum:'once',up:async db=>{
  await db.query('CREATE TABLE single_flight(id integer PRIMARY KEY)');
  await new Promise(resolve=>setTimeout(resolve,75));
  await db.query('INSERT INTO single_flight(id) VALUES(1)');
 }};
 try{
  const results=await Promise.all([runSchemaMigrations(a,[migration]),runSchemaMigrations(b,[migration])]);
  assert.deepEqual(results.map(x=>x.length).sort(),[0,1]);
  assert.equal((await a.query('SELECT count(*)::int AS n FROM single_flight')).rows[0].n,1);
 }finally{
  await a.end();await b.end();
  await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
  await admin.end();
 }
});

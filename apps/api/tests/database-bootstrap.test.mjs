import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {initializeLegacyDatabase} from '../dist/database/legacy-bootstrap.js';

test('legacy bootstrap retains startup SQL ordering and admin initialization',async()=>{
 const previous=process.env.ADMIN_PASSWORD;
 process.env.ADMIN_PASSWORD='bootstrap-test-secret-123';
 const statements=[];
 const db={query:async(sql,args=[])=>{
  statements.push({sql:String(sql),args});
  return {rows:[],rowCount:0};
 }};
 try{
  await initializeLegacyDatabase(db,{analysis:'Analysis stage'},'admin@example.test');
  assert.match(statements[0].sql,/CREATE TABLE IF NOT EXISTS users/);
  assert.ok(statements.some(s=>s.sql.includes('UPDATE projects SET agents_running=false')),'restart policy resets agent running state');
  const stage=statements.find(x=>x.sql.includes('UPDATE workflow_stages s SET description'));
  assert.ok(stage,'workflow descriptions must be backfilled');
  assert.deepEqual(stage.args,['analysis','Analysis stage']);
  const roots=statements.find(x=>x.sql.includes('CREATE OR REPLACE FUNCTION seed_document_roots'));
  const knowledge=statements.find(x=>x.sql.includes('CREATE TABLE IF NOT EXISTS knowledge_context_reads'));
  assert.ok(roots,'documentation roots are retained');
  assert.ok(knowledge,'knowledge schema is retained');
  assert.ok(statements.indexOf(roots)<statements.indexOf(knowledge));
  const admin=statements.find(x=>x.sql.includes('INSERT INTO users(id,email,password_hash)'));
  assert.ok(admin,'missing administrator is still created');
  assert.equal(admin.args[1],'admin@example.test');
  assert.equal(await bcrypt.compare('bootstrap-test-secret-123',admin.args[2]),true);
 }finally{
  if(previous===undefined)delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD=previous;
 }
});

test('legacy bootstrap rejects an insecure administrator password',async()=>{
 const previous=process.env.ADMIN_PASSWORD;
 process.env.ADMIN_PASSWORD='short';
 const db={query:async()=>({rows:[],rowCount:0})};
 try{
  await assert.rejects(initializeLegacyDatabase(db,{},'admin@example.test'),/ADMIN_PASSWORD/);
 }finally{
  if(previous===undefined)delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD=previous;
 }
});

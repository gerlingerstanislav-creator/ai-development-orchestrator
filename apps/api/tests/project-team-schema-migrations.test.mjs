import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {coreSchemaMigrations} from '../dist/database/core-migrations.js';
import {runSchemaMigrations} from '../dist/database/schema-migrations.js';
import {initProjectTeamSchema,reconcileProjectTeamProfiles} from '../dist/project-team.js';
const migrations=coreSchemaMigrations({analysis:'Аналитика'});
async function isolated(fn){
 const schema='ado_team_v10_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:3});
 try{await fn(pool);}
 finally{await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
}

test('fresh v10 schema installs team roles, instruction audit and memory provenance without changing defaults',async()=>{
 await isolated(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations),[1,2,3,4,5,6,7,8,9,10]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  const tables=(await db.query(`SELECT
   to_regclass('project_conversation_agents') IS NOT NULL AS conversations,
   to_regclass('project_agent_models') IS NOT NULL AS models,
   to_regclass('project_role_capacity') IS NOT NULL AS capacity,
   to_regclass('agent_instruction_history') IS NOT NULL AS history,
   to_regclass('agent_memory_events') IS NOT NULL AS events,
   to_regclass('idx_agent_memory_run_learning') IS NOT NULL AS idempotency`)).rows[0];
  assert.ok(Object.values(tables).every(Boolean),JSON.stringify(tables));
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE version=10')).rows[0].checksum,
   'ado-project-team-profile-memory-v10');
  const user=randomUUID(),project=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'team-v10@example.test','hash')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id) VALUES($1,'New project',$2)",[project,user]);
  // Runtime policy seeds newly created projects; a one-time schema migration does not.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM project_conversation_agents WHERE project_id=$1',[project])).rows[0].n,0);
  await reconcileProjectTeamProfiles(db);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM project_conversation_agents WHERE project_id=$1',[project])).rows[0].n,2);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM project_specialist_agents WHERE project_id=$1 AND role='architect'",[project])).rows[0].n,1);
 });
});

test('v10 upgrade preserves manager edits, role capacity, session and learning audit',async()=>{
 await isolated(async db=>{
  assert.deepEqual(await runSchemaMigrations(db,migrations.filter(m=>m.version<=9)),[1,2,3,4,5,6,7,8,9]);
  const user=randomUUID(),project=randomUUID(),session=randomUUID(),memory=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'v10-existing@example.test','hash')",[user]);
  await db.query("INSERT INTO projects(id,name,owner_id,agents_running) VALUES($1,'Existing customer',$2,true)",[project,user]);
  // Previous APIs installed the full mixed initializer at startup.
  await initProjectTeamSchema(db);
  await db.query("UPDATE project_conversation_agents SET agent_name='Owner PM',agent_instructions='Owner-specific agent policy' WHERE project_id=$1 AND role='manager'",[project]);
  await db.query("INSERT INTO project_agent_models(project_id,role,model) VALUES($1,'manager','gpt-6.1-sol')",[project]);
  await db.query("INSERT INTO project_role_capacity(project_id,role,capacity) VALUES($1,'development',3)",[project]);
  await db.query("INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,status,expires_at) VALUES($1,$2,$3,'manager','team-v10-active','running',now()+interval '3 hours')",[session,project,user]);
  await db.query("INSERT INTO agent_memory(id,project_id,session_id,role,kind,body,status,origin) VALUES($1,$2,$3,'manager','rule','Retain custom learning','approved','owner')",[memory,project,session]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[10]);
  assert.deepEqual(await runSchemaMigrations(db,migrations),[]);
  assert.deepEqual((await db.query("SELECT agent_name,agent_instructions FROM project_conversation_agents WHERE project_id=$1 AND role='manager'",[project])).rows[0],
   {agent_name:'Owner PM',agent_instructions:'Owner-specific agent policy'});
  assert.equal((await db.query("SELECT capacity FROM project_role_capacity WHERE project_id=$1 AND role='development'",[project])).rows[0].capacity,3);
  assert.equal((await db.query("SELECT model FROM project_agent_models WHERE project_id=$1 AND role='manager'",[project])).rows[0].model,'gpt-6.1-sol');
  assert.equal((await db.query('SELECT status FROM agent_sessions WHERE id=$1',[session])).rows[0].status,'running');
  assert.deepEqual((await db.query('SELECT body,origin FROM agent_memory WHERE id=$1',[memory])).rows[0],{body:'Retain custom learning',origin:'owner'});
  assert.equal((await db.query('SELECT agents_running FROM projects WHERE id=$1',[project])).rows[0].agents_running,true);
  await reconcileProjectTeamProfiles(db);
  assert.deepEqual((await db.query("SELECT agent_name,agent_instructions FROM project_conversation_agents WHERE project_id=$1 AND role='manager'",[project])).rows[0],
   {agent_name:'Owner PM',agent_instructions:'Owner-specific agent policy'});
 });
});

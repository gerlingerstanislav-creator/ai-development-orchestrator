import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {proposeInstruction,reconcileInstructions} from '../dist/instruction-governance.js';
import {agentMemoryContext} from '../dist/agent-memory.js';

test('PM can target scoped owner instructions without overwriting approvals or creating duplicates',async t=>{
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
 await admin.connect();
 const schema='instruction_governance_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await db.query(`
 CREATE TABLE users(id uuid PRIMARY KEY);
 CREATE TABLE projects(id uuid PRIMARY KEY,owner_id uuid REFERENCES users(id));
 CREATE TABLE assistant_messages(id uuid PRIMARY KEY,project_id uuid,actor_id uuid,role text,channel text,body text);
 CREATE TABLE agent_memory(
  id uuid PRIMARY KEY,project_id uuid NOT NULL,role text NOT NULL,kind text NOT NULL,body text NOT NULL,
  evidence text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'recorded',origin text NOT NULL DEFAULT 'agent',
  author_id uuid,reviewed_at timestamptz,applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_message_id uuid,instruction_group_id uuid,supersedes_id uuid,created_at timestamptz NOT NULL DEFAULT now()
 );`);
 const owner=randomUUID(),other=randomUUID(),project=randomUUID(),message=randomUUID();
 await db.query('INSERT INTO users(id) VALUES($1),($2)',[owner,other]);
 await db.query('INSERT INTO projects(id,owner_id) VALUES($1,$2)',[project,owner]);
 const text='В Laravel-задачах применяй штатные инструменты фреймворка, если они доступны.';
 await db.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,channel,body) VALUES($1,$2,$3,'user','project',$4)",[message,project,owner,text]);
 const base={target_roles:['development'],text,applicability:{technology:'Laravel'},source_message_id:message,reason:'Прямое правило владельца'};
 const first=await proposeInstruction(db,project,base);
 assert.equal(first.results[0].status,'approved');
 assert.equal(first.needs_review,false);
 const repeat=await proposeInstruction(db,project,base);
 assert.equal(repeat.results[0].duplicate,true);
 assert.equal(repeat.results[0].id,first.results[0].id);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_memory')).rows[0].n,1);
 const remembered=await agentMemoryContext(db,project,'development','Изменение Laravel приложения');
 assert.match(remembered,/Применять только если технология: Laravel/);
 assert.match(remembered,/штатные инструменты/);
 const unrelated=await reconcileInstructions(db,project,['development'],'Используй встроенные средства',{technology:'Node.js'});
 assert.deepEqual(unrelated,[],'rules for different technologies must not conflict');
 const edited=await proposeInstruction(db,project,{...base,text:'В Laravel-задачах предпочитай встроенные инструменты фреймворка, когда это возможно.'});
 assert.equal(edited.results[0].status,'proposed','PM paraphrases require approval');
 const outsiderMessage=randomUUID();
 await db.query("INSERT INTO assistant_messages(id,project_id,actor_id,role,channel,body) VALUES($1,$2,$3,'user','project',$4)",
  [outsiderMessage,project,other,'Для анализа проекта следует использовать имеющиеся документы.']);
 const outsider=await proposeInstruction(db,project,{target_roles:['analysis'],text:'Для анализа проекта следует использовать имеющиеся документы.',applicability:{},source_message_id:outsiderMessage,reason:''});
 assert.equal(outsider.results[0].status,'proposed','non-owners do not bypass review');
 await assert.rejects(proposeInstruction(db,project,{...base,source_message_id:randomUUID()}),/Источник должен быть реальным/);
});

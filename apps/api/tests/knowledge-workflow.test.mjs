import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {initKnowledgeWorkflow,buildKnowledgeContext} from '../dist/knowledge-workflow.js';

test('scoped mandatory instructions, task-linked knowledge, token budget and auditable snapshots',async t=>{
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});
 await client.connect();
 let open=false;
 t.after(async()=>{if(open)await client.query('ROLLBACK');await client.end();});
 await client.query('BEGIN');open=true;
 const schema='knowledgeflow_'+randomUUID().replaceAll('-','');
 await client.query('CREATE SCHEMA '+schema);
 await client.query('SET LOCAL search_path TO '+schema+',public');
 await client.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  "CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,body text,knowledge_summary text DEFAULT '',knowledge_tags text[] DEFAULT '{}',knowledge_status text DEFAULT 'approved',knowledge_key text,updated_at timestamptz DEFAULT now())",
  'CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,description text,pr_url text)',
  "CREATE TABLE project_rules(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),body text,created_at timestamptz DEFAULT now())",
  'CREATE TABLE workflow_stages(project_id uuid,stage text,agent_name text,agent_instructions text)',
  "CREATE TABLE knowledge_context_snapshots(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),task_id uuid REFERENCES tasks(id),agent_stage text,agent_session_id uuid,sources jsonb,instructions jsonb,created_at timestamptz DEFAULT now())",
  "CREATE TABLE knowledge_context_reads(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),task_id uuid REFERENCES tasks(id),document_id uuid REFERENCES documents(id),document_version text,agent_stage text,created_at timestamptz DEFAULT now())"
 ].join(';\n')+';');
 const db={query:(...args)=>client.query(...args)};
 await initKnowledgeWorkflow(db);
 await initKnowledgeWorkflow(db);
 const project=randomUUID(),other=randomUUID(),task=randomUUID(),doc=randomUUID(),unrelated=randomUUID();
 await client.query('INSERT INTO projects(id) VALUES($1),($2)',[project,other]);
 await client.query("INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'Настройка платежей','Сохранение операции должно быть атомарным')",[task,project]);
 await client.query("INSERT INTO documents(id,project_id,title,body,knowledge_summary) VALUES($1,$2,'Платежи','## API платежей\nДоступ к операциям','Финансовые требования'),($3,$2,'Отпуска','Отпускные заявки','Отпуска')",[doc,project,unrelated]);
 await client.query('INSERT INTO project_rules(id,project_id,body) VALUES($1,$2,$3)',[randomUUID(),project,'Не публикуй секреты']);
 await client.query("INSERT INTO workflow_stages(project_id,stage,agent_name,agent_instructions) VALUES($1,'development','Разработчик','Соблюдать код-стайл')",[project]);
 await client.query("INSERT INTO knowledge_instruction_modules(id,project_id,title,body,stage,tags,mandatory,status) VALUES($1,$2,'Правила БД','Обязательные транзакции','development',ARRAY['postgres'],true,'approved'),($3,$2,'Кэш','Условия Redis','development',ARRAY['redis'],false,'approved'),($4,$2,'Чужая роль','Не подходит тестировщику','testing',ARRAY[]::text[],true,'approved')",[randomUUID(),project,randomUUID(),randomUUID()]);
 await client.query("INSERT INTO knowledge_task_links(id,project_id,document_id,task_id,relation) VALUES($1,$2,$3,$4,'requires')",[randomUUID(),project,doc,task]);
 const context=await buildKnowledgeContext(db,{projectId:project,taskId:task,stage:'development',processId:randomUUID(),tags:[],budgetChars:2400,includeBodies:true});
 assert.ok(context.instructions.mandatory_rules.some(x=>x.body==='Не публикуй секреты'));
 assert.ok(context.instructions.modules.some(x=>x.title==='Правила БД'));
 assert.ok(!context.instructions.modules.some(x=>x.title==='Кэш'));
 assert.ok(!context.instructions.modules.some(x=>x.title==='Чужая роль'));
 assert.ok(context.documents.some(x=>x.id===doc));
 assert.ok(!context.documents.some(x=>x.id===unrelated));
 assert.equal(context.documents[0].version.length>15,true);
 assert.equal((await client.query('SELECT count(*)::int n FROM knowledge_context_snapshots WHERE task_id=$1',[task])).rows[0].n,1);
 assert.equal((await client.query('SELECT process_id FROM knowledge_context_snapshots WHERE id=$1',[context.snapshot_id])).rows[0].process_id!==null,true);
 await assert.rejects(buildKnowledgeContext(db,{projectId:other,taskId:task,stage:'analysis'}),/не найдена/);
 await client.query('ROLLBACK');open=false;
});

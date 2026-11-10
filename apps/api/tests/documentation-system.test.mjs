import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {initDocumentationSystem,DOCUMENT_ROOTS} from '../dist/documentation-system.js';

test('new project roots, repeat migration, legacy links and server-side guard',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 let open=false;
 t.after(async()=>{if(open)await db.query('ROLLBACK');await db.end();});
 await db.query('BEGIN');open=true;
 const schema='docmig_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET LOCAL search_path TO '+schema+',public');
 await db.query(`
  CREATE TABLE projects(id uuid PRIMARY KEY);
  CREATE TABLE documents(
   id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),
   title text NOT NULL,body text NOT NULL DEFAULT '',parent_id uuid,
   import_source text,updated_at timestamptz DEFAULT now());
  CREATE TABLE document_import_jobs(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id));
  CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),
   title text NOT NULL,description text NOT NULL DEFAULT '',type text NOT NULL DEFAULT 'task',
   stage text NOT NULL DEFAULT 'backlog',position int DEFAULT 0,
   created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE documentation_questions(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),
   job_id uuid REFERENCES document_import_jobs(id),topic_key text,question_key text,
   document_id uuid REFERENCES documents(id),question text,answer text,status text DEFAULT 'open',
   created_at timestamptz NOT NULL DEFAULT now(),answered_at timestamptz,
   UNIQUE(project_id,document_id,question_key));
 `);
 const project=randomUUID(),root=randomUUID(),legacy=randomUUID(),child=randomUUID(),legacySpec=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[project]);
 await db.query("INSERT INTO documents(id,project_id,title,body,parent_id,import_source) VALUES($1,$2,'Техническое задание','# Согласованное',NULL,NULL),($3,$2,'Старая заметка','# Осталась',NULL,NULL),($4,$2,'Вложенный сценарий','Описание',$3,NULL),($5,$2,'ТЗ предзаказа','# Условия',NULL,'legacy:coffee')",[root,project,legacy,child,legacySpec]);
 // Existing installations can have many documentation-only question records.
 await db.query("INSERT INTO documentation_questions(id,project_id,topic_key,question_key,document_id,question,status,answer) SELECT gen_random_uuid(),$1,'topic','q-'||g,$2,'Вопрос '||g,CASE WHEN g=1 THEN 'answered' ELSE 'open' END,CASE WHEN g=1 THEN 'Ответ' ELSE NULL END FROM generate_series(1,105) g",[project,legacySpec]);
 const legacyQuestion=(await db.query("SELECT id FROM documentation_questions WHERE project_id=$1 AND question_key='q-1'",[project])).rows[0].id;
 const pool={query:(...args)=>db.query(...args)};
 await initDocumentationSystem(pool);
 assert.equal((await db.query("SELECT to_regclass('documentation_questions') AS legacy")).rows[0].legacy,null);
 const migrated=await db.query("SELECT id,question_status,question_answer,document_id FROM tasks WHERE project_id=$1 AND type='question' ORDER BY question_key",[project]);
 assert.equal(migrated.rowCount,105,'All existing questions must become task records');
 assert.equal(migrated.rows.find(x=>x.id===legacyQuestion).question_answer,'Ответ');
 assert.equal(migrated.rows.find(x=>x.id===legacyQuestion).question_status,'answered');
 assert.equal(migrated.rows.every(x=>x.document_id===legacySpec),true);
 const rows=(await db.query('SELECT id,title,parent_id,system_key,body FROM documents WHERE project_id=$1 ORDER BY system_key',[project])).rows;
 assert.equal(rows.filter(x=>x.parent_id===null).length,5);
 assert.deepEqual(rows.filter(x=>x.system_key).map(x=>x.title).sort(),DOCUMENT_ROOTS.map(x=>x.title).sort());
 assert.equal(rows.find(x=>x.system_key==='spec').id,root,'Adopt legacy root without changing UUID');
 const research=rows.find(x=>x.system_key==='research');
 assert.equal(rows.find(x=>x.id===legacy).parent_id,research.id);
 assert.equal(rows.find(x=>x.id===child).parent_id,legacy);
 assert.equal(rows.find(x=>x.id===legacySpec).parent_id,root,'Clear legacy specification is filed under specification');
 assert.equal((await db.query('SELECT import_source FROM documents WHERE id=$1',[legacySpec])).rows[0].import_source,'legacy:coffee');
 assert.equal(rows.find(x=>x.id===root).body,'# Согласованное');
 await initDocumentationSystem(pool);
 assert.equal((await db.query("SELECT count(*)::int n FROM tasks WHERE project_id=$1 AND type='question'",[project])).rows[0].n,105,'Repeat migration must not duplicate questions');
 const after=(await db.query('SELECT id,system_key FROM documents WHERE project_id=$1',[project])).rows;
 assert.equal(after.length,8,'Repeat migration must not create duplicate roots');
 assert.equal(after.find(x=>x.system_key==='spec').id,root);
 const other=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[other]);
 assert.equal((await db.query("SELECT count(*)::int n FROM documents WHERE project_id=$1 AND system_key IS NOT NULL",[other])).rows[0].n,5);
 const rejected=async(query,params)=>{
  await db.query('SAVEPOINT guard_check');
  await assert.rejects(db.query(query,params),e=>e.code==='23514');
  await db.query('ROLLBACK TO SAVEPOINT guard_check');
 };
 await rejected("UPDATE documents SET title='Новый заголовок' WHERE id=$1",[root]);
 await rejected('UPDATE documents SET parent_id=$2 WHERE id=$1',[root,research.id]);
 await rejected('DELETE FROM documents WHERE id=$1',[root]);
 await rejected("INSERT INTO documents(id,project_id,title,parent_id) VALUES($1,$2,'Новый корень',NULL)",[randomUUID(),project]);
 await db.query('UPDATE documents SET body=$2 WHERE id=$1',[root,'Изменённое содержимое системного корня']);
 assert.equal((await db.query('SELECT body FROM documents WHERE id=$1',[root])).rows[0].body,'Изменённое содержимое системного корня');
 await db.query('UPDATE documents SET parent_id=$2 WHERE id=$1',[legacy,root]);
 assert.equal((await db.query('SELECT parent_id FROM documents WHERE id=$1',[legacy])).rows[0].parent_id,root);
 await db.query('ROLLBACK');open=false;
});
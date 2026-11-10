import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {initDocumentationSystem} from '../dist/documentation-system.js';
import {initKnowledgeContext,registerKnowledgeContextRoutes} from '../dist/knowledge-context.js';

test('Knowledge Context migration is idempotent and retrieval is project scoped',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 let opened=false;
 t.after(async()=>{await app.close();if(opened)await db.query('ROLLBACK');await db.end();});
 await db.query('BEGIN');opened=true;
 const schema='knowledge_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET LOCAL search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  "CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),title text NOT NULL,body text NOT NULL DEFAULT '',parent_id uuid,updated_at timestamptz DEFAULT now(),import_source text)",
  'CREATE TABLE document_import_jobs(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id))',
  'CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),title text,description text,type text DEFAULT \'task\',stage text DEFAULT \'backlog\',position int DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())',
  'CREATE TABLE document_versions(id uuid PRIMARY KEY,document_id uuid REFERENCES documents(id),body text NOT NULL,created_at timestamptz DEFAULT now())'
 ].join(';\n')+';');
 const p=randomUUID(),foreign=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1),($2)',[p,foreign]);
 const pool={query:(...args)=>db.query(...args),connect:async()=>({
  query:(sql,...args)=>sql==='BEGIN'?db.query('SAVEPOINT restore_knowledge'):
    sql==='COMMIT'?db.query('RELEASE SAVEPOINT restore_knowledge'):
    sql==='ROLLBACK'?db.query('ROLLBACK TO SAVEPOINT restore_knowledge'):db.query(sql,...args),
  release(){}
 })};
 await initDocumentationSystem(pool);
 const spec=(await db.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='spec'",[p])).rows[0];
 const docId=randomUUID();
 await db.query('INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,$3,$4,$5)',
  [docId,p,'Workflow переходы','## Обратный переход\nИз тестирования в разработку',spec.id]);
 await initKnowledgeContext(pool);
 await initKnowledgeContext(pool);
 assert.equal((await db.query('SELECT count(*)::int n FROM documents WHERE project_id=$1 AND knowledge_key IS NOT NULL',[p])).rows[0].n,8);
 assert.match((await db.query('SELECT body FROM documents WHERE id=$1',[docId])).rows[0].body,/Обратный/);
 const newer=randomUUID();
 await db.query('INSERT INTO projects(id) VALUES($1)',[newer]);
 assert.equal((await db.query('SELECT count(*)::int n FROM documents WHERE project_id=$1 AND knowledge_key IS NOT NULL',[newer])).rows[0].n,8);
 registerKnowledgeContextRoutes(app,{pool,access:async()=>true,requireAdmin:async()=>true});
 const search=await app.inject({url:'/api/projects/'+p+'/knowledge/search?q=Workflow'});
 assert.equal(search.statusCode,200,search.body);
 assert.ok(search.json().results.some(row=>row.id===docId));
 const sections=await app.inject({url:'/api/projects/'+p+'/knowledge/documents/'+docId+'/sections'});
 assert.equal(sections.statusCode,200,sections.body);
 const stableId=sections.json().sections[0].id;
 assert.match(stableId,/^[0-9a-f-]{36}$/);
 const one=await app.inject({url:'/api/projects/'+p+'/knowledge/documents/'+docId+'/sections/'+stableId});
 assert.match(one.json().body,/тестирования/);
 await db.query('UPDATE documents SET body=$2 WHERE id=$1',[docId,'Вступление перед разделом\n\n## Обратный переход\nИз тестирования в разработку']);
 const refreshed=await app.inject({url:'/api/projects/'+p+'/knowledge/documents/'+docId+'/sections'});
 assert.equal(refreshed.json().sections[0].id,stableId,'Раздел сохраняет ID после сдвига строк');
 const otherRoot=(await db.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='spec'",[foreign])).rows[0];
 const bad=await app.inject({method:'POST',url:'/api/projects/'+p+'/knowledge/links',payload:{
  source_document_id:docId,target_document_id:otherRoot.id,relation:'related_to'
 }});
 assert.equal(bad.statusCode,400,bad.body);
 const good=await app.inject({method:'POST',url:'/api/projects/'+p+'/knowledge/links',payload:{
  source_document_id:docId,target_document_id:spec.id,relation:'related_to'
 }});
 assert.equal(good.statusCode,201,good.body);
 const related=await app.inject({url:'/api/projects/'+p+'/knowledge/documents/'+docId+'/related'});
 assert.equal(related.json().results.length,1);

 const before=(await db.query('SELECT updated_at,body FROM documents WHERE id=$1',[docId])).rows[0];
 const revision=randomUUID();
 await db.query('INSERT INTO document_versions(id,document_id,body) VALUES($1,$2,$3)',
  [revision,docId,'## Предыдущая редакция\nПервоначальное правило']);
 const restore=await app.inject({method:'POST',url:'/api/projects/'+p+'/knowledge/documents/'+docId+'/versions/'+revision+'/restore',
  payload:{expected_version:new Date(before.updated_at).toISOString()}});
 assert.equal(restore.statusCode,200,restore.body);
 assert.equal(restore.json().changed,true);
 assert.match((await db.query('SELECT body FROM documents WHERE id=$1',[docId])).rows[0].body,/Первоначальное/);
 assert.ok((await db.query('SELECT count(*)::int n FROM document_versions WHERE document_id=$1',[docId])).rows[0].n>=3);
 const conflict=await app.inject({method:'POST',url:'/api/projects/'+p+'/knowledge/documents/'+docId+'/versions/'+revision+'/restore',
  payload:{expected_version:new Date(before.updated_at).toISOString()}});
 assert.equal(conflict.statusCode,409,conflict.body);

 const deleted=await app.inject({method:'DELETE',url:'/api/projects/'+p+'/knowledge/links/'+good.json().id});
 assert.equal(deleted.statusCode,200,deleted.body);
 await db.query('ROLLBACK');opened=false;
});

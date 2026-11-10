import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {initKnowledgeDocumentUpdates,registerKnowledgeDocumentUpdateRoutes} from '../dist/knowledge-document-updates.js';

test('document proposals: approval versions body and finishes task only after review',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 let open=false;
 t.after(async()=>{await app.close();if(open)await db.query('ROLLBACK');await db.end();});
 await db.query('BEGIN');open=true;
 const schema='knowledgeupdates_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET LOCAL search_path TO '+schema+',public');
 await db.query([
  'CREATE TABLE users(id uuid PRIMARY KEY)',
  'CREATE TABLE projects(id uuid PRIMARY KEY)',
  'CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),body text,system_key text,updated_at timestamptz DEFAULT now())',
  'CREATE TABLE tasks(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),stage text,documentation_updated_at timestamptz,updated_at timestamptz DEFAULT now())',
  "CREATE TABLE document_versions(id uuid PRIMARY KEY,document_id uuid REFERENCES documents(id),task_ids jsonb NOT NULL DEFAULT jsonb_build_array(),body text,created_at timestamptz DEFAULT now())",
  'CREATE TABLE task_events(id uuid,task_id uuid,actor_id uuid,event text,detail text)'
 ].join(';\n')+';');
 const pool={query:(...args)=>db.query(...args),connect:async()=>({
  query:(query,...args)=>query==='BEGIN'?db.query('SAVEPOINT knowledge_approval'):
   query==='COMMIT'?db.query('RELEASE SAVEPOINT knowledge_approval'):
   query==='ROLLBACK'?db.query('ROLLBACK TO SAVEPOINT knowledge_approval'):db.query(query,...args),
  release(){}
 })};
 await initKnowledgeDocumentUpdates(pool);
 const p=randomUUID(),task=randomUUID(),doc=randomUUID(),actor=randomUUID(),proposal=randomUUID();
 await db.query('INSERT INTO users(id) VALUES($1)',[actor]);
 await db.query('INSERT INTO projects(id) VALUES($1)',[p]);
 await db.query("INSERT INTO tasks(id,project_id,stage,documentation_updated_at) VALUES($1,$2,'documentation',now())",[task,p]);
 await db.query("INSERT INTO documents(id,project_id,body) VALUES($1,$2,'Текст до обновления')",[doc,p]);
 const original=(await db.query('SELECT updated_at FROM documents WHERE id=$1',[doc])).rows[0].updated_at;
 await db.query('INSERT INTO knowledge_document_updates(id,project_id,document_id,task_ids,base_version,proposed_body,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [proposal,p,doc,[task],original,'Проверенное обновление','Слитый PR задачи']);
 registerKnowledgeDocumentUpdateRoutes(app,{pool,uid:()=>actor,access:async()=>true,requireAdmin:async()=>true});
 const approve=await app.inject({method:'POST',url:'/api/projects/'+p+'/knowledge/update-proposals/'+proposal+'/decision',payload:{decision:'approve'}});
 assert.equal(approve.statusCode,200,approve.body);
 assert.equal((await db.query('SELECT body FROM documents WHERE id=$1',[doc])).rows[0].body,'Проверенное обновление');
 assert.equal((await db.query('SELECT stage FROM tasks WHERE id=$1',[task])).rows[0].stage,'done');
 assert.equal((await db.query('SELECT count(*)::int n FROM document_versions WHERE document_id=$1',[doc])).rows[0].n,1);
 const duplicate=await app.inject({method:'POST',url:'/api/projects/'+p+'/knowledge/update-proposals/'+proposal+'/decision',payload:{decision:'approve'}});
 assert.equal(duplicate.statusCode,409,duplicate.body);
 await db.query('ROLLBACK');open=false;
});

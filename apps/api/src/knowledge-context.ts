import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {markdownSections,sectionBody} from './markdown-knowledge-sections.js';

const uuid=z.string().uuid();
/** Extend the current document tree in place. Never replace existing pages or IDs. */
export async function initKnowledgeContext(pool:Pool){
 await pool.query(String.raw`
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS knowledge_key text;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS knowledge_status text NOT NULL DEFAULT 'approved';
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS knowledge_summary text NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS knowledge_tags text[] NOT NULL DEFAULT '{}';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_knowledge_key ON documents(project_id,knowledge_key) WHERE knowledge_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_documents_knowledge_search ON documents USING gin(to_tsvector('simple',coalesce(title,'')||' '||coalesce(body,'')));
  CREATE INDEX IF NOT EXISTS idx_documents_knowledge_tags ON documents USING gin(knowledge_tags);
  CREATE TABLE IF NOT EXISTS knowledge_links(
   id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   source_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
   target_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
   relation text NOT NULL CHECK(relation IN ('related_to','depends_on','implements','describes','supersedes','tested_by')),
   created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,source_document_id,target_document_id,relation),
   CHECK(source_document_id<>target_document_id)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(project_id,target_document_id);
  CREATE TABLE IF NOT EXISTS knowledge_context_reads(
   id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
   document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
   document_version text NOT NULL,agent_stage text NOT NULL DEFAULT '',
   created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_reads_task ON knowledge_context_reads(project_id,task_id,created_at DESC);
  CREATE TABLE IF NOT EXISTS knowledge_context_snapshots(
   id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
   agent_stage text NOT NULL,agent_session_id uuid,
   sources jsonb NOT NULL DEFAULT '[]'::jsonb,
   instructions jsonb NOT NULL DEFAULT '{}'::jsonb,
   created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_snapshots_task ON knowledge_context_snapshots(project_id,task_id,created_at DESC);
 `);
 // Adopt pre-existing specification sections instead of creating duplicate pages.
 await pool.query(`
  UPDATE documents d SET knowledge_key=sections.key
  FROM documents root,
  (VALUES ('overview','01. Общие сведения'),('goals','02. Назначение и цели'),
  ('scope','03. Границы и состав системы'),('functional','04. Функциональные требования'),
  ('nonfunctional','05. Нефункциональные требования'),('integrations','06. Данные и интеграции'),
  ('constraints','07. Ограничения и допущения'),('acceptance','08. Критерии приёмки')) AS sections(key,title)
  WHERE root.project_id=d.project_id AND root.system_key='spec' AND d.parent_id=root.id
    AND d.title=sections.title AND d.knowledge_key IS NULL
    AND NOT EXISTS (SELECT 1 FROM documents existing WHERE existing.project_id=d.project_id AND existing.knowledge_key=sections.key)
 `);
 // Seed only missing headings, leaving existing ТЗ and user-authored content intact.
 await pool.query(`
  INSERT INTO documents(id,project_id,parent_id,title,body,knowledge_key,knowledge_status)
  SELECT gen_random_uuid(),p.id,root.id,section.title,'',section.key,'approved'
  FROM projects p
  JOIN documents root ON root.project_id=p.id AND root.system_key='spec'
  CROSS JOIN (VALUES
   ('overview','01. Общие сведения'),('goals','02. Назначение и цели'),
   ('scope','03. Границы и состав системы'),('functional','04. Функциональные требования'),
   ('nonfunctional','05. Нефункциональные требования'),('integrations','06. Данные и интеграции'),
   ('constraints','07. Ограничения и допущения'),('acceptance','08. Критерии приёмки')
  ) AS section(key,title)
  WHERE NOT EXISTS(SELECT 1 FROM documents d WHERE d.project_id=p.id AND d.knowledge_key=section.key)
  ON CONFLICT DO NOTHING
 `);
 // The existing project trigger creates the system roots. Populate their specification children on creation.
 await pool.query(`
  CREATE OR REPLACE FUNCTION seed_knowledge_spec_sections() RETURNS trigger AS $seed$
  BEGIN
   INSERT INTO documents(id,project_id,parent_id,title,body,knowledge_key,knowledge_status)
   SELECT gen_random_uuid(),NEW.project_id,NEW.id,s.title,'',s.key,'approved'
   FROM (VALUES ('overview','01. Общие сведения'),('goals','02. Назначение и цели'),
    ('scope','03. Границы и состав системы'),('functional','04. Функциональные требования'),
    ('nonfunctional','05. Нефункциональные требования'),('integrations','06. Данные и интеграции'),
    ('constraints','07. Ограничения и допущения'),('acceptance','08. Критерии приёмки')) AS s(key,title)
   ON CONFLICT DO NOTHING;
   RETURN NEW;
  END $seed$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_seed_knowledge_spec_sections ON documents;
  CREATE TRIGGER trg_seed_knowledge_spec_sections AFTER INSERT ON documents
  FOR EACH ROW WHEN (NEW.system_key='spec') EXECUTE FUNCTION seed_knowledge_spec_sections();
 `);
}
type Dependencies={pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>};
function documentShape(row:any,mode:'summary'|'full'){
 const base={id:row.id,parent_id:row.parent_id,title:row.title,summary:row.knowledge_summary||row.body.slice(0,360),status:row.knowledge_status,version:row.updated_at,tags:row.knowledge_tags};
 return mode==='full'?{...base,body:row.body}:base;
}
export function registerKnowledgeContextRoutes(app:FastifyInstance,d:Dependencies){
 const {pool,access,requireAdmin}=d;
 app.get('/api/projects/:id/knowledge/tree',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  const r=await pool.query('SELECT id,parent_id,title,system_key,knowledge_key,knowledge_status AS status,knowledge_summary AS summary FROM documents WHERE project_id=$1 ORDER BY title,id',[id]);
  return {documents:r.rows};
 });
 app.get('/api/projects/:id/knowledge/search',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  const args=z.object({q:z.string().trim().min(2).max(300),limit:z.coerce.number().int().min(1).max(30).default(10),status:z.enum(['approved','draft','review','obsolete','all']).default('approved')}).parse(req.query);
  const r=await pool.query(`
   SELECT id,parent_id,title,knowledge_summary,knowledge_status,knowledge_tags,updated_at,
    ts_rank_cd(to_tsvector('simple',title||' '||body),plainto_tsquery('simple',$2)) AS score,
    left(body,360) AS excerpt
   FROM documents
   WHERE project_id=$1 AND ($3='all' OR knowledge_status=$3)
    AND (to_tsvector('simple',title||' '||body) @@ plainto_tsquery('simple',$2)
       OR title ILIKE '%'||$2||'%' OR body ILIKE '%'||$2||'%'
       OR $2=ANY(knowledge_tags))
   ORDER BY score DESC,updated_at DESC LIMIT $4`,[id,args.q,args.status,args.limit]);
  return {results:r.rows.map(row=>({...documentShape({...row,body:row.excerpt},'summary'),score:Number(row.score),excerpt:row.excerpt}))};
 });
 app.get('/api/projects/:id/knowledge/documents/:documentId',async(req:any,reply)=>{
  const {id,documentId}=z.object({id:uuid,documentId:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  const {mode,task_id,agent_stage}=z.object({mode:z.enum(['summary','full']).default('summary'),task_id:uuid.optional(),agent_stage:z.string().max(60).default('')}).parse(req.query);
  const r=await pool.query('SELECT * FROM documents WHERE project_id=$1 AND id=$2',[id,documentId]);
  if(!r.rowCount)return reply.code(404).send({error:'Документ не найден'});
  if(task_id){const task=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[task_id,id]);if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});}
  await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,task_id??null,documentId,new Date(r.rows[0].updated_at).toISOString(),agent_stage]);
  return documentShape(r.rows[0],mode);
 });
 app.get('/api/projects/:id/knowledge/documents/:documentId/related',async(req:any,reply)=>{
  const {id,documentId}=z.object({id:uuid,documentId:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  const r=await pool.query(`SELECT k.id,k.relation,k.source_document_id,k.target_document_id,d.id AS related_document_id,d.title,d.knowledge_summary
   FROM knowledge_links k JOIN documents d ON d.id=CASE WHEN k.source_document_id=$2 THEN k.target_document_id ELSE k.source_document_id END AND d.project_id=$1
   WHERE k.project_id=$1 AND (k.source_document_id=$2 OR k.target_document_id=$2) ORDER BY k.created_at DESC LIMIT 100`,[id,documentId]);
  return {results:r.rows};
 });
 app.post('/api/projects/:id/knowledge/links',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const data=z.object({source_document_id:uuid,target_document_id:uuid,relation:z.enum(['related_to','depends_on','implements','describes','supersedes','tested_by'])}).parse(req.body);
  if(data.source_document_id===data.target_document_id)return reply.code(400).send({error:'Невозможно связать документ с самим собой'});
  const r=await pool.query(`INSERT INTO knowledge_links(id,project_id,source_document_id,target_document_id,relation)
  SELECT $1,$2,$3,$4,$5 WHERE (SELECT count(*) FROM documents WHERE project_id=$2 AND id=ANY(ARRAY[$3,$4]::uuid[]))=2
  ON CONFLICT(project_id,source_document_id,target_document_id,relation) DO UPDATE SET relation=EXCLUDED.relation RETURNING id`,
  [randomUUID(),id,data.source_document_id,data.target_document_id,data.relation]);
  if(!r.rowCount)return reply.code(400).send({error:'Оба документа должны принадлежать проекту'});
  return reply.code(201).send({id:r.rows[0].id});
 });
 app.patch('/api/projects/:id/knowledge/documents/:documentId/metadata',async(req:any,reply)=>{
  const {id,documentId}=z.object({id:uuid,documentId:uuid}).parse(req.params);if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const data=z.object({status:z.enum(['approved','draft','review','obsolete']).optional(),summary:z.string().max(1500).optional(),tags:z.array(z.string().trim().min(1).max(60)).max(30).optional()}).parse(req.body);
  const r=await pool.query(`UPDATE documents SET knowledge_status=COALESCE($3,knowledge_status),
   knowledge_summary=COALESCE($4,knowledge_summary),knowledge_tags=COALESCE($5,knowledge_tags),updated_at=now()
   WHERE project_id=$1 AND id=$2 RETURNING id`,[id,documentId,data.status??null,data.summary??null,data.tags??null]);
  if(!r.rowCount)return reply.code(404).send({error:'Документ не найден'});
  return {ok:true};
 });
 app.get('/api/projects/:id/knowledge/context-reads',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  const {task_id}=z.object({task_id:uuid}).parse(req.query);
  const r=await pool.query('SELECT document_id,document_version,agent_stage,process_id,created_at FROM knowledge_context_reads WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 200',[id,task_id]);return {results:r.rows};
 });
 app.delete('/api/projects/:id/knowledge/links/:linkId',async(req:any,reply)=>{
  const {id,linkId}=z.object({id:uuid,linkId:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const r=await pool.query('DELETE FROM knowledge_links WHERE id=$1 AND project_id=$2 RETURNING id',[linkId,id]);
  if(!r.rowCount)return reply.code(404).send({error:'Связь не найдена'});
  return {ok:true};
 });
 app.get('/api/projects/:id/knowledge/documents/:documentId/versions',async(req:any,reply)=>{
  const {id,documentId}=z.object({id:uuid,documentId:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const r=await pool.query('SELECT v.id,v.created_at,v.task_ids,left(v.body,260) AS excerpt FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.project_id=$1 AND d.id=$2 ORDER BY v.created_at DESC LIMIT 100',[id,documentId]);
  return {versions:r.rows};
 });
 app.get('/api/projects/:id/knowledge/documents/:documentId/sections',async(req:any,reply)=>{
  const {id,documentId}=z.object({id:uuid,documentId:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const r=await pool.query('SELECT body,updated_at FROM documents WHERE project_id=$1 AND id=$2',[id,documentId]);
  if(!r.rowCount)return reply.code(404).send({error:'Документ не найден'});
  const sections=markdownSections(documentId,String(r.rows[0].body));
  return {sections:sections.map(s=>({id:s.section_id,title:s.title,level:s.level,excerpt:sectionBody(r.rows[0].body,s).slice(0,240)})),version:r.rows[0].updated_at};
 });
 app.get('/api/projects/:id/knowledge/documents/:documentId/sections/:sectionId',async(req:any,reply)=>{
  const {id,documentId,sectionId}=z.object({id:uuid,documentId:uuid,sectionId:z.string().min(1).max(40)}).parse(req.params);
  if(!await access(req,reply,id))return;
  const r=await pool.query('SELECT body,updated_at FROM documents WHERE project_id=$1 AND id=$2',[id,documentId]);
  if(!r.rowCount)return reply.code(404).send({error:'Документ не найден'});
  const section=markdownSections(documentId,String(r.rows[0].body)).find(s=>s.section_id===sectionId||String(s.line)===sectionId);
  if(!section)return reply.code(404).send({error:'Раздел не найден'});
  return {document_id:documentId,section_id:section.section_id,title:section.title,body:sectionBody(String(r.rows[0].body),section),version:r.rows[0].updated_at};
 });
 app.get('/api/projects/:id/knowledge/spec/export',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const r=await pool.query(
   "WITH RECURSIVE tree AS (SELECT d.id,d.parent_id,d.title,d.body,0 AS depth,ARRAY[d.title]::text[] AS path FROM documents d WHERE d.project_id=$1 AND d.system_key='spec' UNION ALL SELECT child.id,child.parent_id,child.title,child.body,tree.depth+1,tree.path||child.title FROM documents child JOIN tree ON child.parent_id=tree.id WHERE child.project_id=$1 AND tree.depth<30) SELECT id,title,body,depth FROM tree ORDER BY path",
   [id]);
  if(!r.rowCount)return reply.code(404).send({error:'Структура ТЗ не найдена'});
  const markdown=r.rows.map((d:any)=>{
   const heading='#'.repeat(Math.min(6,Math.max(1,Number(d.depth)+1)))+' '+d.title;
   return heading+'\n\n'+(String(d.body||'').trim()||'_Содержание не заполнено_');
  }).join('\n\n');
  return {filename:'technical-specification.md',markdown,documents:r.rows.length};
 });

 app.post('/api/projects/:id/knowledge/documents/:documentId/versions/:versionId/restore',async(req:any,reply)=>{
  const {id,documentId,versionId}=z.object({id:uuid,documentId:uuid,versionId:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {expected_version}=z.object({expected_version:z.string().datetime({offset:true})}).parse(req.body);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const current=(await client.query('SELECT id,body,updated_at FROM documents WHERE project_id=$1 AND id=$2 FOR UPDATE',[id,documentId])).rows[0];
   if(!current){await client.query('ROLLBACK');return reply.code(404).send({error:'Документ не найден'});}
   if(new Date(current.updated_at).toISOString()!==new Date(expected_version).toISOString()){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Документ изменился. Обнови страницу перед восстановлением.'});
   }
   const saved=(await client.query('SELECT body FROM document_versions WHERE id=$1 AND document_id=$2',[versionId,documentId])).rows[0];
   if(!saved){await client.query('ROLLBACK');return reply.code(404).send({error:'Версия не найдена'});}
   if(saved.body===current.body){
    await client.query('ROLLBACK');return {ok:true,changed:false,version:current.updated_at};
   }
   await client.query('INSERT INTO document_versions(id,document_id,body) VALUES($1,$2,$3)',[randomUUID(),documentId,current.body]);
   const updated=await client.query('UPDATE documents SET body=$1,updated_at=clock_timestamp() WHERE id=$2 AND project_id=$3 RETURNING updated_at',[saved.body,documentId,id]);
   await client.query('INSERT INTO document_versions(id,document_id,body) VALUES($1,$2,$3)',[randomUUID(),documentId,saved.body]);
   await client.query('COMMIT');
   return {ok:true,changed:true,version:updated.rows[0].updated_at};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
 });

 app.get('/api/projects/:id/knowledge/context-snapshots',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);if(!await access(req,reply,id))return;
  const {task_id}=z.object({task_id:uuid}).parse(req.query);
  const rows=await pool.query('SELECT id,task_id,agent_stage,agent_session_id,process_id,sources,instructions,created_at FROM knowledge_context_snapshots WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 100',[id,task_id]);
  return {snapshots:rows.rows};
 });

}

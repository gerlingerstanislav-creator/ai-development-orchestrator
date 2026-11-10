import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';

const uuid=z.string().uuid();
const CONFIRM='УДАЛИТЬ ДОКУМЕНТАЦИЮ';
type Deps={pool:Pool;uid:(req:any)=>string;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>};

export async function initDocumentationReset(pool:Pick<Pool,'query'>){
 await pool.query(String.raw`
 CREATE TABLE IF NOT EXISTS documentation_reset_intents(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  snapshot_digest text NOT NULL,
  pages int NOT NULL,
  imports int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  consumed_at timestamptz
 );
 CREATE INDEX IF NOT EXISTS idx_documentation_reset_intents_project
  ON documentation_reset_intents(project_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS documentation_reset_audit(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  deleted_pages int NOT NULL,deleted_imports int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
 );
 `);
}

async function docInventory(db:Pick<Pool,'query'>,projectId:string){
 const docs=await db.query('SELECT id,updated_at,title,system_key FROM documents WHERE project_id=$1 ORDER BY id',[projectId]);
 const imports=await db.query('SELECT id,updated_at,status FROM document_import_jobs WHERE project_id=$1 ORDER BY id',[projectId]);
 const active=imports.rows.filter((j:any)=>['queued','running'].includes(j.status));
 const pages=docs.rows.filter((d:any)=>d.system_key===null).length;
 const digest=createHash('sha256').update(JSON.stringify({docs:docs.rows,imports:imports.rows})).digest('hex');
 return {pages,roots:docs.rows.length-pages,imports:imports.rows.length,active_jobs:active.length,digest};
}

export function registerDocumentationResetRoutes(app:FastifyInstance,d:Deps){
 const {pool,uid,access,requireAdmin}=d;
 app.post('/api/projects/:id/documentation/reset/preview',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const project=(await pool.query('SELECT name FROM projects WHERE id=$1',[id])).rows[0];
  if(!project)return reply.code(404).send({error:'Проект не найден'});
  const inventory=await docInventory(pool,id);
  if(inventory.active_jobs)return reply.code(409).send({error:'Нельзя очищать документацию, пока выполняются процессы импорта или пересборки'});
  const intentId=randomUUID();
  await pool.query('INSERT INTO documentation_reset_intents(id,project_id,actor_id,snapshot_digest,pages,imports) VALUES($1,$2,$3,$4,$5,$6)',
   [intentId,id,uid(req),inventory.digest,inventory.pages,inventory.imports]);
  return {intent_id:intentId,project_name:project.name,pages:inventory.pages,imports:inventory.imports,
   roots_preserved:inventory.roots,confirmation_phrase:CONFIRM,
   warning:'Будут безвозвратно удалены пользовательские и импортированные страницы, вопросы документации, история версий и прежние записи импорта. Пять системных корневых разделов останутся пустыми; всю вложенную структуру затем создают агенты. Задачи, план разработки и проектные правила не удаляются.'};
 });
 app.post('/api/projects/:id/documentation/reset/confirm',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {intent_id,project_name,confirmation_phrase}=z.object({
   intent_id:uuid,project_name:z.string().min(1).max(300),
   confirmation_phrase:z.literal(CONFIRM)
  }).parse(req.body);
  const client=await pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
   // Serialise destructive operations and document updates under the project row.
   const project=(await client.query('SELECT name FROM projects WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!project){await client.query('ROLLBACK');return reply.code(404).send({error:'Проект не найден'});}
   const intent=(await client.query('SELECT * FROM documentation_reset_intents WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
    [intent_id,id,uid(req)])).rows[0];
   if(!intent||project_name!==project.name){await client.query('ROLLBACK');return reply.code(409).send({error:'Подтверждение устарело или имя проекта не совпадает'});}
   // Lock documents and import jobs, preventing concurrent edit/write during the reset.
   const docs=(await client.query('SELECT id,updated_at,title,system_key FROM documents WHERE project_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
   const imports=(await client.query('SELECT id,updated_at,status FROM document_import_jobs WHERE project_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
   if(imports.some((job:any)=>['queued','running'].includes(job.status))){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Во время подтверждения запущен процесс документации'});
   }
   const digest=createHash('sha256').update(JSON.stringify({docs,imports})).digest('hex');
   if(digest!==intent.snapshot_digest){await client.query('ROLLBACK');return reply.code(409).send({error:'Документация изменилась после просмотра. Сформируй новое подтверждение.'});}
   const deletedPages=docs.filter((doc:any)=>doc.system_key===null).length;
   // FK references to deleted pages cascade. System root guard remains enabled.
   // Leaf-first deletion avoids the ON DELETE SET NULL parent FK triggering the
   // project root guard on surviving child pages.
   let remaining=deletedPages;
   while(remaining>0){
    const removed=await client.query(
     'DELETE FROM documents d WHERE d.project_id=$1 AND d.system_key IS NULL AND NOT EXISTS (SELECT 1 FROM documents child WHERE child.parent_id=d.id) RETURNING id',[id]);
    if(!removed.rowCount)throw new Error('Документы содержат циклические ссылки. Очистка отменена без изменений.');
    remaining-=removed.rowCount;
   }
   await client.query("UPDATE documents SET body='',knowledge_summary='',knowledge_tags=ARRAY[]::text[],updated_at=clock_timestamp() WHERE project_id=$1 AND system_key IS NOT NULL",[id]);
   await client.query('DELETE FROM document_import_jobs WHERE project_id=$1',[id]);
   // The system owns only the stable top-level roots. Subsections belong to agents.
   // Never recreate an opinionated technical-spec template during a full reset.
   await client.query('UPDATE documentation_reset_intents SET consumed_at=now() WHERE id=$1',[intent_id]);
   await client.query('INSERT INTO documentation_reset_audit(id,project_id,actor_id,deleted_pages,deleted_imports) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(),id,uid(req),deletedPages,imports.length]);
   await client.query('COMMIT');
   return {ok:true,deleted_pages:deletedPages,deleted_imports:imports.length,remaining_system_roots:5,empty_spec_sections:0};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});
   if((error as any)?.code==='40001')return reply.code(409).send({error:'Во время очистки документы изменились. Повтори предварительный просмотр.'});
   throw error;}
  finally{client.release();}
 });
}

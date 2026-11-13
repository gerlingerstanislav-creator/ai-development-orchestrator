import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

/** Agent document editing. Persistence must use the caller's existing
 * PostgreSQL transaction so evidence and all changeset steps commit together. */
const uuid=z.string().uuid();
function rejected(message:string,statusCode=409){return Object.assign(new Error(message),{statusCode});}
export const createDoc=z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000).default(''),parent_id:uuid,
 idempotency_key:z.string().min(8).max(120).optional()});
export const updateDoc=z.object({document_id:uuid,expected_revision:z.string().datetime({offset:true}),title:z.string().trim().min(1).max(200).optional(),body:z.string().max(100000).optional(),parent_id:uuid.optional(),
 idempotency_key:z.string().min(8).max(120).optional()});
export const deleteDoc=z.object({document_id:uuid,expected_revision:z.string().datetime({offset:true}),
 idempotency_key:z.string().min(8).max(120).optional()});
export const documentRevision=(value:unknown)=>new Date(value as string).toISOString();
export async function parentExists(db:Pick<Pool,'query'>,projectId:string,id:string){
 return !!(await db.query('SELECT id FROM documents WHERE id=$1 AND project_id=$2',[id,projectId])).rowCount;
}
export async function createPage(db:Pick<Pool,'query'>,projectId:string,params:z.infer<typeof createDoc>){
 if(!await parentExists(db,projectId,params.parent_id))throw rejected('Родительская страница не найдена',404);
 const id=randomUUID();
 await db.query('INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,$3,$4,$5)',
  [id,projectId,params.title,params.body,params.parent_id]);
 return {id,title:params.title,parent_id:params.parent_id};
}
export async function updatePage(db:Pick<Pool,'query'>,projectId:string,params:z.infer<typeof updateDoc>){
 const old=(await db.query('SELECT id,title,body,parent_id,system_key,updated_at FROM documents WHERE project_id=$1 AND id=$2 FOR UPDATE',
  [projectId,params.document_id])).rows[0];
 if(!old)throw rejected('Страница не найдена',404);
 const title=params.title??old.title,parent=params.parent_id??old.parent_id;
 if(old.system_key&&(title!==old.title||parent!==old.parent_id))throw rejected('Системный раздел нельзя переименовать или переместить');
 if(![params.title,params.body,params.parent_id].some(x=>x!==undefined))throw rejected('Нет изменений',400);
 if(parent!==old.parent_id){
  if(!await parentExists(db,projectId,parent))throw rejected('Родительская страница не найдена',404);
  const ancestors=await db.query(
   'WITH RECURSIVE parents AS (SELECT id,parent_id FROM documents WHERE id=$1 AND project_id=$2 UNION ALL SELECT d.id,d.parent_id FROM documents d JOIN parents p ON p.parent_id=d.id WHERE d.project_id=$2) SELECT id FROM parents WHERE id=$3 LIMIT 1',
   [parent,projectId,params.document_id]);
  if(ancestors.rowCount)throw rejected('Нельзя переместить страницу в собственного потомка');
 }
 if(documentRevision(old.updated_at)!==documentRevision(params.expected_revision))throw rejected('Страница изменилась с момента чтения. Получи новую revision через documents.read.');
 const updated=await db.query(
  'UPDATE documents SET title=$3,body=$4,parent_id=$5,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2 RETURNING updated_at',
  [projectId,params.document_id,title,params.body??old.body,parent]);
 return {id:params.document_id,revision:documentRevision(updated.rows[0].updated_at)};
}
/** Only disposable unsourced leaf placeholders can be deleted.
 * MCP route persists the deletion and audit in the same transaction. */
export async function deleteEmptyPage(db:Pick<Pool,'query'>,projectId:string,params:z.infer<typeof deleteDoc>){
 const old=(await db.query(
  'SELECT id,body,system_key,import_source,source_refs,updated_at FROM documents WHERE id=$1 AND project_id=$2 FOR UPDATE',
  [params.document_id,projectId])).rows[0];
 if(!old)throw rejected('Страница не найдена',404);
 if(old.system_key)throw rejected('Системные разделы удалять нельзя');
 if(documentRevision(old.updated_at)!==documentRevision(params.expected_revision))
  throw rejected('Страница изменилась. Получи новую revision через documents.read.');
 if(String(old.body||'').trim())throw rejected('Нельзя удалить страницу с содержимым. Сначала перенеси и проверь информацию в выбранной структуре.');
 if(old.import_source||(Array.isArray(old.source_refs)&&old.source_refs.length))
  throw rejected('Нельзя удалить страницу, связанную с импортированными источниками.');
 if((await db.query('SELECT 1 FROM documents WHERE project_id=$1 AND parent_id=$2 LIMIT 1',[projectId,params.document_id])).rowCount)
  throw rejected('Нельзя удалить страницу с дочерними документами. Сначала перенеси их.');
 if((await db.query('SELECT 1 FROM tasks WHERE project_id=$1 AND document_id=$2 LIMIT 1',[projectId,params.document_id])).rowCount)
  throw rejected('Страница привязана к задачам. Сначала обнови эти связи.');
 if((await db.query('SELECT 1 FROM document_versions WHERE document_id=$1 LIMIT 1',[params.document_id])).rowCount)
  throw rejected('У страницы есть история версий. Удаление может уничтожить данные.');
 await db.query('DELETE FROM documents WHERE project_id=$1 AND id=$2',[projectId,params.document_id]);
 return {id:params.document_id,deleted:true};
}

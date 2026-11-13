import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

export type ImportedDraftInput={actorId:string;message:string;mode:'project'|'documentation'};
export type ImportedDraft={
 collection_title:string;sourceName:string;notes:string;sourcePaths:string[];
 documents:Array<{title:string;body:string;sources:string[]}>;
};
export type ImportedDraftResult={
 message:string;created_task_id:null;created_document_id:string;generated_documents:number;
};

/** Single transaction owns all generated pages, completion and chat writes.
 * Committed retries return the saved result; no partial documents are published. */
export function createImportedDraftStore(
 pool:Pool,
 recordImportMessages:(client:PoolClient,projectId:string,input:ImportedDraftInput,
  result:ImportedDraftResult,rootId:string)=>Promise<void>
){
 return async function saveImportedDraft(projectId:string,jobId:string,draft:ImportedDraft,sourceKey:string,input?:ImportedDraftInput){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const existing=(await client.query('SELECT status,result FROM document_import_jobs WHERE id=$1 AND project_id=$2 FOR UPDATE',[jobId,projectId])).rows[0];
   if(!existing)throw Error('Запуск аналитика не найден');
   if(existing.status==='completed'){await client.query('COMMIT');return existing.result;}
   if(existing.status!=='running')throw Error('Процесс аналитика остановлен; сохранение результата отменено');
   const parent=(await client.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='spec'",[projectId])).rows[0];
   if(!parent)throw Error('Не найден системный раздел ТЗ');
   const root=await client.query(
    "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,document_kind,implementation_status) VALUES($1,$2,$3,$4,$6,$5,'technical','unverified') ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,updated_at=now() RETURNING id",
    [randomUUID(),projectId,draft.collection_title,'# '+draft.collection_title+'\n\nИсточник: '+draft.sourceName+'\n\n'+draft.notes,sourceKey,parent.id]);
   const rootId:string=root.rows[0].id;
   for(const [idx,doc] of draft.documents.entries()){
    const sources=doc.sources.filter((name:string)=>draft.sourcePaths.includes(name));
    const body=doc.body+(sources.length?'\n\n---\n**Исходные материалы:** '+sources.join(', '):'');
    await client.query(
     "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,document_kind,implementation_status) VALUES($1,$2,$3,$4,$5,$6,'technical','unverified') ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,parent_id=EXCLUDED.parent_id,updated_at=now()",
     [randomUUID(),projectId,doc.title,body,rootId,sourceKey+'/generated/'+idx]);
   }
   const result={message:'ТЗ подготовлено. Страниц: '+draft.documents.length+'.'+(draft.notes?'\n\n'+draft.notes:''),created_task_id:null,created_document_id:rootId,generated_documents:draft.documents.length};
   // Transactional status means a failed chat save cannot mark an already committed import failed.
   await client.query("UPDATE document_import_jobs SET status='completed',message='Документация сохранена',result=$2,saved_documents=$3,updated_at=now() WHERE id=$1",
    [jobId,JSON.stringify(result),draft.documents.length]);
   if(input)await recordImportMessages(client,projectId,input,result,rootId);
   await client.query('COMMIT');
   return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
 }

}

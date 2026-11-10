import type {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';

export type DocumentationRootKey='spec'|'architecture'|'operations'|'design'|'research';
export type SourceFile={path:string;body:string};
export function sourceFingerprint(title:string,body:string){
 return createHash('sha256').update(title+'\n'+body).digest('hex');
}
function sha(text:string){return createHash('sha256').update(text).digest('hex');}

/** No source-dependent role or technology is assumed; ambiguous functional pages remain in ТЗ. */
export function suggestedRootForTopic(key:string,title:string):DocumentationRootKey{
 const text=(title+' '+key).toLowerCase().replace(/ё/g,'е');
 if(/исследован|рынок|конкурент|оценк|гипотез|market.?research|survey|benchmark|риски и предположения/.test(text))return 'research';
 if(/архитектур|интеграц|инфраструктур|api.?интеграц|pos.?систем|технические решения|security architecture/.test(text))return 'architecture';
 if(/эксплуатац|развертыван|развёртыван|запуск и настро|установк|мониторинг|runbook|deployment|devops/.test(text))return 'operations';
 if(/дизайн|интерфейс|ux\b|ui\b|прототип|макет|схема экран|вайрфрейм/.test(text))return 'design';
 return 'spec';
}

/**
 * Archive originals as source material, not as approved requirements.
 * Reimports preserve the same document IDs and never overwrite manual edits:
 * instead they create a review proposal.
 */
export async function archiveSourceDocuments(args:{
 pool:Pick<Pool,'query'|'connect'>;jobId:string;projectId:string;sourceKey:string;
 files:SourceFile[];location?:{owner:string;repository:string;commit:string};
 progress:(stage:string,message:string)=>Promise<void>;
}):Promise<{created:number;updated:number;conflicts:number}>{
 const {pool,jobId,projectId,sourceKey,files,location,progress}=args;
 const root=(await pool.query("SELECT id FROM documents WHERE project_id=$1 AND system_key='research'",[projectId])).rows[0];
 if(!root)throw Error('Нет системного раздела исходных материалов');
 let created=0,updated=0,conflicts=0;
 // A stable source folder keeps the navigation usable even for many original files.
 const folderSource='source-group:'+sourceKey;
 const folderTitle='Импорт · '+(sourceKey.split(':').pop()||'Материалы').slice(0,130);
 const folderBody='# Исходные материалы\n\nОригиналы документов, использованных при тематическом импорте. Не являются автоматически утверждёнными требованиями.';
 const folderId=randomUUID();
 await pool.query(
  "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,document_kind,implementation_status,import_synced_hash) VALUES($1,$2,$3,$4,$5,$6,'technical','unverified',$7) ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO NOTHING",
  [folderId,projectId,folderTitle,folderBody,root.id,folderSource,sourceFingerprint(folderTitle,folderBody)]);
 const group=(await pool.query("SELECT id FROM documents WHERE project_id=$1 AND import_source=$2",[projectId,folderSource])).rows[0];
 if(!group)throw Error('Не удалось сохранить группу исходных материалов');
 for(const file of files){
  const fileName=file.path.split('/').pop()||file.path;
  const title='Источник · '+fileName;
  const path=file.path;
  const url=location&&!path.startsWith('Вложение:')
   ?'https://github.com/'+location.owner+'/'+location.repository+'/blob/'+location.commit+'/'+path.split('/').map(encodeURIComponent).join('/')
   :null;
  const refs=[{path,heading:'Исходный документ',index:0,url}];
  const body='# '+title+'\n\n**Тип:** исходный материал (не утверждённое ТЗ).\n\n'+
   (url?'**Оригинал:** ['+path+']('+url+')\n\n':'**Источник:** '+path+'\n\n')+
   '---\n\n'+file.body;
  const source='source:'+sourceKey+':'+sha(path).slice(0,24);
  const fingerprint=sourceFingerprint(title,body);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const existing=(await client.query('SELECT id,title,body,import_synced_hash FROM documents WHERE project_id=$1 AND import_source=$2 FOR UPDATE',[projectId,source])).rows[0];
   if(existing){
    if(existing.import_synced_hash&&sourceFingerprint(existing.title,existing.body)===existing.import_synced_hash){
     if(existing.import_synced_hash!==fingerprint){
      await client.query('UPDATE documents SET title=$2,body=$3,source_refs=$4,import_synced_hash=$5,updated_at=now() WHERE id=$1',
       [existing.id,title,body,JSON.stringify(refs),fingerprint]);updated++;
     }
    }else if(existing.title!==title||existing.body!==body){
     await client.query(
      "INSERT INTO document_import_proposals(id,project_id,job_id,topic_key,document_id,title,proposed_body,base_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(job_id,topic_key) DO UPDATE SET title=EXCLUDED.title,proposed_body=EXCLUDED.proposed_body,base_hash=EXCLUDED.base_hash,status='open',decided_at=NULL",
      [randomUUID(),projectId,jobId,'source-'+sha(path).slice(0,24),existing.id,title,body,sourceFingerprint(existing.title,existing.body)]);
     conflicts++;
    }
   }else{
    await client.query(
     "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,document_kind,implementation_status,source_refs,import_synced_hash) VALUES($1,$2,$3,$4,$5,$6,'technical','unverified',$7,$8)",
     [randomUUID(),projectId,title,body,group.id,source,JSON.stringify(refs),fingerprint]);created++;
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 await progress('source_archive','Исходные материалы сохранены: '+files.length+' файлов, новых '+created+', конфликтов ручных правок '+conflicts);
 return {created,updated,conflicts};
}

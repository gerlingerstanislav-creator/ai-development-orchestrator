import type {Pool} from 'pg';
import {z} from 'zod';
import {randomUUID,createHash} from 'node:crypto';
import {completeStructured} from './structured-agent-response.js';
import type {DocumentationRootKey} from './documentation-import-structure.js';
import {archiveSourceDocuments} from './documentation-import-structure.js';
import {extractGitHubDocumentLocation} from './github-document-import.js';

const section=z.enum(['spec','architecture','operations','design','research']);
const item=z.object({
 id:z.string().uuid(),
 section,
 group:z.string().trim().min(3).max(80).nullable().default(null)
});
const planSchema=z.object({items:z.array(item).max(120)});
type Reply={text:string;usage?:{input_tokens:number;cached_input_tokens:number;output_tokens:number}};
type Db=Pick<Pool,'query'|'connect'>;

function groupKey(section:string,title:string){
 return 'structure:'+section+':'+createHash('sha256').update(title.toLowerCase().replace(/ё/g,'е').trim()).digest('hex').slice(0,20);
}

/**
 * Only imported thematic pages are reorganized. Does not edit/rename their
 * content, UUID, source linkage or accepted product-owner decisions.
 * Existing user-created pages are not participants in the plan.
 */
export async function organizeImportedDocumentation(args:{
 pool:Db;job:{id:string;project_id:string;actor_id:string;request_text:string;status:string};
 complete:(prompt:string)=>Promise<Reply>;
 recordUsage:(usage:Reply['usage'])=>Promise<void>;
 progress:(stage:string,message:string)=>Promise<void>;
}){
 const {pool,job,complete,recordUsage,progress}=args;
 const projectId=job.project_id;
 const roots=(await pool.query('SELECT id,system_key FROM documents WHERE project_id=$1 AND system_key IS NOT NULL',[projectId])).rows;
 const bySection=new Map<string,string>(roots.map(r=>[r.system_key,r.id]));
 if(bySection.size!==5)throw Error('Недоступны все пять системных разделов документации');
 const documents=(await pool.query(
  "SELECT id,title,body,parent_id,import_source,source_refs FROM documents WHERE project_id=$1 AND import_source LIKE 'topic:%' ORDER BY title,id LIMIT 120",
  [projectId])).rows;
 // Older imports predate raw-source archiving. Backfill from the exact pinned
 // snapshots kept in PostgreSQL; no re-download, new import or lost exclusions.
 const historical=(await pool.query(
  "SELECT source_key,source_snapshot,source_url,source_commit FROM document_import_jobs WHERE project_id=$1 AND source_snapshot IS NOT NULL AND id<>$2 ORDER BY updated_at DESC LIMIT 10",
  [projectId,job.id])).rows;
 for(const source of historical){
  const files=source.source_snapshot;
  if(!Array.isArray(files)||!files.length||files.length>300||
   !files.every((file:any)=>typeof file.path==='string'&&typeof file.body==='string'))continue;
  const address=source.source_url?extractGitHubDocumentLocation(String(source.source_url)):null;
  const location=address&&source.source_commit?{
   owner:address.owner,repository:address.repository,commit:String(source.source_commit)
  }:undefined;
  await archiveSourceDocuments({
   pool,jobId:job.id,projectId,sourceKey:source.source_key,files,location,progress
  });
 }

 if(!documents.length)throw Error('В проекте нет импортированных тематических страниц для реорганизации');
 const knownIds=new Set(documents.map(d=>d.id));
 const summaries=documents.map(d=>({
  id:d.id,title:d.title,length:String(d.body||'').length,
  excerpt:String(d.body||'').slice(0,700),
  sources:(Array.isArray(d.source_refs)?d.source_refs:[]).slice(0,7).map((ref:any)=>({file:ref.path,heading:ref.heading}))
 }));
 await progress('structure_review','Аналитик изучает структуру и назначение '+documents.length+' импортированных тематических страниц');
 const prompt=[
  'Ты системный аналитик. Улучши НАВИГАЦИОННУЮ структуру существующих проектных документов без изменения их содержания.',
  'Для каждого документа выбери ровно один из пяти системных разделов:',
  'spec — техническое задание и функциональные требования; architecture — инженерные и интеграционные решения;',
  'operations — запуск, поддержка, развёртывание; design — интерфейсы, пользовательский опыт и макеты;',
  'research — исходные исследования, гипотезы, рыночная оценка и альтернативы.',
  'Внутри системного раздела можешь назначить осмысленную группу страниц (group).',
  'Группа должна описывать бизнес-подсистему или пользовательскую роль, а не исходный файл.',
  'Не создавай группы ради единственной страницы. Для слабосвязанных страниц указывай group:null.',
  'Не подменяй документ гипотезой, не придумывай новые документы и не смешивай технические решения с ТЗ.',
  'В JSON верни ВСЕ переданные id строго один раз: {"items":[{"id":"UUID","section":"spec","group":"Клиентское приложение или null"}]}.',
  'Документы, фрагменты и источники:\n'+JSON.stringify(summaries).slice(0,18000)
 ].join('\n\n');
 const data=await completeStructured({
  prompt,schema:planSchema,label:'структура документации',
  formatExample:'{"items":[{"id":"UUID существующей страницы","section":"spec","group":null}]}',
  complete,recordUsage,progress
 });
 const planned=new Map<string,{section:DocumentationRootKey;group:string|null}>();
 for(const row of data.items){
  if(!knownIds.has(row.id)||planned.has(row.id))throw Error('Аналитик предложил неизвестную или дублирующуюся страницу документации');
  planned.set(row.id,{section:row.section,group:row.group});
 }
 if(planned.size!==documents.length)throw Error('В плане реорганизации отсутствуют некоторые страницы; изменения не применены');
 const grouped=new Map<string,string[]>();
 for(const [id,placement] of planned){
  if(!placement.group)continue;
  const key=groupKey(placement.section,placement.group);
  grouped.set(key,[...(grouped.get(key)||[]),id]);
 }
 const client=await pool.connect();
 let moved=0,createdGroups=0,skippedManual=0;
 try{
  await client.query('BEGIN');
  const live=(await client.query("SELECT status FROM document_import_jobs WHERE id=$1 AND project_id=$2 FOR UPDATE",[job.id,projectId])).rows[0];
  if(!live||live.status!=='running')throw Error('Процесс организации документации больше не активен');
  // A group folder is needed only if it contains at least two topic pages.
  const folderIds=new Map<string,string>();
  for(const [key,ids] of grouped){
   if(ids.length<2)continue;
   const placement=planned.get(ids[0])!;
   const title=placement.group!;
   const folderSource=key;
   let folder=(await client.query('SELECT id,parent_id FROM documents WHERE project_id=$1 AND import_source=$2 FOR UPDATE',[projectId,folderSource])).rows[0];
   if(!folder){
    const newId=randomUUID();
    await client.query(
     "INSERT INTO documents(id,project_id,title,body,parent_id,import_source,document_kind,implementation_status) VALUES($1,$2,$3,$4,$5,$6,'technical','unverified')",
     [newId,projectId,title,'# '+title+'\n\nНавигационный раздел тематической документации.',bySection.get(placement.section),folderSource]);
    folder={id:newId,parent_id:bySection.get(placement.section)};createdGroups++;
   }
   folderIds.set(key,folder.id);
  }
  const documentIds=documents.map(d=>d.id);
  const fresh=(await client.query("SELECT id,parent_id FROM documents WHERE project_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE",[projectId,documentIds])).rows;
  const current=new Map<string,string>(fresh.map(d=>[d.id,d.parent_id]));
  const rootsSet=new Set(bySection.values());
  const autoParents=(await client.query(
   "SELECT id FROM documents WHERE project_id=$1 AND import_source LIKE 'structure:%'",[projectId])).rows;
  const autoSet=new Set<string>(autoParents.map(row=>row.id));
  for(const doc of documents){
   const target=planned.get(doc.id)!;
   const group=target.group?groupKey(target.section,target.group):null;
   const targetParent=group&&folderIds.has(group)?folderIds.get(group)!:bySection.get(target.section)!;
   const currentParent=current.get(doc.id);
   if(!currentParent){skippedManual++;continue;}
   // A page already moved into a custom user folder stays in that folder.
   if(!rootsSet.has(currentParent)&&!autoSet.has(currentParent)){skippedManual++;continue;}
   // Do not override a manual top-level relocation from the default spec root.
   if(rootsSet.has(currentParent)&&currentParent!==bySection.get('spec')&&currentParent!==targetParent){skippedManual++;continue;}
   if(currentParent!==targetParent){
    await client.query('UPDATE documents SET parent_id=$2,updated_at=now() WHERE id=$1',[doc.id,targetParent]);
    moved++;
   }
  }
  const result={message:'Структура документации пересмотрена: перемещено страниц '+moved+', создано тематических групп '+createdGroups+
   (skippedManual?', сохранено пользовательских расположений '+skippedManual:'')+'. Содержимое и ссылки страниц не изменены.',
   created_task_id:null,created_document_id:null,moved_documents:moved,created_groups:createdGroups,skipped_manual:skippedManual};
  await client.query(
   "UPDATE document_import_jobs SET status='completed',message='Структура документации обновлена',result=$2,updated_at=now() WHERE id=$1",
   [job.id,JSON.stringify(result)]);
  await client.query(
   "INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,channel,created_at) VALUES($1,$2,NULL,$3,'user',$4,'documentation',clock_timestamp())",
   [randomUUID(),projectId,job.actor_id,job.request_text]);
  await client.query(
   "INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,channel,created_at) VALUES($1,$2,NULL,NULL,'assistant',$3,'documentation',clock_timestamp())",
   [randomUUID(),projectId,result.message]);
  await client.query('COMMIT');
  await progress('structure_saved',result.message);
  return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

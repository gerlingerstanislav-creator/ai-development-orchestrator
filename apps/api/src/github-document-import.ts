import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';

export type GitHubDocumentLocation={owner:string;repository:string;branch:string;path:string};
export type ImportResult={rootId:string;created:number;skipped:number;files:number};

const MAX_FILES=60;
const MAX_FILE_BYTES=100_000;
const MAX_TOTAL_BYTES=1_500_000;

/** Strictly GitHub repository content paths; never allow generic user-supplied URLs. */
export function extractGitHubDocumentLocation(message:string,context=''):GitHubDocumentLocation|null{
 const all=(message+'\n'+context).match(/https?:\/\/(?:www\.)?github\.com\/[^\s<>"')\]]+/gi)||[];
 for(const candidate of all){
  let url:URL;
  try{url=new URL(candidate.replace(/[.,;:!?]+$/,''));}catch{continue;}
  if(!['github.com','www.github.com'].includes(url.hostname))continue;
  const pieces=url.pathname.split('/').filter(Boolean).map(x=>{try{return decodeURIComponent(x);}catch{return '';}}).filter(Boolean);
  if(pieces.length<5||!['tree','blob'].includes(pieces[2]))continue;
  const [owner,repository,,branch,...rest]=pieces;
  if(!/^[a-z\d-]{1,39}$/i.test(owner)||!(/^[\w.-]{1,100}$/).test(repository))continue;
  if(!/^[\w.-]{1,100}$/.test(branch))continue;
  if(!rest.length||rest.some(x=>x==='.'||x==='..'||x.includes('/')||x.includes('\\')))continue;
  const path=rest.join('/');
  if(!path || path.length>300)return null;
  return {owner,repository,branch,path};
 }
 return null;
}
export function wantsDocumentImport(message:string,context:string):boolean{
 const source=extractGitHubDocumentLocation(message,context);
 if(!source)return false;
 const importVerb=/(?:перенес|перенести|импортир|загруз|скопир|забер|добав|помест|сохран|полож|затащ|перетащ)/i;
 const docs=/(?:документ|файл|markdown|\.md\b|страниц|материал)/i;
 const direct=importVerb.test(message)&&docs.test(message);
 // Follow-up correction to an earlier import instruction in the same conversation.
 const correction=/(?:не\s+в\s+репозиторий|в\s+проект.{0,60}приложен|в\s+приложен.{0,60}проект|сюда.{0,40}проект)/i.test(message);
 return direct||(correction&&importVerb.test(context)&&docs.test(context));
}

type GitHubEntry={type:string;name:string;path:string;size?:number;content?:string;encoding?:string};
function githubContentUrl(source:GitHubDocumentLocation,path:string){
 const parts=path.split('/').map(encodeURIComponent).join('/');
 return 'https://api.github.com/repos/'+encodeURIComponent(source.owner)+'/'+encodeURIComponent(source.repository)+'/contents/'+parts+'?ref='+encodeURIComponent(source.branch);
}

async function githubJson(source:GitHubDocumentLocation,path:string,tokens:string[]):Promise<any>{
 const url=githubContentUrl(source,path);
 const candidates=[null,...tokens.slice(0,8)];
 let lastStatus=404;
 for(const token of candidates){
  const headers:Record<string,string>={
   Accept:'application/vnd.github+json',
   'X-GitHub-Api-Version':'2022-11-28',
   'User-Agent':'ai-development-orchestrator'
  };
  if(token)headers.Authorization='Bearer '+token;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
  lastStatus=response.status;
  if(response.ok)return await response.json();
  if(![401,403,404].includes(response.status))throw new Error('GitHub не смог вернуть документы: HTTP '+response.status);
 }
 throw new Error('Документы GitHub недоступны (HTTP '+lastStatus+'). Проверь ссылку и разрешение Contents: Read для репозитория '+source.owner+'/'+source.repository+' у подключённого GitHub-токена.');
}

async function collectMarkdown(source:GitHubDocumentLocation,tokens:string[]){
 const folder=await githubJson(source,source.path,tokens);
 const entries:Array<{name:string;path:string;body:string}>=[];
 const pending:Array<{entry:GitHubEntry;depth:number}>=Array.isArray(folder)
  ?folder.map(entry=>({entry,depth:0}))
  :[{entry:folder as GitHubEntry,depth:0}];
 let total=0;
 while(pending.length){
  const {entry,depth}=pending.shift()!;
  if(entry.type==='dir'){
   if(depth>=3)throw new Error('Слишком глубокая вложенность каталога GitHub (максимум три уровня).');
   const data=await githubJson(source,entry.path,tokens);
   if(!Array.isArray(data))throw new Error('Не удалось прочитать подкаталог '+entry.path);
   for(const child of data as GitHubEntry[])pending.push({entry:child,depth:depth+1});
   continue;
  }
  if(entry.type!=='file'||!/\.md$/i.test(entry.name))continue;
  if(entries.length>=MAX_FILES)throw new Error('В каталоге слишком много Markdown-документов (максимум 60).');
  if((entry.size||0)>MAX_FILE_BYTES)throw new Error('Файл '+entry.name+' слишком велик (более 100 КБ).');
  const data=await githubJson(source,entry.path,tokens);
  if(data.type!=='file'||data.encoding!=='base64'||typeof data.content!=='string')
   throw new Error('Не удалось прочитать содержимое '+entry.name);
  const body=Buffer.from(data.content.replace(/\s/g,''),'base64').toString('utf8');
  const bytes=Buffer.byteLength(body,'utf8');
  if(bytes>MAX_FILE_BYTES)throw new Error('Файл '+entry.name+' слишком велик для импорта.');
  total+=bytes;
  if(total>MAX_TOTAL_BYTES)throw new Error('Суммарный размер документов превышает 1,5 МБ.');
  entries.push({name:entry.name,path:entry.path,body});
 }
 entries.sort((a,b)=>a.path.localeCompare(b.path));
 return entries;
}

export async function importGitHubDocumentation(pool:Pool,projectId:string,source:GitHubDocumentLocation,tokens:string[]):Promise<ImportResult>{
 const entries=await collectMarkdown(source,tokens);
 if(!entries.length)throw new Error('По указанному пути GitHub нет Markdown-файлов для импорта.');
 const rootSource='github:'+source.owner+'/'+source.repository+'@'+source.branch+':'+source.path;
 const title=source.path.split('/').at(-1)||source.repository;
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const rootCreated=await client.query(
   'INSERT INTO documents(id,project_id,title,body,parent_id,import_source) VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO NOTHING RETURNING id',
   [randomUUID(),projectId,title+' · '+source.repository,'# '+title+'\n\nДокументы импортированы из GitHub: '+source.owner+'/'+source.repository+', ветка '+source.branch+'.\n\nОригинальные файлы сохранены без пересказа.',rootSource]);
  let rootId=rootCreated.rows[0]?.id as string|undefined;
  if(!rootId){
   const root=await client.query('SELECT id FROM documents WHERE project_id=$1 AND import_source=$2',[projectId,rootSource]);
   rootId=root.rows[0]?.id;
  }
  if(!rootId)throw new Error('Не удалось создать раздел для импортированных документов');
  let created=0,skipped=0;
  for(const file of entries){
   const itemSource=rootSource+'/'+file.path.slice(source.path.length+1);
   const inserted=await client.query(
    'INSERT INTO documents(id,project_id,title,body,parent_id,import_source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,import_source) WHERE import_source IS NOT NULL DO NOTHING RETURNING id',
    [randomUUID(),projectId,file.path.slice(source.path.length+1),file.body,rootId,itemSource]);
   if(inserted.rowCount)created++;else skipped++;
  }
  await client.query('COMMIT');
  return {rootId,created,skipped,files:entries.length};
 }catch(error){
  await client.query('ROLLBACK');
  throw error;
 }finally{client.release();}
}

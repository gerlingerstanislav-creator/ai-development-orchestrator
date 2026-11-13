/** A bounded, read-only snapshot of a project's linked GitHub repository.
 * It is task context, not executable instructions for the analyst.
 */
type Fetch=typeof fetch;
export type ProjectSource={repository:string;commit:string;paths:string[];files:Array<{path:string;content:string}>};
const MAX_SOURCE_BYTES=9000;
const pathScore=(path:string)=>{
 const p=path.toLowerCase();
 if(/^(readme|overview)(?:\.[a-z-]+)?\.md$/.test(p))return 1;
 if(/^docs?\/(readme|index|overview|requirements|specification|architecture)[^/]*\.md$/.test(p))return 2;
 if(/^(package|composer)\.json$/.test(p))return 3;
 if(/^(index|app)\.(html|php|tsx|jsx)$/.test(p))return 4;
 if(/^(src|app|apps\/web\/src)\/.*\.(tsx|ts|jsx|js|php|html)$/.test(p))return 5;
 if(/^(routes|resources\/views|pages|public)\/.*\.(php|html|tsx|jsx)$/.test(p))return 6;
 if(/\.(md|html|tsx|jsx|php)$/.test(p))return 9;
 return 99;
};
export function assertDocumentationWasPrepared(required:boolean,changed:number,reply:string):void{
 if(required&&changed<1){
  throw Error('Аналитик не создал и не обновил ни одной страницы ТЗ. Результат не принят. '+
   'Причина, указанная аналитиком: '+String(reply||'не указана').slice(0,500));
 }
}

export async function readGitHubProjectSource(
 repository:string,branch:string,token:string,fetchFn:Fetch=fetch
):Promise<ProjectSource>{
 const match=/^([\w-]{1,39})\/([\w.-]{1,100})$/.exec(repository);
 if(!match)throw Error('Некорректный GitHub-репозиторий проекта');
 const base='https://api.github.com/repos/'+encodeURIComponent(match[1])+'/'+encodeURIComponent(match[2]);
 const headers:Record<string,string>={'User-Agent':'ai-development-orchestrator','Accept':'application/vnd.github+json'};
 if(token)headers.Authorization='Bearer '+token;
 const get=async(relative:string):Promise<any>=>{
  const response=await fetchFn(base+relative,{headers,signal:AbortSignal.timeout(14000)});
  if(!response.ok)throw Error('Не удалось прочитать исходники проекта из GitHub (HTTP '+response.status+'). Проверь права Contents: Read.');
  return response.json();
 };
 const head=await get('/commits/'+encodeURIComponent(branch));
 const commit=String(head?.sha||'');
 if(!/^[a-f0-9]{40}$/i.test(commit))throw Error('GitHub не вернул проверяемый SHA репозитория');
 const treeSha=String(head?.commit?.tree?.sha||'');
 if(!/^[a-f0-9]{40}$/i.test(treeSha))throw Error('GitHub не вернул SHA дерева исходников');
 const tree=await get('/git/trees/'+treeSha+'?recursive=1');
 if(tree.truncated)throw Error('Дерево GitHub слишком велико для подтверждённого обзора проекта');
 const paths:Array<{path:string;size:number}>=Array.isArray(tree.tree)?tree.tree.filter((item:any)=>
  item.type==='blob'&&typeof item.path==='string'&&typeof item.size==='number'&&item.size>0&&item.size<=60000&&
  !/(^|\/)(node_modules|dist|build|vendor|\.git|coverage|\.next|generated)(\/|$)/.test(item.path)&&
  !/\.(min\.js|map|lock|svg|png|jpe?g|webp|woff2?|pdf)$/i.test(item.path)
 ).map((item:any)=>({path:item.path,size:item.size})).slice(0,1800):[];
 const selected=paths.filter(entry=>pathScore(entry.path)<99)
  .sort((a,b)=>pathScore(a.path)-pathScore(b.path)||a.path.localeCompare(b.path)).slice(0,10);
 const files:Array<{path:string;content:string}>=[];
 let budget=MAX_SOURCE_BYTES;
 for(const entry of selected){
  if(budget<350)break;
  const path=entry.path.split('/').map(encodeURIComponent).join('/');
  const file=await get('/contents/'+path+'?ref='+commit);
  if(file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string')continue;
  const decoded=Buffer.from(file.content.replace(/\s/g,''),'base64').toString('utf8');
  const excerpt=decoded.slice(0,Math.min(2700,budget));
  files.push({path:entry.path,content:excerpt});
  budget-=excerpt.length;
 }
 return {repository,commit,paths:paths.map(item=>item.path).slice(0,100),files};
}

/** Tool-backed, agent-directed source exploration. No hardcoded list of files:
 * the agent chooses which paths to read from the immutable tree.
 */
export async function inspectGitHubProjectSource(
 repository:string,ref:string,token:string,path?:string,fetchFn:Fetch=fetch
):Promise<{repository:string;commit:string;paths?:Array<{path:string;size:number}>;file?:{path:string;content:string;truncated:boolean}}> {
 const match=/^([\\w-]{1,39})\\/([\\w.-]{1,100})$/.exec(repository);
 if(!match)throw Error('Некорректный GitHub-репозиторий проекта');
 const base='https://api.github.com/repos/'+encodeURIComponent(match[1])+'/'+encodeURIComponent(match[2]);
 const headers:Record<string,string>={Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'};
 if(token)headers.Authorization='Bearer '+token;
 const get=async(uri:string):Promise<any>=>{
  const response=await fetchFn(base+uri,{headers,signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('GitHub не вернул исходники проекта: HTTP '+response.status);
  return response.json();
 };
 if(!/^[a-zA-Z0-9._/-]{1,160}$/.test(ref)||ref.includes('..'))throw Error('Некорректная GitHub-ветка или SHA');
 const head=await get('/commits/'+encodeURIComponent(ref));
 const commit=String(head?.sha||''),treeSha=String(head?.commit?.tree?.sha||'');
 if(!/^[a-f0-9]{40}$/i.test(commit)||!/^[a-f0-9]{40}$/i.test(treeSha))throw Error('GitHub не подтвердил SHA источников');
 const tree=await get('/git/trees/'+treeSha+'?recursive=1');
 if(tree.truncated)throw Error('Список файлов GitHub обрезан: нужен более узкий источник');
 const files:Array<{path:string;size:number}>=Array.isArray(tree.tree)?tree.tree.filter((x:any)=>
  x?.type==='blob'&&typeof x.path==='string'&&Number.isInteger(x.size)&&x.size>=0&&x.size<=120000&&
  !/(^|\\/)(node_modules|dist|build|vendor|coverage|\\.git|\\.next)(\\/|$)/.test(x.path)
 ).map((x:any)=>({path:x.path,size:x.size})): [];
 if(!path)return {repository,commit,paths:files.slice(0,1200)};
 // Access only tracked, text-like paths from this specific commit; no general URL fetch.
 if(!files.some(x=>x.path===path)||!/\\.(md|mdx|txt|json|ya?ml|toml|xml|html|css|scss|js|jsx|ts|tsx|vue|php|py|sql|sh)$/i.test(path))
  throw Error('Указанного текстового файла нет в закреплённом дереве GitHub');
 const encoded=path.split('/').map(encodeURIComponent).join('/');
 const result=await get('/contents/'+encoded+'?ref='+commit);
 if(result.type!=='file'||result.encoding!=='base64'||typeof result.content!=='string')
  throw Error('GitHub не предоставил текст выбранного файла');
 const bytes=Buffer.from(result.content.replace(/\\s/g,''),'base64');
 if(bytes.includes(0))throw Error('Файл имеет бинарное содержимое');
 const body=bytes.toString('utf8');
 return {repository,commit,file:{path,content:body.slice(0,18000),truncated:body.length>18000}};
}

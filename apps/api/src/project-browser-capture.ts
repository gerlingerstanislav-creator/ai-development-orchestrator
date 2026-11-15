import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {resolveGitHubDocumentCommit} from './github-document-import.js';
import {validEvidenceSha} from './task-evidence.js';
type Db=Pick<Pool,'query'>;
const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
export type ProjectBrowserImage={
 name:string;mime:'image/jpeg';data:string;sha256:string;
 viewport:{width:number;height:number};origin:'isolated-local-browser';
 fullPage:true;pagePath:string;title:string;pixelWidth:number;pixelHeight:number;
};
/** Project-scoped evidence; no task/board status dependency. */
export async function installProjectBrowserCaptureSchema(db:Db){
 await db.query([
  'CREATE TABLE IF NOT EXISTS project_browser_captures('+
   'id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,'+
   'actor_id uuid NOT NULL REFERENCES users(id),'+
   'assistant_message_id uuid REFERENCES assistant_messages(id) ON DELETE SET NULL,'+
   'source_sha char(40),requested_sha char(40),repository text NOT NULL,branch text NOT NULL,'+
   "mode text NOT NULL CHECK(mode IN ('full_page','all_pages')),"+
   "status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','blocked')),"+
   "message text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),"+
   'updated_at timestamptz NOT NULL DEFAULT now())',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_browser_capture_active ON project_browser_captures(project_id) WHERE status='running'",
  'CREATE INDEX IF NOT EXISTS idx_project_browser_capture_chat ON project_browser_captures(assistant_message_id) WHERE assistant_message_id IS NOT NULL',
  'CREATE TABLE IF NOT EXISTS project_browser_artifacts('+
   'id uuid PRIMARY KEY,capture_id uuid NOT NULL REFERENCES project_browser_captures(id) ON DELETE CASCADE,'+
   'project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,'+
   'source_sha char(40) NOT NULL,sha256 char(64) NOT NULL,name text NOT NULL,'+
   "mime text NOT NULL CHECK(mime='image/jpeg'),"+
   'page_path text NOT NULL,page_title text NOT NULL,viewport jsonb NOT NULL,'+
   'pixel_width int NOT NULL,pixel_height int NOT NULL,origin text NOT NULL,'+
   'full_page boolean NOT NULL DEFAULT true,data bytea NOT NULL,'+
   'created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(capture_id,page_path))',
  'CREATE INDEX IF NOT EXISTS idx_project_browser_artifact_capture ON project_browser_artifacts(capture_id,created_at,id)'
 ].join(';'));
}
/** Only the Runner can send authenticated bytes, SHA256-checked on one Git SHA. */
export async function storeProjectBrowserArtifacts(db:Db,input:{
 captureId:string;projectId:string;sourceSha:string;mode:'full_page'|'all_pages';
 artifacts:ProjectBrowserImage[]
}){
 if(!validEvidenceSha(input.sourceSha)||input.artifacts.length<1||input.artifacts.length>8||
  input.mode==='full_page'&&input.artifacts.length!==1)
  throw fail('Ожидались 1–8 полноразмерных скриншотов на одном SHA');
 const capture=(await db.query('SELECT status,requested_sha,mode FROM project_browser_captures '+
  'WHERE id=$1 AND project_id=$2 FOR UPDATE',[input.captureId,input.projectId])).rows[0];
 if(!capture||capture.status!=='running'||capture.mode!==input.mode||
  String(capture.requested_sha).trim().toLowerCase()!==input.sourceSha.toLowerCase())
  throw fail('Съёмка проекта закрыта или SHA не соответствует исходникам');
 let total=0;
 const seen=new Set<string>(),valid=[];
 for(const shot of input.artifacts){
  if(!/^[0-9]{3,4}x[0-9]{3,4}-[a-f0-9-]{36}\.jpg$/i.test(shot.name)||
   shot.mime!=='image/jpeg'||shot.origin!=='isolated-local-browser'||shot.fullPage!==true||
   !Number.isInteger(shot.pixelWidth)||shot.pixelWidth<1920||shot.pixelWidth>4096||
   !Number.isInteger(shot.pixelHeight)||shot.pixelHeight<500||shot.pixelHeight>30000||
   shot.viewport?.width!==1920||shot.viewport?.height!==1080||
   !shot.name.startsWith('1920x1080-')||
   typeof shot.pagePath!=='string'||!shot.pagePath.startsWith('/')||
   shot.pagePath.startsWith('//')||shot.pagePath.length>180||/[\\?#\x00-\x1f]/.test(shot.pagePath)||
   shot.pagePath.split('/').some(part=>part==='..')||seen.has(shot.pagePath)||
   typeof shot.title!=='string'||shot.title.length>160||
   !/^[a-f0-9]{64}$/i.test(shot.sha256)||
   !/^[A-Za-z0-9+/]+={0,2}$/.test(shot.data)||shot.data.length>16_000_008)
   throw fail('Снимок страницы не прошёл проверку метаданных');
  seen.add(shot.pagePath);
  const bytes=Buffer.from(shot.data,'base64');
  total+=bytes.length;
  if(bytes.length<100||bytes.length>12_000_000||total>45_000_000||
   bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217||
   createHash('sha256').update(bytes).digest('hex')!==shot.sha256.toLowerCase())
   throw fail('Повреждённый JPEG, неверная контрольная сумма или превышен лимит файлов');
  valid.push({shot,bytes});
 }
 const ids=[];
 for(const {shot,bytes} of valid){
  const id=randomUUID();
  await db.query('INSERT INTO project_browser_artifacts('+
   'id,capture_id,project_id,source_sha,sha256,name,mime,page_path,page_title,'+
   'viewport,pixel_width,pixel_height,origin,full_page,data)'+
   " VALUES($1,$2,$3,$4,$5,$6,'image/jpeg',$7,$8,$9::jsonb,$10,$11,$12,true,$13)",[
   id,input.captureId,input.projectId,input.sourceSha.toLowerCase(),
   shot.sha256.toLowerCase(),shot.name,shot.pagePath,shot.title,
   JSON.stringify(shot.viewport),shot.pixelWidth,shot.pixelHeight,shot.origin,bytes
  ]);
  ids.push(id);
 }
 return ids;
}
export async function attachProjectCaptureToPmReply(db:Db,input:{
 projectId:string;captureId:string;messageId:string
}){
 const saved=await db.query('UPDATE project_browser_captures c '+
  'SET assistant_message_id=m.id,updated_at=now() FROM assistant_messages m '+
  "WHERE c.id=$1 AND c.project_id=$2 AND c.status='completed' AND c.assistant_message_id IS NULL "+
  'AND m.id=$3 AND m.project_id=c.project_id '+
  "AND m.role='assistant' AND m.channel='project' AND m.task_id IS NULL "+
  'AND EXISTS(SELECT 1 FROM project_browser_artifacts a WHERE a.capture_id=c.id AND a.project_id=c.project_id) '+
  'RETURNING c.id',[input.captureId,input.projectId,input.messageId]);
 if(saved.rowCount!==1)throw fail('Не удалось привязать изображения к ответу ПМ');
 return 1;
}
export async function runPmProjectBrowserCapture(db:Pool,input:{
 projectId:string;actorId:string;mode:'full_page'|'all_pages';
 runnerUrl:string;runnerSecret:string;decryptToken:(value:string)=>string;
 fetchImpl?:typeof fetch
}){
 const fetcher=input.fetchImpl||fetch,captureId=randomUUID();
 let source:any,branch='',sha='';
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  source=(await client.query('SELECT g.repository,g.target_branch,g.default_branch,c.secret_encrypted '+
   'FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id '+
   'JOIN projects p ON p.id=g.project_id AND p.deleted_at IS NULL '+
   "WHERE g.project_id=$1 AND c.provider='github_token' AND c.owner_id=$2",[
    input.projectId,input.actorId
   ])).rows[0];
  if(!source?.secret_encrypted)throw fail('Нет доступного подключения GitHub для локальной съёмки проекта');
  branch=source.target_branch||source.default_branch||'main';
  const [owner,repository]=String(source.repository).split('/');
  if(!owner||!repository)throw fail('GitHub-репозиторий проекта не определён');
  sha=await resolveGitHubDocumentCommit({owner,repository,branch,path:''},[
   input.decryptToken(source.secret_encrypted)
  ]);
  if(!validEvidenceSha(sha))throw fail('Не удалось проверить HEAD ветки GitHub');
  await client.query('UPDATE project_browser_captures '+
   "SET status='blocked',message='Предыдущая съёмка прервана',updated_at=now() "+
   "WHERE project_id=$1 AND status='running' AND updated_at<now()-interval '6 minutes'",[input.projectId]);
  const existing=await client.query("SELECT id FROM project_browser_captures WHERE project_id=$1 AND status='running' LIMIT 1",[input.projectId]);
  if(existing.rowCount)throw fail('Для проекта уже идёт съёмка; не запускай повторную');
  await client.query('INSERT INTO project_browser_captures('+
   'id,project_id,actor_id,repository,branch,mode,requested_sha,status)'+
   " VALUES($1,$2,$3,$4,$5,$6,$7,'running')",
   [captureId,input.projectId,input.actorId,source.repository,branch,input.mode,sha]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
 try{
  const response=await fetcher(input.runnerUrl+'/pm-browser-capture',{
   method:'POST',
   headers:{'X-Runner-Secret':input.runnerSecret,'Content-Type':'application/json'},
   body:JSON.stringify({captureId,projectId:input.projectId,projectCapture:true,
    mode:input.mode,repository:source.repository,branch,
    token:input.decryptToken(source.secret_encrypted),sourceSha:sha}),
   signal:AbortSignal.timeout(225000)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(String(result.error||'Ошибка Chromium').slice(0,900));
  const count=Number(result.screenshots_saved);
  if(!Number.isInteger(count)||count<1||count>8||
   input.mode==='full_page'&&count!==1||result.source_sha!==sha)
   throw Error('Изолированный браузер не подтвердил изображения и исходный SHA');
  const saved=await db.query('SELECT id,page_path,page_title,sha256,pixel_width,pixel_height '+
   'FROM project_browser_artifacts WHERE capture_id=$1 AND project_id=$2 AND source_sha=$3 '+
   'ORDER BY created_at,id',[captureId,input.projectId,sha]);
  if(saved.rowCount!==count)throw Error('Снимки отсутствуют в хранилище проекта');
  await db.query("UPDATE project_browser_captures SET status='completed',source_sha=$2,message=$3,updated_at=now() WHERE id=$1",[
    captureId,sha,'Снято полных страниц: '+count
   ]);
  return {status:'completed',capture_id:captureId,mode:input.mode,
   environment:'local-isolated-preview',source_sha:sha,repository:source.repository,
   branch,count,screenshots:saved.rows.map(row=>({
    url:'/api/projects/'+input.projectId+'/browser-artifacts/'+row.id,
    path:row.page_path,title:row.page_title,sha256:row.sha256,
    width:row.pixel_width,height:row.pixel_height
   })),
   message:'Скриншоты прикрепляются к этому ответу автоматически. Не заменяй их Markdown-ссылками.'};
 }catch(error){
  const message=String(error instanceof Error?error.message:error).slice(0,1100);
  await db.query("UPDATE project_browser_captures SET status='blocked',message=$2,updated_at=now() WHERE id=$1 AND status='running'",[captureId,message]).catch(()=>{});
  return {status:'blocked',capture_id:captureId,message,
   next_action:'Изучи конкретную ошибку сборки или Chromium; активная задача не требуется.'};
 }
}

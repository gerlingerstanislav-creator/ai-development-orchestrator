import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {validEvidenceSha} from './task-evidence.js';
import {confirmedEvidenceSourceBlocker} from './task-evidence-blockers.js';

type Db=Pick<Pool,'query'>;
const reject=(message:string,statusCode=409)=>Object.assign(Error(message),{statusCode});
export type PmCaptureImage={
 name:string;sha256:string;viewport:{width:number;height:number};
 mime:'image/jpeg';origin:'isolated-local-browser';data:string;
};
/** PM actions use the SAME real isolated Chromium, without an invented
 * delegated agent. All capture metadata is owned by PostgreSQL, not Codex
 * instructions; the GitHub token is never persisted or given to the model.
 */
export async function installPmBrowserCaptureSchema(db:Db){
 await db.query(`CREATE TABLE IF NOT EXISTS pm_browser_captures(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  source_sha char(40),
  requested_sha char(40),
  repository text NOT NULL,
  branch text NOT NULL,
  revision_mode text NOT NULL CHECK(revision_mode IN ('latest','pinned')),
  status text NOT NULL DEFAULT 'running'
   CHECK(status IN ('running','completed','blocked')),
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_browser_capture_active
 ON pm_browser_captures(task_id) WHERE status='running';
 CREATE INDEX IF NOT EXISTS idx_pm_browser_capture_task
 ON pm_browser_captures(project_id,task_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS pm_browser_capture_artifacts(
  id uuid PRIMARY KEY,
  capture_id uuid NOT NULL REFERENCES pm_browser_captures(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_sha char(40) NOT NULL,
  sha256 char(64) NOT NULL,
  name text NOT NULL,mime text NOT NULL CHECK(mime='image/jpeg'),
  viewport jsonb NOT NULL,origin text NOT NULL,
  data bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(capture_id,sha256)
 );
 CREATE INDEX IF NOT EXISTS idx_pm_browser_artifacts_task
 ON pm_browser_capture_artifacts(project_id,task_id,created_at DESC);`);
}
/** No model-written image bytes. The Runner holds a gateway session and is
 * the ONLY authority allowed to post verified screenshot receipts. */
export async function storePmCaptureImages(db:Db,input:{
 captureId:string;projectId:string;taskId:string;sourceSha:string;artifacts:PmCaptureImage[]
}){
 if(!validEvidenceSha(input.sourceSha)||input.artifacts.length!==2)
  throw reject('Требуются реальные desktop и mobile скриншоты на одном SHA');
 const widths=input.artifacts.map(a=>a.viewport.width);
 if(!widths.some(w=>w>=900)||!widths.some(w=>w<=600))
  throw reject('Требуются снимки desktop и mobile');
 const results=[];
 for(const image of input.artifacts){
  if(!/^[0-9]{3,4}x[0-9]{3,4}-[a-f0-9-]{36}\.jpg$/i.test(image.name)||
   image.mime!=='image/jpeg'||image.origin!=='isolated-local-browser'||
   !/^[a-f0-9]{64}$/i.test(image.sha256)||
   !Number.isInteger(image.viewport.width)||!Number.isInteger(image.viewport.height)||
   image.viewport.width<320||image.viewport.width>2560||
   image.viewport.height<240||image.viewport.height>2560||
   !image.name.startsWith(image.viewport.width+'x'+image.viewport.height+'-')||
   !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)||image.data.length>450000)
    throw reject('Неподтверждённый браузерный артефакт');
  const bytes=Buffer.from(image.data,'base64');
  if(bytes.length<100||bytes.length>320000||bytes[0]!==255||bytes[1]!==216||
   bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217||
   createHash('sha256').update(bytes).digest('hex')!==image.sha256.toLowerCase())
    throw reject('Скриншот повреждён или не совпадает с SHA256');
  results.push({image,bytes});
 }
 const cap=(await db.query(`SELECT id,revision_mode,status,requested_sha FROM pm_browser_captures
   WHERE id=$1 AND project_id=$2 AND task_id=$3 FOR UPDATE`,
  [input.captureId,input.projectId,input.taskId])).rows[0];
 if(!cap||cap.status!=='running')throw reject('Браузерная сессия ПМ уже закрыта');
 if(cap.revision_mode==='pinned'&&cap.requested_sha!==input.sourceSha)
  throw reject('Браузер не подтвердил требуемую ревизию');
 const result=[];
 for(const {image,bytes} of results){
  const id=randomUUID();
  const saved=await db.query(`INSERT INTO pm_browser_capture_artifacts(
   id,capture_id,project_id,task_id,source_sha,sha256,name,mime,viewport,origin,data)
   VALUES($1,$2,$3,$4,$5,$6,$7,'image/jpeg',$8::jsonb,$9,$10)
   ON CONFLICT(capture_id,sha256) DO NOTHING RETURNING id`,
   [id,input.captureId,input.projectId,input.taskId,input.sourceSha.toLowerCase(),
    image.sha256.toLowerCase(),image.name,JSON.stringify(image.viewport),image.origin,bytes]);
  result.push(saved.rows[0]?.id||null);
 }
 await db.query('UPDATE pm_browser_captures SET source_sha=$2,updated_at=now() WHERE id=$1',
  [input.captureId,input.sourceSha.toLowerCase()]);
 return result;
}
export async function readPmCaptureArtifacts(db:Db,projectId:string,taskId:string){
 const r=await db.query(`SELECT a.id,a.capture_id,a.source_sha,a.sha256,a.name,a.mime,a.viewport,a.origin,a.created_at
 FROM pm_browser_capture_artifacts a
 WHERE a.project_id=$1 AND a.task_id=$2 ORDER BY a.created_at DESC LIMIT 50`,[projectId,taskId]);
 return r.rows.map(row=>({...row,
  url:'/api/projects/'+projectId+'/tasks/'+taskId+'/pm-browser-artifacts/'+row.id}));
}
/** Called by the manager MCP tool, not via work.delegate. Repo and credentials
 * are read from the existing authenticated GitHub project connection.
 */
export async function runPmBrowserCapture(db:Pool,input:{
 projectId:string;taskId:string;actorId:string;revision:'latest'|'pinned';
 sourceSha?:string;reason:string;runnerUrl:string;runnerSecret:string;
 decryptToken:(encrypted:string)=>string;fetchImpl?:typeof fetch
}){
 const fetcher=input.fetchImpl||fetch;
 const client=await db.connect(),captureId=randomUUID();
 let source:any,task:any;
 try{
  await client.query('BEGIN');
  const found=await client.query(`SELECT id,stage,board_status,postponed_at,archived_at,
   pr_url,evidence_source_sha,execution_mode
   FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE`,[input.projectId,input.taskId]);
  task=found.rows[0];
  if(!task)throw reject('Задача не найдена',404);
  if(task.postponed_at||task.archived_at||['done','acceptance'].includes(task.board_status)||
   task.stage==='done')throw reject('Нельзя снимать скриншоты для отложенной или завершённой задачи');
  if(task.pr_url)throw reject('Для задачи с PR используй техническую QA-проверку');
  source=(await client.query(`SELECT g.repository,g.target_branch,g.default_branch,c.secret_encrypted
    FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id
    WHERE g.project_id=$1 AND c.provider='github_token' AND c.owner_id=$2`,
   [input.projectId,input.actorId])).rows[0];
  if(!source?.secret_encrypted)throw reject('Нет доступного GitHub-подключения проекта');
  const pin=input.revision==='pinned'?(input.sourceSha||task.evidence_source_sha):null;
  if(input.revision==='pinned'&&!validEvidenceSha(pin))
   throw reject('У задачи нет полного закреплённого SHA. Укажи source_sha или выбери latest',400);
  if(input.revision==='pinned'){
   const failure=await confirmedEvidenceSourceBlocker(client,{
    projectId:input.projectId,taskId:input.taskId,sourceSha:String(pin)});
   if(failure)throw reject(failure);
  }
  // The Codex MCP request has a bounded timeout; a crashed API process
  // cannot leave a permanent "running" capture that blocks every next turn.
  await client.query(`UPDATE pm_browser_captures SET status='blocked',
   message='Предыдущий браузерный запуск прерван, время ожидания истекло',
   updated_at=now()
   WHERE task_id=$1 AND project_id=$2 AND status='running'
    AND updated_at<now()-interval '6 minutes'`,[input.taskId,input.projectId]);
  const active=await client.query(`SELECT id FROM pm_browser_captures
   WHERE task_id=$1 AND project_id=$2 AND status='running' LIMIT 1`,
   [input.taskId,input.projectId]);
  if(active.rowCount)throw reject('ПМ уже снимает скриншоты этой задачи. Дождись результата.');
  const branch=source.target_branch||source.default_branch||'main';
  await client.query(`INSERT INTO pm_browser_captures(
   id,project_id,task_id,actor_id,repository,branch,revision_mode,requested_sha,status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running')`,
   [captureId,input.projectId,input.taskId,input.actorId,source.repository,branch,input.revision,pin]);
  await client.query(`UPDATE tasks SET board_status='in_progress',updated_at=now()
   WHERE id=$1 AND board_status IN ('backlog','todo')`,[input.taskId]);
  await client.query(`INSERT INTO process_events(
   id,project_id,process_id,process_kind,stage,detail,task_id)
   VALUES($1,$2,$3,'agent','running',$4,$5)`,
   [randomUUID(),input.projectId,captureId,'ПМ снимает скриншоты напрямую · '+input.revision,input.taskId]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
 let response:any;
 try{
  const r=await fetcher(input.runnerUrl+'/pm-browser-capture',{
   method:'POST',headers:{'X-Runner-Secret':input.runnerSecret,'Content-Type':'application/json'},
   body:JSON.stringify({captureId,projectId:input.projectId,taskId:input.taskId,
    repository:source.repository,branch:source.target_branch||source.default_branch||'main',
    token:input.decryptToken(source.secret_encrypted),
    sourceSha:input.revision==='pinned'?(input.sourceSha||task.evidence_source_sha):null}),
   signal:AbortSignal.timeout(190000)
  });
  response=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(String(response.error||'Ошибка изолированного браузера').slice(0,1200));
  if(!validEvidenceSha(response.source_sha)||response.screenshots_saved!==2)
   throw Error('Браузер не подтвердил два изображения и исходный SHA');
  const images=await readPmCaptureArtifacts(db,input.projectId,input.taskId);
  const artifacts=images.filter(x=>x.capture_id===captureId&&String(x.source_sha).trim()===response.source_sha);
  if(artifacts.length!==2)throw Error('Браузерные снимки отсутствуют в защищённом хранилище');
  // A new SHA is safe only AFTER a real successful browser capture, not
  // merely because the PM saw a different branch HEAD.
  const sourceChanged=!!task.evidence_source_sha&&task.evidence_source_sha!==response.source_sha;
  const finish=await db.connect();
  let repinned=false;
  try{
   await finish.query('BEGIN');
   await finish.query(`UPDATE pm_browser_captures
    SET source_sha=$2,status='completed',message=$3,updated_at=now() WHERE id=$1`,
    [captureId,response.source_sha,'Сохранены два реальных скриншота']);
   if(sourceChanged&&input.revision==='latest'&&task.execution_mode==='browser_evidence'){
    const active=await finish.query(`SELECT 1 FROM task_orchestration_owners
     WHERE project_id=$1 AND task_id=$2 AND state='active'
     UNION ALL SELECT 1 FROM task_evidence_runs
     WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','dispatching','running') LIMIT 1`,
     [input.projectId,input.taskId]);
    if(!active.rowCount){
     const changed=await finish.query(`UPDATE tasks SET evidence_source_sha=$3,
      implementation_commit=$3,updated_at=now() WHERE id=$1 AND project_id=$2
      AND stage='testing' AND execution_mode='browser_evidence' AND pr_url IS NULL RETURNING id`,
      [input.taskId,input.projectId,response.source_sha]);
     repinned=(changed.rowCount??0)>0;
     if(repinned)await finish.query(`INSERT INTO task_events(id,task_id,actor_id,event,detail)
      VALUES($1,$2,$3,'evidence_sha_updated',$4)`,
      [randomUUID(),input.taskId,input.actorId,'ПМ выбрал рабочий SHA '+response.source_sha+
       '; прежний '+task.evidence_source_sha+' сохранён в истории']);
    }
   }
   await finish.query('COMMIT');
  }catch(error){await finish.query('ROLLBACK').catch(()=>{});throw error;}
  finally{finish.release();}
  await db.query(`INSERT INTO task_events(id,task_id,actor_id,event,detail)
    VALUES($1,$2,$3,'pm_browser_captured',$4)`,
   [randomUUID(),input.taskId,input.actorId,'ПМ сделал два снимка с '+response.source_sha+
    (sourceChanged?'; закреплённый ранее SHA '+task.evidence_source_sha+' сохранён в истории':'')]);
  await db.query(`INSERT INTO process_events(
   id,project_id,process_id,process_kind,stage,detail,task_id)
   VALUES($1,$2,$3,'agent','completed',$4,$5)`,
   [randomUUID(),input.projectId,captureId,'ПМ сохранил два реальных скриншота SHA '+response.source_sha,input.taskId]);
  return {status:'completed',capture_id:captureId,source_sha:response.source_sha,
   previous_pinned_sha:sourceChanged?task.evidence_source_sha:null,
   screenshots:artifacts.map(x=>({url:x.url,viewport:x.viewport,sha256:x.sha256})),
   message:sourceChanged?(repinned
    ?'ПМ выбрал актуальную рабочую версию и обновил SHA задачи, сохранив историю прежней проверки.'
    :'ПМ снял актуальный сайт, но SHA задачи пока нельзя обновить: есть активный технический процесс.'):
    'ПМ самостоятельно сделал и сохранил два скриншота.'};
 }catch(error){
  const message=String(error instanceof Error?error.message:error).slice(0,1400);
  await db.query(`UPDATE pm_browser_captures
   SET status='blocked',message=$2,updated_at=now() WHERE id=$1 AND status='running'`,
   [captureId,message]).catch(()=>{});
  await db.query(`INSERT INTO process_events(
   id,project_id,process_id,process_kind,stage,detail,level,task_id)
   VALUES($1,$2,$3,'agent','blocked',$4,'warning',$5)`,
   [randomUUID(),input.projectId,captureId,'ПМ не получил скриншоты: '+message,input.taskId]).catch(()=>{});
  return {status:'blocked',capture_id:captureId,message,
   next_action:'Проверь сборку / source SHA. Не повторяй неизменную неудачную попытку.'};
 }
}

import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {isIP} from 'node:net';
import {z} from 'zod';

const uuid=z.string().uuid();
const sha=z.string().regex(/^[a-f0-9]{40}$/);
type Db=Pick<Pool,'query'>;
type Deps={pool:Pool;uid:(r:any)=>string;access:(r:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(r:any,reply:any)=>Promise<boolean>;decrypt:(secret:string)=>string;encrypt:(secret:string)=>string;start:(runId:string)=>Promise<void>};
function problem(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode});}
export function validateHealthUrl(value:string){
 let u:URL;
 try{u=new URL(value);}catch{throw problem(400,'Некорректный URL проверки');}
 if(u.protocol!=='https:'||!!u.username||!!u.password||(u.port!==''&&u.port!=='443')||isIP(u.hostname.replace(/^\[|\]$/g,''))!==0||
  /(^localhost$|\.localhost$|\.local$|\.internal$)/i.test(u.hostname))
  throw problem(400,'Проверка доступности требует публичный HTTPS hostname');
 return u.toString();
}
/** Pure input validation: SSH destination and pinned known_hosts are never model-authored shell fragments. */
export function validateSshTarget(target:{host:string;username:string;path:string;knownHosts:string}){
 const {host,username,path,knownHosts}=target;
 if(!/^[a-zA-Z0-9.-]{3,240}$/.test(host)||host==='localhost'||host.startsWith('127.')||
  !/^[a-z_][a-zA-Z0-9_-]{0,69}$/.test(username)||
  !/^\/[a-zA-Z0-9_.\/-]{1,349}$/.test(path)||path.split('/').includes('..')||
  !knownHosts.split('\n').some(line=>line.startsWith(host+' ')&&/\bssh-(rsa|ed25519)\b|\becdsa-sha2-/.test(line)))
  throw problem(400,'Недопустимый SSH-хост, пользователь, каталог или host key');
 return target;
}
export async function initAutomaticDeployment(db:Db){
 await db.query(`
  ALTER TABLE project_deployment_settings DROP CONSTRAINT IF EXISTS project_deployment_settings_mode_check;
  ALTER TABLE project_deployment_settings ADD CONSTRAINT project_deployment_settings_mode_check CHECK(mode IN ('skip','manual','automatic'));
  ALTER TABLE project_deployment_settings ADD COLUMN IF NOT EXISTS health_url text NOT NULL DEFAULT '';
  ALTER TABLE project_deployment_settings ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production';
  ALTER TABLE task_deployment_records DROP CONSTRAINT IF EXISTS task_deployment_records_status_check;
  ALTER TABLE task_deployment_records ADD CONSTRAINT task_deployment_records_status_check CHECK(status IN ('skipped','pending','manual_confirmed','automatic_verified'));
  CREATE TABLE IF NOT EXISTS deployment_runs(
   id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
   sha text NOT NULL,status text NOT NULL DEFAULT 'queued',github_run_id bigint,github_url text,
   message text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),
   updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS project_deployment_ssh(
   project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
   host text NOT NULL,username text NOT NULL,remote_path text NOT NULL,
   private_key_encrypted text NOT NULL,known_hosts text NOT NULL,
   updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_active_project ON deployment_runs(project_id) WHERE status IN ('queued','running');
  CREATE INDEX IF NOT EXISTS idx_deployment_runs_task ON deployment_runs(task_id,created_at DESC);
 `);
}
const gitHeaders=(token:string)=>({Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator','Content-Type':'application/json'});
async function git<T=any>(repo:string,token:string,path:string,method='GET',body?:unknown):Promise<T>{
 if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo))throw problem(400,'Некорректный GitHub репозиторий');
 const response=await fetch('https://api.github.com/repos/'+repo+path,{method,headers:gitHeaders(token),
  body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw problem(502,'GitHub '+method+' '+path.split('?')[0]+' HTTP '+response.status);
 return response.status===204?{} as T:await response.json() as T;
}
async function githubConnection(db:Db,projectId:string,userId:string|null){
 const row=(await db.query(`SELECT g.repository,g.default_branch,c.secret_encrypted
  FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id AND c.provider='github_token'
  WHERE g.project_id=$1 AND ($2::uuid IS NULL OR c.owner_id=$2)`,[projectId,userId])).rows[0];
 if(!row)throw problem(409,'Подключи GitHub репозиторий и настрой доступ к PR');
 return row as {repository:string;default_branch:string;secret_encrypted:string};
}
async function event(db:Db,projectId:string,runId:string,stage:string,detail:string){
 await db.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'deployment',$4,$5)",
  [randomUUID(),projectId,runId,stage,detail.slice(0,1300)]);
}
export function registerAutomaticDeploymentRoutes(app:FastifyInstance,deps:Deps){
 const {pool,uid,access,requireAdmin,decrypt,encrypt,start}=deps;
 const base='/api/projects/:id';
 const permission=async(req:any,reply:any,id:string)=>await access(req,reply,id)&&await requireAdmin(req,reply);
 app.get(base+'/deployment/runs',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  return (await pool.query('SELECT id,task_id,sha,status,github_url,message,created_at,updated_at,completed_at FROM deployment_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50',[id])).rows;
 });
 app.get(base+'/deployment/ssh',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await permission(req,reply,id))return;
  const item=(await pool.query("SELECT host,username,remote_path,updated_at FROM project_deployment_ssh WHERE project_id=$1",[id])).rows[0];
  return {configured:!!item,...item};
 });
 app.put(base+'/deployment/ssh',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await permission(req,reply,id))return;
  const fields=z.object({
   host:z.string().trim().min(3).max(240).regex(/^[a-zA-Z0-9.-]+$/),
   username:z.string().trim().min(1).max(70).regex(/^[a-z_][a-zA-Z0-9_-]*$/),
   path:z.string().trim().min(2).max(350).regex(/^\/[a-zA-Z0-9_.\/-]+$/),
   private_key:z.string().min(70).max(16000),
   known_hosts:z.string().min(40).max(8000)
  }).parse(req.body);
  validateSshTarget({host:fields.host,username:fields.username,path:fields.path,knownHosts:fields.known_hosts});
  await pool.query(`INSERT INTO project_deployment_ssh(project_id,host,username,remote_path,private_key_encrypted,known_hosts)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id) DO UPDATE SET host=EXCLUDED.host,username=EXCLUDED.username,
    remote_path=EXCLUDED.remote_path,private_key_encrypted=EXCLUDED.private_key_encrypted,
    known_hosts=EXCLUDED.known_hosts,updated_at=now()`,
   [id,fields.host,fields.username,fields.path,encrypt(fields.private_key),fields.known_hosts]);
  return {configured:true,host:fields.host,username:fields.username,path:fields.path};
 });
 app.post(base+'/deployment/prepare-workflow',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await permission(req,reply,id))return;
  return reply.code(410).send({error:'GitHub Actions больше не используется. Настрой SSH во вкладке выкладки приложения.'});
 });
 app.post(base+'/tasks/:taskId/deployment/start',async(req:any,reply)=>{
  const {id,taskId}=z.object({id:uuid,taskId:uuid}).parse(req.params);
  if(!await permission(req,reply,id))return;
  const {commit_sha}=z.object({confirm:z.literal(true),commit_sha:sha}).parse(req.body);
  const client=await pool.connect();let runId='';
  try{
   await client.query('BEGIN');
   const state=(await client.query(`SELECT t.stage,d.status,d.merge_sha,s.mode,s.health_url
    FROM tasks t JOIN task_deployment_records d ON d.task_id=t.id AND d.project_id=t.project_id
    JOIN project_deployment_settings s ON s.project_id=t.project_id
    WHERE t.project_id=$1 AND t.id=$2 FOR UPDATE OF t,d`,[id,taskId])).rows[0];
   if(!state||state.stage!=='deployment'||state.status!=='pending'||state.mode!=='automatic'||state.merge_sha!==commit_sha)
    throw problem(409,'Выкладка требует ожидающего этапа, automatic и точного SHA слитого PR');
   if(!state.health_url)throw problem(409,'Не настроен URL проверки доступности приложения');
   validateHealthUrl(state.health_url);
   await githubConnection(client,id,uid(req));
   runId=randomUUID();
   await client.query('INSERT INTO deployment_runs(id,project_id,task_id,actor_id,sha) VALUES($1,$2,$3,$4,$5)',[runId,id,taskId,uid(req),commit_sha]);
   await event(client,id,runId,'queued','SHA '+commit_sha+' ожидает Temporal');
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await start(runId).catch(e=>req.log.error({error:e,runId},'Temporal deployment dispatch requires recovery'));
  return reply.code(202).send({run_id:runId,status:'queued'});
 });
}
export async function performAutomaticDeployment(pool:Pool,runId:string,decrypt:(v:string)=>string){
 const row=(await pool.query(`SELECT r.*,s.health_url,s.environment,g.repository,g.default_branch,c.secret_encrypted,
  ssh.host,ssh.username,ssh.remote_path,ssh.private_key_encrypted,ssh.known_hosts
  FROM deployment_runs r JOIN project_deployment_settings s ON s.project_id=r.project_id
  JOIN project_git_repositories g ON g.project_id=r.project_id
  JOIN connections c ON c.id=g.connection_id AND c.provider='github_token'
  LEFT JOIN project_deployment_ssh ssh ON ssh.project_id=r.project_id WHERE r.id=$1`,[runId])).rows[0];
 if(!row||['completed','failed'].includes(row.status))return;
 validateHealthUrl(row.health_url);
 if(!row.host||!row.username||!row.private_key_encrypted||!row.known_hosts)
  throw problem(409,'Не настроен защищённый SSH-доступ для самостоятельной выкладки');
 const commit=sha.parse(row.sha),token=decrypt(row.secret_encrypted),repo=row.repository;
 await pool.query("UPDATE deployment_runs SET status='running',message='Проверка SHA и SSH-окружения',updated_at=now() WHERE id=$1",[runId]);
 await event(pool,row.project_id,runId,'running','Проверка SHA '+commit);
 const branch=await git<{commit:{sha:string}}>(repo,token,'/branches/'+encodeURIComponent(row.default_branch));
 const comparison=await git<{status:string}>(repo,token,'/compare/'+commit+'...'+branch.commit.sha);
 if(!['ahead','identical'].includes(comparison.status))throw problem(409,'SHA не является предком текущей основной ветки');
 const dir=await mkdtemp(join(tmpdir(),'ado-deploy-'));
 try{
  const keyPath=join(dir,'id_ed25519'),knownPath=join(dir,'known_hosts');
  await writeFile(keyPath,decrypt(row.private_key_encrypted),{mode:0o600});
  await writeFile(knownPath,row.known_hosts,{mode:0o600});
  const remotePath=String(row.remote_path);
  if(!/^\/[a-zA-Z0-9_.\/-]+$/.test(remotePath)||remotePath.split('/').includes('..'))
   throw problem(400,'Некорректная директория для SSH-деплоя');
  const remote='set -e; cd '+remotePath+'; git fetch origin '+commit+'; git checkout --detach '+commit+'; docker compose up -d --build; docker compose ps';
  await event(pool,row.project_id,runId,'ssh','Запуск собственного SSH-деплоя закреплённого SHA');
  const result=await promisify(execFile)('ssh',[
   '-i',keyPath,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
   '-o','UserKnownHostsFile='+knownPath,'-o','ConnectTimeout=15',
   row.username+'@'+row.host,remote
  ],{timeout:25*60*1000,maxBuffer:1024*1024,env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:dir}});
  await event(pool,row.project_id,runId,'deployed',String(result.stdout||'').slice(-1200));
 }finally{await rm(dir,{recursive:true,force:true}).catch(()=>{});}
 await pool.query("UPDATE deployment_runs SET message='SSH-деплой завершён, проверка HTTPS',updated_at=now() WHERE id=$1",[runId]);
 for(let attempt=0;attempt<3;attempt++){
  const response=await fetch(row.health_url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw problem(502,'Приложение недоступно после SSH-деплоя: HTTP '+response.status);
  if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1500));
 }
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const updated=await client.query("UPDATE task_deployment_records SET status='automatic_verified',reason=$3,updated_at=now() WHERE task_id=$1 AND project_id=$2 AND status='pending' RETURNING task_id",
   [row.task_id,row.project_id,'SSH / SHA '+commit+' / '+row.health_url]);
  if(!updated.rowCount)throw problem(409,'Задача больше не ожидает выкладку');
  const task=await client.query("UPDATE tasks SET stage='documentation',updated_at=now() WHERE id=$1 AND project_id=$2 AND stage='deployment' RETURNING id",
   [row.task_id,row.project_id]);
  if(!task.rowCount)throw problem(409,'Этап задачи изменился');
  await client.query("UPDATE deployment_runs SET status='completed',message='SHA выложен по SSH и доступность подтверждена',updated_at=now(),completed_at=now() WHERE id=$1",[runId]);
  await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'deployment_verified',$3)",
   [randomUUID(),row.task_id,'SSH SHA '+commit]);
  await event(client,row.project_id,runId,'completed','Собственный SSH-деплой и HTTPS проверены для '+commit);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function failAutomaticDeployment(db:Db,runId:string,message:string){
 const row=await db.query("UPDATE deployment_runs SET status='failed',message=$2,updated_at=now(),completed_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING project_id",
  [runId,message.slice(0,1200)]);
 if(row.rowCount)await event(db,row.rows[0].project_id,runId,'failed',message);
}

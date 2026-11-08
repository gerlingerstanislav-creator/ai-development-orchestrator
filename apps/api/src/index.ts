import Fastify from 'fastify';
import { registerAssistantRoutes } from './assistant.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import pg from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
const { compare, hash } = bcrypt;
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const jwtKey = new TextEncoder().encode(process.env.JWT_SECRET || '');
const keyText = process.env.CREDENTIALS_KEY || '';
const encryptionKey = Buffer.from(keyText, 'hex');
if (!process.env.JWT_SECRET || jwtKey.length < 32 || encryptionKey.length !== 32) throw Error('Set secure JWT_SECRET and 64-char hex CREDENTIALS_KEY');
const validStages = z.enum(['backlog','analysis','development','testing','merge_queue','documentation','done']);
const validMode = z.enum(['automatic','approval','manual']);
const workflowDefaults = [
  ['backlog','Бэклог','manual'],
  ['analysis','Анализ','approval'],
  ['development','Разработка','approval'],
  ['merge_queue','Ожидает слияния','manual'],
  ['documentation','Документация','manual'],
  ['done','Готово','manual']
] as const;
async function dbInit() {
 await pool.query(`
 CREATE TABLE IF NOT EXISTS users (id uuid primary key, email text unique not null, password_hash text not null);
 CREATE TABLE IF NOT EXISTS projects (id uuid primary key, name text not null, description text not null default '', owner_id uuid not null references users(id), created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS memberships (project_id uuid references projects(id) on delete cascade, user_id uuid references users(id) on delete cascade, role text not null default 'member', primary key(project_id,user_id));
 CREATE TABLE IF NOT EXISTS workflow_stages (project_id uuid references projects(id) on delete cascade, stage text not null, label text not null, mode text not null, position int not null, primary key(project_id,stage));
 CREATE TABLE IF NOT EXISTS tasks (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, title text not null, description text not null default '', type text not null default 'task', stage text not null default 'backlog', parent_id uuid references tasks(id) on delete set null, position int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS analysis_state text NOT NULL DEFAULT 'new';
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS clarification_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS related_task_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS git_branch text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_url text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_number int;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS documentation_updated_at timestamptz;
 CREATE TABLE IF NOT EXISTS task_events (id uuid primary key, task_id uuid references tasks(id) on delete cascade, actor_id uuid references users(id), event text not null, detail text not null default '', created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS documents (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, title text not null, body text not null default '', updated_at timestamptz not null default now());
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES documents(id) ON DELETE SET NULL;
 CREATE INDEX IF NOT EXISTS idx_documents_project_parent ON documents(project_id, parent_id);
 CREATE TABLE IF NOT EXISTS document_versions (id uuid primary key, document_id uuid not null references documents(id) on delete cascade, task_ids jsonb not null default '[]'::jsonb, body text not null, created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS project_rules (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, body text not null, origin text not null default 'manual', source_task_id uuid references tasks(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_project_rules_project ON project_rules(project_id,created_at);
 CREATE TABLE IF NOT EXISTS project_rule_suggestions (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, task_id uuid references tasks(id) on delete cascade, body text not null, status text not null default 'pending', created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_rule_suggestions_project ON project_rule_suggestions(project_id,status);
 CREATE TABLE IF NOT EXISTS connections (id uuid primary key, owner_id uuid not null references users(id), name text not null, provider text not null, secret_encrypted text not null, created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS project_connections (project_id uuid references projects(id) on delete cascade, connection_id uuid references connections(id) on delete cascade, primary key(project_id,connection_id));
 CREATE TABLE IF NOT EXISTS project_git_repositories (project_id uuid primary key references projects(id) on delete cascade, connection_id uuid not null references connections(id), repository text not null, default_branch text not null, updated_at timestamptz not null default now());
 ALTER TABLE project_git_repositories ADD COLUMN IF NOT EXISTS target_branch text;
 UPDATE project_git_repositories SET target_branch=default_branch WHERE target_branch IS NULL;
 INSERT INTO workflow_stages(project_id,stage,label,mode,position)
 SELECT p.id,'merge_queue','Ожидает слияния','manual',4 FROM projects p
 ON CONFLICT(project_id,stage) DO NOTHING;
 INSERT INTO workflow_stages(project_id,stage,label,mode,position)
 SELECT p.id,'documentation','Документация','manual',5 FROM projects p
 ON CONFLICT(project_id,stage) DO NOTHING;
 DELETE FROM workflow_stages s WHERE s.stage='testing' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id=s.project_id AND t.stage='testing');
 UPDATE workflow_stages SET position=4 WHERE stage='merge_queue';
 UPDATE workflow_stages SET position=5 WHERE stage='documentation';
 UPDATE workflow_stages SET position=6 WHERE stage='done';
 CREATE TABLE IF NOT EXISTS assistant_messages (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, task_id uuid references tasks(id) on delete cascade, actor_id uuid references users(id), role text not null check(role in ('user','assistant')), body text not null, created_task_id uuid references tasks(id) on delete set null, created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_assistant_messages_project ON assistant_messages(project_id,task_id,created_at);
 CREATE TABLE IF NOT EXISTS assistant_usage (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, actor_id uuid not null references users(id), created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_assistant_usage_project ON assistant_usage(project_id,created_at);
 CREATE TABLE IF NOT EXISTS project_ai_settings (project_id uuid primary key references projects(id) on delete cascade, model text not null default 'gpt-6-luna', reasoning text not null default 'low', max_runtime_seconds int not null default 300, enabled boolean not null default false, updated_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS ai_task_runs (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, task_id uuid not null references tasks(id) on delete cascade, triggered_by uuid not null references users(id), model text not null, status text not null default 'queued', branch text, pr_url text, message text not null default '', created_at timestamptz not null default now(), completed_at timestamptz);
 CREATE INDEX IF NOT EXISTS idx_ai_task_runs_project_created ON ai_task_runs(project_id,created_at DESC);
 ALTER TABLE project_ai_settings ADD COLUMN IF NOT EXISTS daily_run_limit int not null default 3;
 `);
 const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
 const password = process.env.ADMIN_PASSWORD;
 if (!email || !password || password.length < 12) throw Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters)');
 const existing = await pool.query('SELECT id FROM users WHERE email=$1',[email]);
 if (!existing.rowCount) await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[randomUUID(),email,await hash(password,12)]);
}
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T> { return schema.parse(input); }
app.setErrorHandler((error,_,reply) => {
 if(error instanceof z.ZodError) return reply.code(400).send({error:'Некорректные данные',details:error.flatten()});
 app.log.error(error);
 const err = error as Error & {statusCode?:number};
 const status = typeof err.statusCode==='number' && err.statusCode>=400 && err.statusCode<500 ? err.statusCode : 500;
 return reply.code(status).send({error:status<500?err.message:'Ошибка сервера'});
});
app.post('/api/login',async(req,reply)=>{
 const {email,password}=parse(z.object({email:z.string().trim().min(3).max(254).regex(/^[^\s@]+@[^\s@]+$/),password:z.string()}),req.body);
 const u=await pool.query('SELECT * FROM users WHERE email=$1',[email.toLowerCase()]);
 if(!u.rowCount || !(await compare(password,u.rows[0].password_hash))) return reply.code(401).send({error:'Неверный логин или пароль'});
 return {token:await new SignJWT({email:u.rows[0].email}).setProtectedHeader({alg:'HS256'}).setSubject(u.rows[0].id).setIssuedAt().setExpirationTime('12h').sign(jwtKey)};
});
app.addHook('preHandler',async(req,reply)=>{
 if(req.url === '/api/login' || req.url === '/api/health' || !req.url.startsWith('/api/')) return;
 try {const raw=req.headers.authorization?.replace(/^Bearer /,'');if(!raw)throw Error('no token');const {payload}=await jwtVerify(raw,jwtKey);(req as any).userId=payload.sub;}
 catch{return reply.code(401).send({error:'Требуется вход'});}
});
const uid=(req:any):string=>req.userId;
async function canAccess(projectId:string,userId:string) {
 const r=await pool.query('SELECT 1 FROM memberships WHERE project_id=$1 AND user_id=$2',[projectId,userId]);
 return !!r.rowCount;
}
async function access(req:any,reply:any,projectId:string) {
 if(!await canAccess(projectId,uid(req))){reply.code(403).send({error:'Нет доступа к проекту'});return false;}return true;
}
app.get('/api/health',async()=>({ok:true}));
// Codex uses a personal ChatGPT entitlement. Keep access restricted to the bootstrap administrator.
app.addHook('preHandler',async(req,reply)=>{
 if(!req.url.startsWith('/api/codex/'))return;
 const email=(await pool.query('SELECT email FROM users WHERE id=$1',[(req as any).userId])).rows[0]?.email;
 if(!email || email!==process.env.ADMIN_EMAIL?.trim().toLowerCase())return reply.code(403).send({error:'Только администратор может подключать Codex'});
});
// Local-only Codex runner. The service is not exposed on a host port.
// Requests reach it only after the ordinary application session check.
const codexUrl=process.env.CODEX_RUNNER_URL||'http://codex:4300';
async function codexCall(path:string,method:'GET'|'POST'='GET') {
 const response=await fetch(codexUrl+path,{method,signal:AbortSignal.timeout(path==='/test'?125000:15000)});
 const body=await response.json().catch(()=>({error:'Некорректный ответ Codex'}));
 if(!response.ok)throw Error(body.error||'Codex недоступен');
 return body;
}
app.get('/api/codex/status',async(_req,reply)=>{
 try{return await codexCall('/status');}
 catch(e){return reply.code(503).send({connected:false,error:e instanceof Error?e.message:'Контейнер Codex не отвечает'});}
});
app.post('/api/codex/login',async(_req,reply)=>{
 try{return await codexCall('/login','POST');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Ошибка входа в Codex'});}
});
app.get('/api/codex/device',async(_req,reply)=>{
 try{return await codexCall('/device');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Codex недоступен'});}
});
app.post('/api/codex/logout',async(_req,reply)=>{
 try{return await codexCall('/logout','POST');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Ошибка отключения Codex'});}
});
app.post('/api/codex/test',async(_req,reply)=>{
 try{return await codexCall('/test','POST');}
 catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Тест Codex не прошёл'});}
});

// Project GitHub binding: tokens are reused from the encrypted connections store,
// never copied to project tables or returned to the browser.
const repositoryNameSchema=z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
async function gitHubRepository(token:string,name:string) {
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),12000);
 try {
  const response=await fetch('https://api.github.com/repos/'+name,{
   headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'},
   signal:controller.signal
  });
  if(response.status===401)throw Object.assign(new Error('Токен GitHub недействителен'),{statusCode:400});
  if(response.status===403)throw Object.assign(new Error('GitHub запретил доступ: проверь разрешения токена и лимиты'),{statusCode:400});
  if(response.status===404)throw Object.assign(new Error('Репозиторий не найден или токен не имеет к нему доступа'),{statusCode:400});
  if(!response.ok)throw Object.assign(new Error('GitHub вернул HTTP '+response.status),{statusCode:502});
  const data=await response.json() as any;
  if(data.full_name?.toLowerCase()!==name.toLowerCase() || data.archived || data.disabled)throw Object.assign(new Error('Репозиторий недоступен для работы'),{statusCode:400});
  if(data.permissions?.push!==true)throw Object.assign(new Error('Токен не имеет права записи в репозиторий. Выдай Contents: Read and write и Metadata: Read'),{statusCode:400});
  return {name:data.full_name as string,branch:data.default_branch as string,canPush:data.permissions?.push===true,private:data.private===true};
 }finally{clearTimeout(timeout);}
}
app.get('/api/projects/:id/git',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const r=await pool.query('SELECT g.repository,g.default_branch,g.target_branch,g.connection_id,c.name AS connection_name FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.owner_id=$2',[id,uid(req)]);
 return r.rows[0]||null;
});
app.put('/api/projects/:id/git',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const {repository,connectionId,targetBranch}=parse(z.object({repository:repositoryNameSchema,connectionId:z.string().uuid(),targetBranch:z.string().regex(/^[a-zA-Z0-9_./-]{1,150}$/).optional()}),req.body);
 const r=await pool.query('SELECT provider,secret_encrypted FROM connections WHERE id=$1 AND owner_id=$2',[connectionId,uid(req)]);
 if(!r.rowCount || r.rows[0].provider!=='github_token')return reply.code(400).send({error:'Выбери своё подключение типа GitHub token'});
 const packed=Buffer.from(r.rows[0].secret_encrypted,'base64');
 const decipher=createDecipheriv('aes-256-gcm',encryptionKey,packed.subarray(0,12));
 decipher.setAuthTag(packed.subarray(12,28));
 const token=Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]).toString('utf8');
 let info;
 try{info=await gitHubRepository(token,repository);}
 catch(e){const err=e as Error & {statusCode?:number};return reply.code(err.statusCode||502).send({error:err.message||'Ошибка проверки GitHub'});}
 const branch=targetBranch||info.branch;
 const branchCheck=await fetch('https://api.github.com/repos/'+info.name+'/branches/'+encodeURIComponent(branch),{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},signal:AbortSignal.timeout(12000)});
 if(!branchCheck.ok)return reply.code(400).send({error:'Целевая ветка GitHub не найдена или недоступна'});
 await pool.query('INSERT INTO project_git_repositories(project_id,connection_id,repository,default_branch,target_branch) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id) DO UPDATE SET connection_id=$2,repository=$3,default_branch=$4,target_branch=$5,updated_at=now()',[id,connectionId,info.name,info.branch,branch]);

 return {repository:info.name,default_branch:info.branch,target_branch:branch,connection_id:connectionId,can_push:info.canPush,private:info.private};
});
app.delete('/api/projects/:id/git',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 await pool.query('DELETE FROM project_git_repositories WHERE project_id=$1',[id]);
 return {ok:true};
});


// A limited allowlist and manual trigger prevent runaway usage.
const allowedModels=z.enum(['gpt-6-luna','gpt-6-sol','gpt-6.1-sol']);
const projectAiSchema=z.object({
 model:allowedModels,
 reasoning:z.enum(['low','medium']),
 max_runtime_seconds:z.number().int().min(90).max(900),
 daily_run_limit:z.number().int().min(1).max(10),
 enabled:z.boolean()
});
const aiDefaults={model:'gpt-6-luna',reasoning:'low',max_runtime_seconds:300,daily_run_limit:3,enabled:false};
const runnerKey=process.env.RUNNER_SHARED_SECRET||'';
if(!runnerKey || runnerKey.length<32)throw Error('Set RUNNER_SHARED_SECRET (32+ chars)');
async function agentCall(path:string,method:'GET'|'POST'='GET',body?:unknown){
 const resp=await fetch(codexUrl+path,{
  method,
  headers:{'X-Runner-Secret':runnerKey,...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,
  signal:AbortSignal.timeout(15000)
 });
 const data=await resp.json().catch(()=>({error:'Некорректный ответ исполнителя'}));
 if(!resp.ok)throw Object.assign(new Error(String(data.error||'Ошибка исполнителя').slice(0,600)),{statusCode:resp.status===409?409:503});
 return data as any;
}
async function requireAdmin(req:any,reply:any){
 const u=await pool.query('SELECT email FROM users WHERE id=$1',[uid(req)]);
 if(u.rows[0]?.email!==process.env.ADMIN_EMAIL?.trim().toLowerCase()){
  reply.code(403).send({error:'На первом этапе запуск AI разрешён только администратору'});
  return false;
 }
 return true;
}
function decryptToken(packedText:string){
 const bytes=Buffer.from(packedText,'base64');
 const d=createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(0,12));
 d.setAuthTag(bytes.subarray(12,28));
 return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');
}
app.get('/api/projects/:id/ai-settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const row=await pool.query('SELECT model,reasoning,max_runtime_seconds,daily_run_limit,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
 return row.rows[0]||aiDefaults;
});
app.put('/api/projects/:id/ai-settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const p=projectAiSchema.parse(req.body);
 await pool.query("INSERT INTO project_ai_settings(project_id,model,reasoning,max_runtime_seconds,daily_run_limit,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id) DO UPDATE SET model=EXCLUDED.model,reasoning=EXCLUDED.reasoning,max_runtime_seconds=EXCLUDED.max_runtime_seconds,daily_run_limit=EXCLUDED.daily_run_limit,enabled=EXCLUDED.enabled,updated_at=now()",
 [id,p.model,p.reasoning,p.max_runtime_seconds,p.daily_run_limit,p.enabled]);
 return p;
});
app.get('/api/projects/:id/ai-runs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const runs=await pool.query('SELECT id,task_id,model,status,branch,pr_url,message,created_at,completed_at FROM ai_task_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',[id]);
 return runs.rows;
});
app.post('/api/projects/:id/tasks/:taskId/run-ai',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const t=await pool.query('SELECT id,title,description,stage,analysis_state,related_task_ids FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!t.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 if(t.rows[0].stage!=='development'||t.rows[0].analysis_state!=='approved')return reply.code(409).send({error:'Подтверди завершение анализа и отправь задачу в разработку'});
 const relatedIds=(t.rows[0].related_task_ids||[]) as string[];
 const related=relatedIds.length?(await pool.query('SELECT id,title,description,stage FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[])',[id,relatedIds])).rows:[];
 const blockers=related.filter(x=>['development','merge_queue'].includes(x.stage));
 if(blockers.length)return reply.code(409).send({error:'Связанные задачи ещё в разработке или ожидают слияния: '+blockers.map(x=>x.title).join(', ')});

 const settings=await pool.query('SELECT model,reasoning,max_runtime_seconds,daily_run_limit,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
 const ai=settings.rows[0]||aiDefaults;
 if(!ai.enabled)return reply.code(409).send({error:'Включи ручной запуск AI в настройках проекта'});
 const usage=await pool.query("SELECT count(*)::int AS count FROM ai_task_runs WHERE project_id=$1 AND created_at > now() - interval '24 hours'",[id]);
 if(usage.rows[0].count >= ai.daily_run_limit)return reply.code(429).send({error:'Достигнут дневной лимит AI-запусков этого проекта'});
 const git=await pool.query("SELECT g.repository,g.default_branch,g.target_branch,c.secret_encrypted FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.owner_id=$2 AND c.provider='github_token'",[id,uid(req)]);
 if(!git.rowCount)return reply.code(409).send({error:'Сначала привяжи GitHub-репозиторий с токеном'});
 const active=await pool.query("SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",[id]);
 if(active.rowCount)return reply.code(409).send({error:'В этом проекте уже выполняется AI-задача'});
 const runId=randomUUID(),token=decryptToken(git.rows[0].secret_encrypted);
 const job={id:runId,taskId,repository:git.rows[0].repository,baseBranch:git.rows[0].target_branch||git.rows[0].default_branch,
  token,model:ai.model,reasoning:ai.reasoning,maxRuntimeSeconds:ai.max_runtime_seconds,
  title:t.rows[0].title,description:t.rows[0].description,relatedTasks:related.map(x=>({title:x.title,description:x.description.slice(0,1500),stage:x.stage}))};
 await pool.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status) VALUES($1,$2,$3,$4,$5,'queued')",
 [runId,id,taskId,uid(req),ai.model]);
 try{
  await agentCall('/jobs','POST',job);
  await pool.query("UPDATE ai_task_runs SET status='running' WHERE id=$1",[runId]);
 }catch(e){
  const err=e as Error&{statusCode?:number};
  await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,err.message]);
  return reply.code(err.statusCode||503).send({error:err.message});
 }
 return reply.code(202).send({id:runId,task_id:taskId,status:'running',model:ai.model});
});
app.get('/api/projects/:id/ai-runs/:runId',async(req:any,reply)=>{
 const {id,runId}=parse(z.object({id:z.string().uuid(),runId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const run=await pool.query('SELECT id,task_id,model,status,branch,pr_url,message,created_at,completed_at FROM ai_task_runs WHERE id=$1 AND project_id=$2',[runId,id]);
 if(!run.rowCount)return reply.code(404).send({error:'Запуск не найден'});
 const current=run.rows[0];
 if(current.status==='running'||current.status==='queued'){
  try{
   const remote=await agentCall('/jobs/'+runId);
   if(['completed','failed'].includes(remote.status)){
    await pool.query('UPDATE ai_task_runs SET status=$2,branch=$3,pr_url=$4,message=$5,completed_at=now() WHERE id=$1',
     [runId,remote.status,remote.branch||null,remote.prUrl||null,String(remote.message||'').slice(0,2000)]);
    if(remote.status==='completed'&&remote.prUrl){
     const prMatch=/\/pull\/(\d+)$/.exec(remote.prUrl);
     await pool.query("UPDATE tasks SET stage='merge_queue',git_branch=$2,pr_url=$3,pr_number=$4,updated_at=now() WHERE id=$1 AND project_id=$5",[current.task_id,remote.branch,remote.prUrl,prMatch?Number(prMatch[1]):null,id]);
    }
    return {...current,status:remote.status,branch:remote.branch,pr_url:remote.prUrl,message:remote.message};
   }
   return {...current,status:remote.status,message:remote.message||''};
  }catch(e){
   const problem=e instanceof Error?e.message:'ошибка';
   if(problem.includes('Задача не найдена (возможно, исполнитель перезапущен)')){
    await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,'Исполнитель перезапустился; повтори запуск задачи']);
    return {...current,status:'failed',message:'Исполнитель перезапустился; повтори запуск задачи'};
   }
   return {...current,message:'Нет связи с исполнителем: '+problem};
  }
 }
 return current;
});


async function mergeTaskPr(projectId:string,taskId:string,userId:string){
 const info=await pool.query("SELECT t.id,t.title,t.stage,t.pr_number,t.pr_url,g.repository,g.target_branch,g.default_branch,c.secret_encrypted FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 WHERE t.id=$1 AND t.project_id=$2",
 [taskId,projectId,userId]);
 if(!info.rowCount)throw Object.assign(new Error('Задача или подключение GitHub не найдены'),{statusCode:404});
 const row=info.rows[0];
 if(row.stage!=='merge_queue'||!row.pr_number)throw Object.assign(new Error('Задача не находится в очереди слияния или не содержит PR'),{statusCode:409});
 const token=decryptToken(row.secret_encrypted);
 const base='https://api.github.com/repos/'+row.repository;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const pull=await fetch(base+'/pulls/'+row.pr_number,{headers,signal:AbortSignal.timeout(15000)});
 if(!pull.ok)throw Object.assign(new Error('Не удалось получить PR: GitHub HTTP '+pull.status),{statusCode:502});
 const pr=await pull.json() as any;
 if(pr.merged){
  await pool.query("UPDATE tasks SET stage='documentation',updated_at=now() WHERE id=$1",[taskId]);
  return {taskId,status:'merged',url:row.pr_url};
 }
 if(pr.state!=='open'||pr.draft)throw Object.assign(new Error('PR закрыт или находится в черновике; переведи его в Ready for review'),{statusCode:409});
 if(pr.base?.ref!==(row.target_branch||row.default_branch))throw Object.assign(new Error('Целевая ветка PR отличается от настроенной ветки проекта'),{statusCode:409});
 if(pr.mergeable!==true || ['dirty','blocked','unknown'].includes(pr.mergeable_state))
  throw Object.assign(new Error('PR содержит конфликт или ещё не готов к слиянию; обнови статус GitHub'),{statusCode:409});
 const checks=await fetch(base+'/commits/'+encodeURIComponent(pr.head.sha)+'/check-runs?per_page=100',{headers,signal:AbortSignal.timeout(15000)});
 if(!checks.ok)throw Object.assign(new Error('Не удалось проверить CI в GitHub: HTTP '+checks.status),{statusCode:502});
 const checkData=await checks.json() as any;
 const bad=(checkData.check_runs||[]).filter((c:any)=>c.status!=='completed'||!['success','neutral','skipped'].includes(c.conclusion));
 if(bad.length)throw Object.assign(new Error('PR ожидает проверок CI или есть ошибки: '+bad.map((c:any)=>c.name).slice(0,5).join(', ')),{statusCode:409});
 const merge=await fetch(base+'/pulls/'+row.pr_number+'/merge',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},
  body:JSON.stringify({sha:pr.head.sha,merge_method:'merge',commit_title:'Merge AI task: '+String(row.title).slice(0,150)}),
  signal:AbortSignal.timeout(25000)});
 const merged=await merge.json().catch(()=>({})) as any;
 if(!merge.ok || !merged.merged)throw Object.assign(new Error('GitHub отклонил слияние: '+String(merged.message||merge.status).slice(0,240)),{statusCode:409});
 await pool.query("UPDATE tasks SET stage='done',updated_at=now() WHERE id=$1",[taskId]);
 await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'merged',$4)",[randomUUID(),taskId,userId,row.pr_url]);
 return {taskId,status:'merged',url:row.pr_url};
}
app.post('/api/projects/:id/tasks/:taskId/merge',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 try{return await mergeTaskPr(id,taskId,uid(req));}
 catch(e){const err=e as Error&{statusCode?:number};return reply.code(err.statusCode||502).send({error:err.message});}
});
app.post('/api/projects/:id/merge-ready',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const tasks=await pool.query("SELECT id FROM tasks WHERE project_id=$1 AND stage='merge_queue' ORDER BY created_at LIMIT 30",[id]);
 const results=[];
 for(const row of tasks.rows){
  try{results.push(await mergeTaskPr(id,row.id,uid(req)));}
  catch(e){results.push({taskId:row.id,status:'skipped',reason:e instanceof Error?e.message:'Неизвестная ошибка'});}
 }
 return {results};
});

app.get('/api/me',async(req)=>{const r=await pool.query('SELECT id,email FROM users WHERE id=$1',[uid(req)]);return r.rows[0];});
app.get('/api/projects',async(req)=>{const r=await pool.query('SELECT p.* FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.created_at DESC',[uid(req)]);return r.rows;});
app.post('/api/projects',async(req,reply)=>{
 const {name,description}=parse(z.object({name:z.string().trim().min(1).max(120),description:z.string().max(5000).default('')}),req.body);
 const id=randomUUID(),client=await pool.connect();
 try{await client.query('BEGIN');
 await client.query('INSERT INTO projects(id,name,description,owner_id) VALUES($1,$2,$3,$4)',[id,name,description,uid(req)]);
 await client.query('INSERT INTO memberships(project_id,user_id,role) VALUES($1,$2,$3)',[id,uid(req),'admin']);
 for(let i=0;i<workflowDefaults.length;i++){const [stage,label,mode]=workflowDefaults[i];await client.query('INSERT INTO workflow_stages VALUES($1,$2,$3,$4,$5)',[id,stage,label,mode,i]);}
 await client.query('COMMIT');return reply.code(201).send({id,name,description});}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.get('/api/projects/:id',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const r=await pool.query('SELECT * FROM projects WHERE id=$1',[id]);return r.rows[0];});
app.get('/api/projects/:id/workflow',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT stage,label,mode,position FROM workflow_stages WHERE project_id=$1 ORDER BY position',[id])).rows;});
app.patch('/api/projects/:id/workflow/:stage',async(req:any,reply)=>{
 const {id,stage}=parse(z.object({id:z.string().uuid(),stage:validStages}),req.params);
 if(!await access(req,reply,id))return;
 const {mode}=parse(z.object({mode:validMode}),req.body);
 await pool.query('UPDATE workflow_stages SET mode=$1 WHERE project_id=$2 AND stage=$3',[mode,id,stage]);
 return {ok:true};
});
app.get('/api/projects/:id/tasks',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT * FROM tasks WHERE project_id=$1 ORDER BY position, created_at',[id])).rows;});
app.post('/api/projects/:id/tasks',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(300),description:z.string().max(20000).default(''),type:z.enum(['task','bug','improvement','epic']).default('task'),parent_id:z.string().uuid().nullable().optional()}),req.body);
 if(data.parent_id){const p=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[data.parent_id,id]);if(!p.rowCount)return reply.code(400).send({error:'Родительская задача не найдена'});}
 const taskId=randomUUID();
 await pool.query('INSERT INTO tasks(id,project_id,title,description,type,parent_id,position) VALUES($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2))',[taskId,id,data.title,data.description,data.type,data.parent_id||null]);
 await pool.query('INSERT INTO task_events(id,task_id,actor_id,event) VALUES($1,$2,$3,$4)',[randomUUID(),taskId,uid(req),'created']);
 return reply.code(201).send({id:taskId});
});
app.patch('/api/projects/:id/tasks/:taskId',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(300).optional(),description:z.string().max(20000).optional(),stage:validStages.optional()}),req.body);
 const old=await pool.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);if(!old.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 const t=old.rows[0];
 if(data.stage && data.stage!==t.stage){
  if(!['backlog','analysis'].includes(t.stage)||!['backlog','analysis'].includes(data.stage))
   return reply.code(409).send({error:'Перемещение между разработкой, PR и завершением выполняется только через действия workflow'});
 }
 await pool.query('UPDATE tasks SET title=$1,description=$2,stage=$3,updated_at=now() WHERE id=$4',[data.title??t.title,data.description??t.description,data.stage??t.stage,taskId]);
 if(data.stage && data.stage!==t.stage)await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'stage_changed',t.stage+' → '+data.stage]);
 return {ok:true};
});
app.get('/api/projects/:id/tasks/:taskId/events',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const r=await pool.query('SELECT e.* FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.id=$1 AND t.project_id=$2 ORDER BY e.created_at DESC',[taskId,id]);return r.rows;
});
const docParent = z.string().uuid().nullable().optional();
async function validDocParent(projectId:string, docId:string|null, parentId:string|null) {
 if(!parentId)return true;
 const parent=await pool.query('SELECT id FROM documents WHERE id=$1 AND project_id=$2',[parentId,projectId]);
 if(!parent.rowCount || parentId===docId)return false;
 if(docId) {
  const ancestors=await pool.query(`WITH RECURSIVE chain AS (
   SELECT id,parent_id FROM documents WHERE id=$1 AND project_id=$2
   UNION ALL
   SELECT d.id,d.parent_id FROM documents d JOIN chain c ON c.parent_id=d.id WHERE d.project_id=$2
  ) SELECT 1 FROM chain WHERE id=$3 LIMIT 1`,[parentId,projectId,docId]);
  if(ancestors.rowCount)return false;
 }
 return true;
}
app.get('/api/projects/:id/docs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 return (await pool.query('SELECT * FROM documents WHERE project_id=$1 ORDER BY title ASC, id ASC',[id])).rows;
});
app.post('/api/projects/:id/docs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const {title,body,parent_id}=parse(z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000).default(''),parent_id:docParent}),req.body);
 if(!await validDocParent(id,null,parent_id??null))return reply.code(400).send({error:'Родительская страница не найдена в проекте'});
 const docId=randomUUID();
 await pool.query('INSERT INTO documents(id,project_id,title,body,parent_id) VALUES($1,$2,$3,$4,$5)',[docId,id,title,body,parent_id??null]);
 return reply.code(201).send({id:docId});
});
app.patch('/api/projects/:id/docs/:docId',async(req:any,reply)=>{
 const {id,docId}=parse(z.object({id:z.string().uuid(),docId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000),parent_id:docParent}),req.body);
 const old=await pool.query('SELECT parent_id FROM documents WHERE id=$1 AND project_id=$2',[docId,id]);
 if(!old.rowCount)return reply.code(404).send({error:'Документ не найден'});
 const parentId=data.parent_id===undefined?old.rows[0].parent_id:data.parent_id;
 if(!await validDocParent(id,docId,parentId))return reply.code(400).send({error:'Нельзя переместить страницу в себя, своего потомка или другой проект'});
 await pool.query('UPDATE documents SET title=$1,body=$2,parent_id=$3,updated_at=now() WHERE id=$4 AND project_id=$5',[data.title,data.body,parentId,docId,id]);
 return {ok:true};
});
app.get('/api/connections',async(req)=>{return (await pool.query('SELECT id,name,provider,created_at FROM connections WHERE owner_id=$1 ORDER BY created_at DESC',[uid(req)])).rows;});
app.post('/api/connections',async(req,reply)=>{
 const {name,provider,secret}=parse(z.object({name:z.string().min(1).max(100),provider:z.enum(['openai_api','github_token']),secret:z.string().min(8).max(2000)}),req.body);
 const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
 const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);const packed=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
 const id=randomUUID();await pool.query('INSERT INTO connections(id,owner_id,name,provider,secret_encrypted) VALUES($1,$2,$3,$4,$5)',[id,uid(req),name,provider,packed]);return reply.code(201).send({id,name,provider});
});
app.get('/api/projects/:id/connections',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT c.id,c.name,c.provider FROM connections c JOIN project_connections pc ON pc.connection_id=c.id WHERE pc.project_id=$1 AND c.owner_id=$2',[id,uid(req)])).rows;});
app.post('/api/projects/:id/connections',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const {connectionId}=parse(z.object({connectionId:z.string().uuid()}),req.body);const r=await pool.query('INSERT INTO project_connections(project_id,connection_id) SELECT $1,id FROM connections WHERE id=$2 AND owner_id=$3 ON CONFLICT DO NOTHING RETURNING connection_id',[id,connectionId,uid(req)]);if(!r.rowCount)return reply.code(400).send({error:'Подключение не найдено или уже добавлено'});return {ok:true};});
registerAssistantRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey});
registerKnowledgeRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey});
async function main(){await dbInit();await app.listen({port:Number(process.env.PORT||3001),host:'0.0.0.0'});}
main().catch(e=>{console.error(e);process.exit(1);});

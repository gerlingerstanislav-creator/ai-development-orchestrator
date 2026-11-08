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
 -- Keep UUID as the internal stable identifier; expose a monotonic human task number.
 CREATE SEQUENCE IF NOT EXISTS task_display_number_seq;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS display_number bigint;
 ALTER TABLE tasks ALTER COLUMN display_number SET DEFAULT nextval('task_display_number_seq');
 UPDATE tasks SET display_number=nextval('task_display_number_seq') WHERE display_number IS NULL;
 SELECT setval('task_display_number_seq',GREATEST(COALESCE((SELECT MAX(display_number) FROM tasks),0),1),true);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_display_number ON tasks(display_number);
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS analysis_state text NOT NULL DEFAULT 'new';
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS clarification_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS related_task_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dependency_source text NOT NULL DEFAULT 'manual';
 CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(project_id,depends_on_task_id);
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS git_branch text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_url text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_number int;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_base_branch text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS documentation_updated_at timestamptz;
 CREATE TABLE IF NOT EXISTS task_events (id uuid primary key, task_id uuid references tasks(id) on delete cascade, actor_id uuid references users(id), event text not null, detail text not null default '', created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS documents (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, title text not null, body text not null default '', updated_at timestamptz not null default now());
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES documents(id) ON DELETE SET NULL;
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS import_source text;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_import_source ON documents(project_id,import_source) WHERE import_source IS NOT NULL;
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
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS created_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'project';
 CREATE INDEX IF NOT EXISTS idx_assistant_channel ON assistant_messages(project_id,channel,created_at);
 CREATE INDEX IF NOT EXISTS idx_assistant_messages_project ON assistant_messages(project_id,task_id,created_at);
 CREATE TABLE IF NOT EXISTS assistant_usage (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, actor_id uuid not null references users(id), created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_assistant_usage_project ON assistant_usage(project_id,created_at);
 CREATE TABLE IF NOT EXISTS service_ai_limits (id int primary key default 1 check(id=1), chat_requests_per_24h int not null default 0, development_runs_per_24h int not null default 0, max_runtime_seconds int not null default 1800, updated_at timestamptz not null default now());
 INSERT INTO service_ai_limits(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
 CREATE TABLE IF NOT EXISTS project_ai_settings (project_id uuid primary key references projects(id) on delete cascade, model text not null default 'gpt-6-luna', reasoning text not null default 'low', max_runtime_seconds int not null default 300, enabled boolean not null default false, updated_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS ai_token_usage (
  id uuid primary key, project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  source_id uuid not null unique, operation text not null, model text not null,
  input_tokens bigint not null default 0, cached_input_tokens bigint not null default 0, output_tokens bigint not null default 0,
  created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_ai_token_usage_project ON ai_token_usage(project_id,created_at);
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
app.get('/api/codex/rate-limits',async(req:any,reply)=>{
 if(!await requireAdmin(req,reply))return;
 try{
  const response=await fetch(codexUrl+'/usage-limits',{headers:{'X-Runner-Secret':runnerKey},signal:AbortSignal.timeout(25000)});
  const body=await response.json().catch(()=>({error:'Ответ Codex не удалось прочитать'}));
  if(!response.ok)return reply.code(response.status===409?409:503).send({error:String((body as any).error||'Лимиты недоступны')});
  return body;
 }catch(e){return reply.code(503).send({error:e instanceof Error?e.message:'Не удалось получить лимиты Codex'});}
});
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
 const ghHeaders={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const baseUrl='https://api.github.com/repos/'+info.name;
 let branchCheck=await fetch(baseUrl+'/branches/'+encodeURIComponent(branch),{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
 let initialized=false;
 if(branchCheck.status===404){
  const branchList=await fetch(baseUrl+'/branches?per_page=1',{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
  if(!branchList.ok)return reply.code(502).send({error:'Не удалось проверить ветки GitHub'});
  const branches=await branchList.json() as any[];
  if(branches.length===0){
   // GitHub returns default_branch even for an empty repository. The first commit
   // creates that default branch. Never initialize an existing repository.
   const init=await fetch(baseUrl+'/contents/README.md',{method:'PUT',headers:{...ghHeaders,'Content-Type':'application/json'},
    body:JSON.stringify({message:'Initial commit: initialize repository for AI Development Orchestrator',
      content:Buffer.from('# '+info.name.split('/')[1]+'\n\nПроект подключён к AI Development Orchestrator.\n').toString('base64')}),
    signal:AbortSignal.timeout(20000)});
   if(!init.ok){
    const details=await init.json().catch(()=>({})) as any;
    return reply.code(409).send({error:'Не удалось создать первый коммит: '+String(details.message||init.status).slice(0,250)});
   }
   initialized=true;
   branchCheck=await fetch(baseUrl+'/branches/'+encodeURIComponent(branch),{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
  }
 }
 if(!branchCheck.ok)return reply.code(400).send({error:'Целевая ветка GitHub не найдена. Для пустого репозитория первый коммит создаётся в ветке '+info.branch+'. Укажи её или создай нужную ветку.'});
 const prAccess=await fetch(baseUrl+'/pulls?state=open&per_page=1',{headers:ghHeaders,signal:AbortSignal.timeout(12000)});
 if(prAccess.status===403)return reply.code(409).send({error:'Подключение GitHub не сохранено: токен не имеет доступа к Pull Requests (HTTP 403). На github.com/settings/personal-access-tokens включи Repository permissions → Pull requests → Read and write для '+info.name+' и повтори проверку.'});
 if(!prAccess.ok)return reply.code(502).send({error:'Не удалось проверить права доступа к Pull Requests: GitHub HTTP '+prAccess.status});
 // Checks and commit statuses may not be readable by fine-grained tokens.
 // Do not reject repository binding: GitHub enforces required checks at merge time.

  await pool.query('INSERT INTO project_git_repositories(project_id,connection_id,repository,default_branch,target_branch) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id) DO UPDATE SET connection_id=$2,repository=$3,default_branch=$4,target_branch=$5,updated_at=now()',[id,connectionId,info.name,info.branch,branch]);

 return {repository:info.name,default_branch:info.branch,target_branch:branch,connection_id:connectionId,can_push:info.canPush,private:info.private,initialized};
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
 enabled:z.boolean()
});
const aiDefaults={model:'gpt-6-luna',reasoning:'low',enabled:false};
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
 const row=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
 return row.rows[0]||aiDefaults;
});
app.put('/api/projects/:id/ai-settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const p=projectAiSchema.parse(req.body);
 await pool.query("INSERT INTO project_ai_settings(project_id,model,reasoning,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET model=EXCLUDED.model,reasoning=EXCLUDED.reasoning,enabled=EXCLUDED.enabled,updated_at=now()",
 [id,p.model,p.reasoning,p.enabled]);
 return p;
});
app.get('/api/ai/token-usage',async(req:any,reply)=>{
 if(!await requireAdmin(req,reply))return;
 const totals=await pool.query("SELECT COALESCE(SUM(input_tokens),0)::text AS input_tokens,COALESCE(SUM(cached_input_tokens),0)::text AS cached_input_tokens,COALESCE(SUM(output_tokens),0)::text AS output_tokens,COUNT(*)::int AS requests FROM ai_token_usage");
 const latest=await pool.query("SELECT operation,model,input_tokens::text,cached_input_tokens::text,output_tokens::text,created_at FROM ai_token_usage ORDER BY created_at DESC LIMIT 20");
 return {totals:totals.rows[0],latest:latest.rows};
});
app.get('/api/projects/:id/token-usage',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const result=await pool.query("SELECT COALESCE(SUM(input_tokens),0)::text AS input_tokens,COALESCE(SUM(cached_input_tokens),0)::text AS cached_input_tokens,COALESCE(SUM(output_tokens),0)::text AS output_tokens,COUNT(*)::int AS requests FROM ai_token_usage WHERE project_id=$1",[id]);
 return result.rows[0];
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
 const t=await pool.query('SELECT id,title,description,stage,analysis_state,related_task_ids,depends_on_task_id,pr_base_branch,git_branch FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!t.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 if(t.rows[0].stage!=='development'||t.rows[0].analysis_state!=='approved')return reply.code(409).send({error:'Подтверди завершение анализа и отправь задачу в разработку'});
 const relatedIds=(t.rows[0].related_task_ids||[]) as string[];
 const related=relatedIds.length?(await pool.query('SELECT id,title,description,stage FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[])',[id,relatedIds])).rows:[];
 // Informationally related tasks never block development; only a typed code dependency does.
 const parentId=t.rows[0].depends_on_task_id as string|null;
 let parentBranch:string|null=null;
 if(parentId){
  const p=await pool.query('SELECT id,title,stage,git_branch,pr_url FROM tasks WHERE project_id=$1 AND id=$2',[id,parentId]);
  if(!p.rowCount)return reply.code(409).send({error:'Задача-основание отсутствует в проекте'});
  const parent=p.rows[0];
  if(['documentation','done'].includes(parent.stage))parentBranch=null;
  else if(parent.stage==='merge_queue'&&parent.git_branch&&parent.pr_url)parentBranch=parent.git_branch;
  else return reply.code(409).send({error:'Ожидание зависимости: сначала заверши разработку задачи «'+parent.title+'» до открытого PR. После этого текущая задача сможет стартовать от её ветки.'});
 }
 const settings=await pool.query('SELECT model,reasoning,max_runtime_seconds,daily_run_limit,enabled FROM project_ai_settings WHERE project_id=$1',[id]);
 const ai=settings.rows[0]||aiDefaults;
 if(!ai.enabled)return reply.code(409).send({error:'Включи ручной запуск AI в настройках проекта'});
 const maxRuntimeSeconds=1800; // Technical safeguard only; not a usage quota.
 const git=await pool.query("SELECT g.repository,g.default_branch,g.target_branch,c.secret_encrypted FROM project_git_repositories g JOIN connections c ON c.id=g.connection_id WHERE g.project_id=$1 AND c.owner_id=$2 AND c.provider='github_token'",[id,uid(req)]);
 if(!git.rowCount)return reply.code(409).send({error:'Сначала привяжи GitHub-репозиторий с токеном'});
 const active=await pool.query("SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running') LIMIT 1",[id,taskId]);
 if(active.rowCount)return reply.code(409).send({error:'Эта задача уже выполняется или находится в очереди'});
 // Finish Git work from a previously successful Codex run before consuming any new tokens.
 // This also recovers from GitHub 403 after the user fixes token permissions.
 try{
  const finished=await finishExistingTaskBranch(id,taskId,uid(req));
  if(finished)return reply.send({status:'completed',recovered:true,pr_url:finished.pr_url,branch:finished.branch,task_id:taskId,
   message:'Разработка уже выполнена. Pull Request создан автоматически без повторного запуска Codex.'});
 }catch(e){
  const err=e as Error&{statusCode?:number};
  return reply.code(err.statusCode||503).send({error:err.message});
 }
 const rules=await pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 80',[id]);
  const runId=randomUUID(),token=decryptToken(git.rows[0].secret_encrypted);
 const branch=parentBranch||(git.rows[0].target_branch||git.rows[0].default_branch);
 const check=await fetch('https://api.github.com/repos/'+git.rows[0].repository+'/branches/'+encodeURIComponent(branch),{
  headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
  signal:AbortSignal.timeout(12000)});
 if(!check.ok)return reply.code(409).send({error:check.status===404
  ?'Ветка '+branch+' не существует в '+git.rows[0].repository+'. Открой настройки GitHub проекта и повторно проверь подключение.'
  :'Не удалось подтвердить доступ к ветке '+branch+' (GitHub HTTP '+check.status+')'});
 const pullsPermission=await fetch('https://api.github.com/repos/'+git.rows[0].repository+'/pulls?state=open&per_page=1',{
  headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'},
  signal:AbortSignal.timeout(12000)});
 if(pullsPermission.status===403)return reply.code(409).send({error:'GitHub запрещает чтение Pull Request (403). Добавь подключённому токену права Pull requests: Read and write для этого репозитория. Codex не запущен, лимит модели не потрачен.'});
 if(!pullsPermission.ok)return reply.code(502).send({error:'Не удалось проверить доступ к PR до разработки: GitHub HTTP '+pullsPermission.status});

 const job={id:runId,taskId,repository:git.rows[0].repository,baseBranch:branch,
  token,model:ai.model,reasoning:ai.reasoning,maxRuntimeSeconds,
  title:t.rows[0].title,description:t.rows[0].description,dependsOnTaskId:parentId,projectRules:rules.rows.map(x=>x.body).join('\n').slice(0,12000),relatedTasks:related.map(x=>({title:x.title,description:x.description.slice(0,1500),stage:x.stage}))};
 await pool.query("INSERT INTO ai_task_runs(id,project_id,task_id,triggered_by,model,status) VALUES($1,$2,$3,$4,$5,'queued')",
 [runId,id,taskId,uid(req),ai.model]);
 try{
  const worker=await agentCall('/jobs','POST',job);
  await pool.query('UPDATE ai_task_runs SET status=$2,message=$3 WHERE id=$1',[runId,worker.status==='queued'?'queued':'running',String(worker.message||'Запуск принят')]);
 }catch(e){
  const err=e as Error&{statusCode?:number};
  await pool.query("UPDATE ai_task_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,err.message]);
  return reply.code(err.statusCode||503).send({error:err.message});
 }
 return reply.code(202).send({id:runId,task_id:taskId,status:'queued',message:'Запуск принят. Исполнитель возьмёт задачу при наличии свободного слота.',model:ai.model,created_at:new Date().toISOString()});
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
   const phase=String(remote.message||'').slice(0,1600);
   if(remote.branch&&remote.branch!==current.branch){
    await pool.query('UPDATE ai_task_runs SET branch=$2 WHERE id=$1',[runId,remote.branch]);
    await pool.query('UPDATE tasks SET git_branch=$2 WHERE id=$1 AND project_id=$3',[current.task_id,remote.branch,id]);
   }
   if(remote.status!==current.status)await pool.query('UPDATE ai_task_runs SET status=$2 WHERE id=$1',[runId,remote.status]);
   if(phase && phase!==current.message){
    await pool.query('UPDATE ai_task_runs SET message=$2 WHERE id=$1',[runId,phase]);
    await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),current.task_id,uid(req),remote.status==='failed'?'ai_failed':remote.status==='completed'?'ai_completed':'ai_progress',phase]);
   }
   if(['completed','failed'].includes(remote.status)){
    if(remote.usage){
     const u=remote.usage;
     await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) VALUES($1,$2,$3,$4,'development',$5,$6,$7,$8) ON CONFLICT(source_id) DO NOTHING",
      [randomUUID(),id,current.task_id,runId,current.model,Math.max(0,Number(u.input_tokens)||0),Math.max(0,Number(u.cached_input_tokens)||0),Math.max(0,Number(u.output_tokens)||0)]);
    }
    await pool.query('UPDATE ai_task_runs SET status=$2,branch=$3,pr_url=$4,message=$5,completed_at=now() WHERE id=$1',
     [runId,remote.status,remote.branch||null,remote.prUrl||null,String(remote.message||'').slice(0,2000)]);
    if(remote.status==='completed'&&remote.prUrl){
     const prMatch=/\/pull\/(\d+)$/.exec(remote.prUrl);
     await pool.query("UPDATE tasks SET stage='merge_queue',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$6,updated_at=now() WHERE id=$1 AND project_id=$5",[current.task_id,remote.branch,remote.prUrl,prMatch?Number(prMatch[1]):null,id,remote.baseBranch||null]);
    }
    return {...current,status:remote.status,branch:remote.branch,pr_url:remote.prUrl,message:remote.message};
   }
   return {...current,status:remote.status,branch:remote.branch||current.branch,message:phase,started_at:remote.startedAt||null};
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



async function finishExistingTaskBranch(id:string,taskId:string,actorId:string):Promise<{pr_url:string;branch:string;recovered:boolean}|null>{
 const result=await pool.query(
  "SELECT t.title,t.stage,t.git_branch,t.pr_url,t.depends_on_task_id,t.pr_base_branch,g.repository,g.target_branch,g.default_branch,c.secret_encrypted FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 WHERE t.id=$1 AND t.project_id=$2",
  [taskId,id,actorId]);
 if(!result.rowCount)throw Object.assign(new Error('Задача или GitHub-подключение не найдены'),{statusCode:404});
 const row=result.rows[0];
 if(row.stage!=='development'&&row.stage!=='merge_queue')return null;
 if(row.pr_url)return {pr_url:row.pr_url,branch:String(row.git_branch||taskId),recovered:true};
 const branch=taskId;
 const token=decryptToken(row.secret_encrypted);
 let baseBranch=String(row.pr_base_branch||row.target_branch||row.default_branch);
 if(row.depends_on_task_id&&!row.pr_base_branch){
  const p=await pool.query('SELECT stage,git_branch,pr_url FROM tasks WHERE id=$1 AND project_id=$2',[row.depends_on_task_id,id]);
  if(!p.rowCount)throw Object.assign(new Error('Не найдена задача, от которой зависит разработка'),{statusCode:409});
  if(p.rows[0].stage==='merge_queue'&&p.rows[0].git_branch&&p.rows[0].pr_url)baseBranch=p.rows[0].git_branch;
  else if(!['done','documentation'].includes(p.rows[0].stage))
   throw Object.assign(new Error('Зависимая задача ещё не подготовила PR'),{statusCode:409});
 }
 const apiBase='https://api.github.com/repos/'+row.repository;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const gh=async(endpoint:string,options:RequestInit={})=>{
  const response=await fetch(apiBase+endpoint,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>({})) as any;
  return {response,data};
 };
 // A task's branch might not yet have been created. No changes means normal Codex development.
 const branchResult=await gh('/branches/'+encodeURIComponent(branch));
 if(branchResult.response.status===404)return null;
 if(!branchResult.response.ok)throw Object.assign(new Error('Не удалось проверить ветку задачи в GitHub: HTTP '+branchResult.response.status),{statusCode:502});
 const comparison=await gh('/compare/'+encodeURIComponent(baseBranch)+'...'+encodeURIComponent(branch));
 if(!comparison.response.ok)throw Object.assign(new Error('Не удалось сравнить ветки: GitHub HTTP '+comparison.response.status),{statusCode:502});
 if(!(Number(comparison.data.ahead_by)>0))return null;
 // Source code has already been pushed. Don't charge Codex again for the same work.
 const existing=await gh('/pulls?state=open&head='+encodeURIComponent(row.repository.split('/')[0]+':'+branch)+'&per_page=100');
 if(!existing.response.ok)throw Object.assign(new Error(existing.response.status===403
  ?'GitHub HTTP 403: у подключённого токена нет доступа к Pull Requests. В GitHub выдай ему разрешение Pull requests: Read and write и сохрани подключение заново.'
  :'Не удалось прочитать Pull Requests: GitHub HTTP '+existing.response.status),{statusCode:existing.response.status===403?409:502});
 const previous=(Array.isArray(existing.data)?existing.data:[]).find((pr:any)=>pr.base?.ref===baseBranch);
 let pr=previous;
 if(!pr){
  const created=await gh('/pulls',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({title:'AI: '+String(row.title).slice(0,180),body:'Изменения по задаче '+taskId+'\n\nПодготовлено AI Development Orchestrator. Проверь изменения перед слиянием.',head:branch,base:baseBranch,draft:false})});
  if(!created.response.ok)throw Object.assign(new Error(created.response.status===403
   ?'GitHub HTTP 403: создание PR запрещено. Нужны Pull requests: Read and write в разрешениях токена.'
   :'Не удалось создать PR: GitHub HTTP '+created.response.status+' '+String(created.data.message||'').slice(0,180)),{statusCode:409});
  pr=created.data;
 }
 await pool.query("UPDATE tasks SET stage='merge_queue',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$6,updated_at=now() WHERE id=$1 AND project_id=$5",[taskId,branch,pr.html_url,pr.number,id,baseBranch]);
 await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'pr_created',$4)",[randomUUID(),taskId,actorId,'PR создан автоматически: '+pr.html_url]);
 await pool.query("UPDATE ai_task_runs SET pr_url=$2,status='completed',message=$3,completed_at=COALESCE(completed_at,now()) WHERE project_id=$1 AND task_id=$4 AND status='failed' AND branch=$5",
  [id,pr.html_url,'PR автоматически создан из готовых изменений без нового запроса к Codex',taskId,branch]);
 return {pr_url:pr.html_url,branch,recovered:true};
}
async function restackChildren(projectId:string,parentId:string,parentHeadSha:string,parentBase:string,repository:string,token:string,actorId:string){
 const children=await pool.query("SELECT id,pr_number,pr_base_branch FROM tasks WHERE project_id=$1 AND depends_on_task_id=$2 AND stage='merge_queue' AND pr_number IS NOT NULL",[projectId,parentId]);
 if(!children.rowCount)return;
 const base='https://api.github.com/repos/'+repository;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const compare=await fetch(base+'/compare/'+encodeURIComponent(parentHeadSha)+'...'+encodeURIComponent(parentBase),{headers,signal:AbortSignal.timeout(15000)});
 const ancestry=await compare.json().catch(()=>({})) as any;
 const safe=compare.ok&&['ahead','identical'].includes(ancestry.status);
 for(const child of children.rows){
  if(child.pr_base_branch===parentBase)continue;
  try{
   if(!safe)throw new Error('Нельзя автоматически сменить базу: коммит родительской ветки не содержится в '+parentBase+'. Нужна безопасная пересборка ветки.');
   const updated=await fetch(base+'/pulls/'+child.pr_number,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({base:parentBase}),signal:AbortSignal.timeout(15000)});
   const data=await updated.json().catch(()=>({})) as any;
   if(!updated.ok)throw new Error('GitHub HTTP '+updated.status+': '+String(data.message||'').slice(0,150));
   await pool.query('UPDATE tasks SET pr_base_branch=$2,updated_at=now() WHERE id=$1',[child.id,parentBase]);
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),child.id,actorId,'pr_restacked','PR переключён на '+parentBase+' после слияния родителя '+parentId]);
  }catch(e){
   await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),child.id,actorId,'pr_restack_failed','PR ожидает смены базовой ветки: '+(e instanceof Error?e.message:String(e)).slice(0,320)]);
  }
 }
}
async function mergeTaskPr(projectId:string,taskId:string,userId:string){
 const info=await pool.query("SELECT t.id,t.title,t.stage,t.pr_number,t.pr_url,t.depends_on_task_id,t.pr_base_branch,g.repository,g.target_branch,g.default_branch,c.secret_encrypted FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 WHERE t.id=$1 AND t.project_id=$2",
 [taskId,projectId,userId]);
 if(!info.rowCount)throw Object.assign(new Error('Задача или подключение GitHub не найдены'),{statusCode:404});
 const row=info.rows[0];
 if(row.stage!=='merge_queue'||!row.pr_number)throw Object.assign(new Error('Задача не находится в очереди слияния или не содержит PR'),{statusCode:409});
 const token=decryptToken(row.secret_encrypted);
 if(row.depends_on_task_id){
  const parent=await pool.query('SELECT id,title,stage,pr_number,pr_base_branch FROM tasks WHERE project_id=$1 AND id=$2',[projectId,row.depends_on_task_id]);
  if(parent.rowCount && !['documentation','done'].includes(parent.rows[0].stage))
   throw Object.assign(new Error('Сначала слей родительскую задачу «'+parent.rows[0].title+'»'),{statusCode:409});
  if(parent.rowCount && parent.rows[0].pr_number && row.pr_base_branch===row.depends_on_task_id){
   const parentPr=await fetch('https://api.github.com/repos/'+row.repository+'/pulls/'+parent.rows[0].pr_number,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},signal:AbortSignal.timeout(15000)});
   if(parentPr.ok){
    const info=await parentPr.json() as any;
    if(info.merged)await restackChildren(projectId,row.depends_on_task_id,info.head.sha,info.base.ref,row.repository,token,userId);
   }
   const current=await pool.query('SELECT pr_base_branch FROM tasks WHERE id=$1',[taskId]);
   row.pr_base_branch=current.rows[0]?.pr_base_branch;
  }
 }
 const base='https://api.github.com/repos/'+row.repository;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
 const pull=await fetch(base+'/pulls/'+row.pr_number,{headers,signal:AbortSignal.timeout(15000)});
 if(!pull.ok)throw Object.assign(new Error('Не удалось получить PR: GitHub HTTP '+pull.status),{statusCode:502});
 const pr=await pull.json() as any;
 if(pr.merged){
  await pool.query("UPDATE tasks SET stage='documentation',updated_at=now() WHERE id=$1",[taskId]);
  await restackChildren(projectId,taskId,pr.head.sha,pr.base.ref,row.repository,token,userId);
  return {taskId,status:'merged',url:row.pr_url};
 }
 if(pr.state!=='open'||pr.draft)throw Object.assign(new Error('PR закрыт или находится в черновике; переведи его в Ready for review'),{statusCode:409});
 if(pr.base?.ref!==(row.pr_base_branch||row.target_branch||row.default_branch))throw Object.assign(new Error('Целевая ветка PR отличается от настроенной ветки проекта'),{statusCode:409});
 if(pr.mergeable===null || pr.mergeable_state==='unknown')
  throw Object.assign(new Error('GitHub ещё вычисляет mergeability PR, повторная проверка необходима'),{statusCode:409});
 if(pr.mergeable===false || pr.mergeable_state==='dirty')
  throw Object.assign(new Error('PR содержит конфликт с целевой веткой'),{statusCode:409});
 if(pr.mergeable_state==='blocked')
  throw Object.assign(new Error('PR заблокирован правилами GitHub или проверками'),{statusCode:409});
 // Best-effort CI inspection. Fine-grained tokens may lack Checks access;
 // GitHub still enforces branch protection and required checks on the merge API.
 // Never treat an inaccessible check endpoint as proof that CI has passed.
 const readCi=async(path:string,label:string):Promise<any|null>=>{
  const url=base+path;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});
  if(response.status===401||response.status===403){
   const publicHeaders={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ai-development-orchestrator'};
   const publicResponse=await fetch(url,{headers:publicHeaders,signal:AbortSignal.timeout(15000)});
   if(publicResponse.ok)return publicResponse.json();
   if([401,403,404].includes(publicResponse.status))return null;
   throw Object.assign(new Error('Не удалось проверить '+label+': GitHub HTTP '+publicResponse.status),{statusCode:502});
  }
  if(!response.ok)throw Object.assign(new Error('Не удалось проверить '+label+' в GitHub: HTTP '+response.status),{statusCode:502});
  return response.json();
 };
 const checkData=await readCi('/commits/'+encodeURIComponent(pr.head.sha)+'/check-runs?per_page=100','CI (Check Runs)');
 if(checkData){
  const runs=Array.isArray(checkData.check_runs)?checkData.check_runs:[];
  const incomplete=runs.filter((c:any)=>c.status!=='completed'||!['success','neutral','skipped'].includes(c.conclusion));
  if(incomplete.length)throw Object.assign(new Error('PR ожидает проверок CI или содержит ошибки: '+incomplete.map((c:any)=>c.name).slice(0,5).join(', ')),{statusCode:409});
  if(Number(checkData.total_count||0)>runs.length)throw Object.assign(new Error('У коммита больше 100 проверок CI. Для безопасного слияния необходимо получить все результаты проверок.'),{statusCode:409});
 }
 const statusData=await readCi('/commits/'+encodeURIComponent(pr.head.sha)+'/status','статусы коммита');
 if(statusData){
  const statuses=Array.isArray(statusData.statuses)?statusData.statuses:[];
  if(statuses.length&&statusData.state!=='success')throw Object.assign(new Error('Статусы коммита не пройдены: '+statusData.state),{statusCode:409});
 }

 const merge=await fetch(base+'/pulls/'+row.pr_number+'/merge',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},
  body:JSON.stringify({sha:pr.head.sha,merge_method:'merge',commit_title:'Merge AI task: '+String(row.title).slice(0,150)}),
  signal:AbortSignal.timeout(25000)});
 const merged=await merge.json().catch(()=>({})) as any;
 if(!merge.ok || !merged.merged)throw Object.assign(new Error('GitHub отклонил слияние: '+String(merged.message||merge.status).slice(0,240)),{statusCode:409});
 await pool.query("UPDATE tasks SET stage='documentation',updated_at=now() WHERE id=$1",[taskId]);
 await restackChildren(projectId,taskId,pr.head.sha,pr.base.ref,row.repository,token,userId);
 await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'merged',$4)",[randomUUID(),taskId,userId,row.pr_url]);
 return {taskId,status:'merged',url:row.pr_url};
}
app.post('/api/projects/:id/tasks/:taskId/merge',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 try{return await mergeTaskPr(id,taskId,uid(req));}
 catch(e){const err=e as Error&{statusCode?:number};return reply.code(err.statusCode||502).send({error:err.message});}
});

type MergeBatchResult={taskId:string;status:'merged'|'skipped';reason?:string};
type MergeBatch={id:string;projectId:string;status:'running'|'completed';results:MergeBatchResult[];currentTask:string|null;message:string;createdAt:string;finishedAt?:string};
const mergeBatches=new Map<string,MergeBatch>();
const runningMergeProjects=new Map<string,string>();
async function resolvePrConflicts(projectId:string,taskId:string,userId:string){
 const details=await pool.query(
  "SELECT t.title,t.description,t.pr_number,t.git_branch,g.repository,g.target_branch,g.default_branch,c.secret_encrypted,a.model,a.reasoning FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 LEFT JOIN project_ai_settings a ON a.project_id=t.project_id WHERE t.id=$1 AND t.project_id=$2",
  [taskId,projectId,userId]);
 if(!details.rowCount)throw Error('Не найдены настройки GitHub для разрешения конфликтов');
 const row=details.rows[0];
 if(!row.pr_number||!row.git_branch)throw Error('У задачи отсутствует ветка PR');
 const token=decryptToken(row.secret_encrypted);
 const jobId=randomUUID();
 const job={id:jobId,kind:'resolve-conflict',taskId,repository:row.repository,
  baseBranch:row.target_branch||row.default_branch,token,
  model:row.model||aiDefaults.model,reasoning:row.reasoning||aiDefaults.reasoning,
  maxRuntimeSeconds:900,title:row.title,description:row.description||''};
 // Get actual PR base: stacked PRs may initially target a parent task branch.
 const prResp=await fetch('https://api.github.com/repos/'+row.repository+'/pulls/'+row.pr_number,{
  headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
  signal:AbortSignal.timeout(15000)});
 if(!prResp.ok)throw Error('Не удалось получить PR для устранения конфликтов: HTTP '+prResp.status);
 const pr=await prResp.json() as any;
 job.baseBranch=pr.base.ref;
 const accepted=await agentCall('/jobs','POST',job);
 if(!['queued','running'].includes(accepted.status))throw Error('Исполнитель не принял разрешение конфликта');
 const deadline=Date.now()+16*60*1000;
 while(Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,3000));
  let result:any;
  try{result=await agentCall('/jobs/'+jobId);}
  catch(e){throw Error('Не удалось получить результат разрешения конфликта: '+(e instanceof Error?e.message:String(e)));}
  const batchId=runningMergeProjects.get(projectId);
  const batch=batchId?mergeBatches.get(batchId):undefined;
  if(batch)batch.message=String(result.message||'Устранение конфликтов через Codex');
  if(result.status==='completed'){
   await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'conflicts_resolved',$4)",[randomUUID(),taskId,userId,'Codex обновил PR после разрешения Git-конфликтов']);
   return;
  }
  if(result.status==='failed'){
   const message=String(result.message||'Не удалось разрешить конфликты');
   await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'merge_needs_attention',$4)",[randomUUID(),taskId,userId,message.slice(0,1500)]);
   throw Error(message);
  }
 }
 throw Error('Превышено время ожидания разрешения конфликтов. Проверь статус ветки перед повтором.');
}
async function runMergeBatch(batch:MergeBatch,userId:string){
 try{
  const tasks=await pool.query("SELECT id,depends_on_task_id FROM tasks WHERE project_id=$1 AND stage='merge_queue' ORDER BY created_at LIMIT 30",[batch.projectId]);
  const byId=new Map(tasks.rows.map((t:any)=>[t.id,t.depends_on_task_id]));
  const depth=(taskId:string,seen=new Set<string>()):number=>{
   if(seen.has(taskId))return 0;seen.add(taskId);
   const parent=byId.get(taskId) as string|undefined;
   return parent?1+depth(parent,seen):0;
  };
  tasks.rows.sort((a:any,b:any)=>depth(a.id)-depth(b.id));
  for(const task of tasks.rows){
   batch.currentTask=task.id;batch.message='Слияние PR '+(batch.results.length+1)+' из '+tasks.rows.length;
   let success=false,reason='';
   for(let retry=0;retry<3;retry++){
    try{
     const result=await mergeTaskPr(batch.projectId,task.id,userId);
     batch.results.push({taskId:task.id,status:'merged'});success=true;break;
    }catch(e){
     reason=e instanceof Error?e.message:String(e);
     const isPending=/ещё вычисляет mergeability/i.test(reason);
     if(isPending&&retry<2){await new Promise(resolve=>setTimeout(resolve,3000));continue;}
     const isConflict=/merge conflicts|содержит конфликт|mergeable.*dirty|GitHub отклонил слияние.*conflict/i.test(reason);
     if(!isConflict||retry>=2)break;
     try{
      batch.message='Разрешение конфликта PR через Codex';
      await resolvePrConflicts(batch.projectId,task.id,userId);
      // GitHub may calculate mergeable asynchronously after new commits.
      await new Promise(resolve=>setTimeout(resolve,2500));
     }catch(error){reason=error instanceof Error?error.message:String(error);break;}
    }
   }
   if(!success)batch.results.push({taskId:task.id,status:'skipped',reason});
  }
 }catch(e){batch.message='Ошибка обработки очереди: '+(e instanceof Error?e.message:String(e));}
 finally{
  batch.currentTask=null;batch.status='completed';batch.finishedAt=new Date().toISOString();
  if(runningMergeProjects.get(batch.projectId)===batch.id)runningMergeProjects.delete(batch.projectId);
 }
}
app.post('/api/projects/:id/merge-ready',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const existingId=runningMergeProjects.get(id);
 if(existingId)return reply.code(409).send({error:'Слияние уже выполняется',batchId:existingId});
 const batch:MergeBatch={id:randomUUID(),projectId:id,status:'running',results:[],currentTask:null,message:'Подготовка очереди',createdAt:new Date().toISOString()};
 mergeBatches.set(batch.id,batch);runningMergeProjects.set(id,batch.id);
 void runMergeBatch(batch,uid(req));
 return reply.code(202).send(batch);
});
app.get('/api/projects/:id/merge-ready/:batchId',async(req:any,reply)=>{
 const {id,batchId}=parse(z.object({id:z.string().uuid(),batchId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const batch=mergeBatches.get(batchId);
 if(!batch||batch.projectId!==id)return reply.code(404).send({error:'Очередь слияния не найдена после перезапуска или истекла'});
 return batch;
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
async function updateDependency(projectId:string,taskId:string,parentId:string|null,actorId:string){
 if(parentId===taskId)throw Object.assign(new Error('Задача не может зависеть от самой себя'),{statusCode:409});
 const task=await pool.query('SELECT id,stage,git_branch FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]);
 if(!task.rowCount)throw Object.assign(new Error('Задача не найдена'),{statusCode:404});
 if(['merge_queue','documentation','done'].includes(task.rows[0].stage)||task.rows[0].git_branch)
  throw Object.assign(new Error('Нельзя менять базовую зависимость после создания ветки. Сначала завершите текущую разработку.'),{statusCode:409});
 if(parentId){
  const parent=await pool.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2',[projectId,parentId]);
  if(!parent.rowCount)throw Object.assign(new Error('Задача-основание не найдена в этом проекте'),{statusCode:404});
  const chain=await pool.query('WITH RECURSIVE parents AS ('+
    'SELECT id,depends_on_task_id,ARRAY[id] AS trail FROM tasks WHERE id=$1 AND project_id=$2 '+
    'UNION ALL SELECT t.id,t.depends_on_task_id,p.trail||t.id FROM tasks t JOIN parents p ON t.id=p.depends_on_task_id '+
    'WHERE NOT t.id=ANY(p.trail) AND t.project_id=$2) '+
    'SELECT 1 FROM parents WHERE id=$3 LIMIT 1',[parentId,projectId,taskId]);
  if(chain.rowCount)throw Object.assign(new Error('Обнаружен цикл зависимостей'),{statusCode:409});
 }
 await pool.query("UPDATE tasks SET depends_on_task_id=$3,dependency_source='manual',updated_at=now() WHERE project_id=$1 AND id=$2",[projectId,taskId,parentId]);
 await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
  [randomUUID(),taskId,actorId,'dependency_changed',parentId?'Зависит от '+parentId:'Зависимость удалена']);
 return {ok:true,depends_on_task_id:parentId};
}
app.put('/api/projects/:id/tasks/:taskId/dependency',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {depends_on_task_id}=parse(z.object({depends_on_task_id:z.string().uuid().nullable()}),req.body);
 try{return await updateDependency(id,taskId,depends_on_task_id,uid(req));}
 catch(e){const err=e as Error&{statusCode?:number};return reply.code(err.statusCode||409).send({error:err.message});}
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
app.delete('/api/projects/:id/docs/:docId',async(req:any,reply)=>{
 const {id,docId}=parse(z.object({id:z.string().uuid(),docId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const document=await pool.query('SELECT id FROM documents WHERE id=$1 AND project_id=$2',[docId,id]);
 if(!document.rowCount)return reply.code(404).send({error:'Документ не найден'});
 const children=await pool.query('SELECT count(*)::int AS total FROM documents WHERE project_id=$1 AND parent_id=$2',[id,docId]);
 if(children.rows[0].total>0)return reply.code(409).send({error:'У документа есть вложенные страницы. Сначала перемести или удали дочерние страницы.'});
 await pool.query('DELETE FROM documents WHERE project_id=$1 AND id=$2',[id,docId]);
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
registerAssistantRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey,decryptToken});
registerKnowledgeRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey});
async function main(){await dbInit();await app.listen({port:Number(process.env.PORT||3001),host:'0.0.0.0'});}
main().catch(e=>{console.error(e);process.exit(1);});

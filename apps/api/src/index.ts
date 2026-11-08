import Fastify from 'fastify';
import pg from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
const { compare, hash } = bcrypt;
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { z } from 'zod';

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const jwtKey = new TextEncoder().encode(process.env.JWT_SECRET || '');
const keyText = process.env.CREDENTIALS_KEY || '';
const encryptionKey = Buffer.from(keyText, 'hex');
if (!process.env.JWT_SECRET || jwtKey.length < 32 || encryptionKey.length !== 32) throw Error('Set secure JWT_SECRET and 64-char hex CREDENTIALS_KEY');
const validStages = z.enum(['backlog','analysis','development','testing','done']);
const validMode = z.enum(['automatic','approval','manual']);
const workflowDefaults = [
  ['backlog','Бэклог','manual'],
  ['analysis','Анализ','approval'],
  ['development','Разработка','approval'],
  ['testing','Тестирование','approval'],
  ['done','Готово','manual']
] as const;
async function dbInit() {
 await pool.query(`
 CREATE TABLE IF NOT EXISTS users (id uuid primary key, email text unique not null, password_hash text not null);
 CREATE TABLE IF NOT EXISTS projects (id uuid primary key, name text not null, description text not null default '', owner_id uuid not null references users(id), created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS memberships (project_id uuid references projects(id) on delete cascade, user_id uuid references users(id) on delete cascade, role text not null default 'member', primary key(project_id,user_id));
 CREATE TABLE IF NOT EXISTS workflow_stages (project_id uuid references projects(id) on delete cascade, stage text not null, label text not null, mode text not null, position int not null, primary key(project_id,stage));
 CREATE TABLE IF NOT EXISTS tasks (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, title text not null, description text not null default '', type text not null default 'task', stage text not null default 'backlog', parent_id uuid references tasks(id) on delete set null, position int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS task_events (id uuid primary key, task_id uuid references tasks(id) on delete cascade, actor_id uuid references users(id), event text not null, detail text not null default '', created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS documents (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, title text not null, body text not null default '', updated_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS connections (id uuid primary key, owner_id uuid not null references users(id), name text not null, provider text not null, secret_encrypted text not null, created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS project_connections (project_id uuid references projects(id) on delete cascade, connection_id uuid references connections(id) on delete cascade, primary key(project_id,connection_id));
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
 return reply.code(500).send({error:'Ошибка сервера'});
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
 await pool.query('UPDATE tasks SET title=$1,description=$2,stage=$3,updated_at=now() WHERE id=$4',[data.title??t.title,data.description??t.description,data.stage??t.stage,taskId]);
 if(data.stage && data.stage!==t.stage)await pool.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'stage_changed',t.stage+' → '+data.stage]);
 return {ok:true};
});
app.get('/api/projects/:id/tasks/:taskId/events',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const r=await pool.query('SELECT e.* FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.id=$1 AND t.project_id=$2 ORDER BY e.created_at DESC',[taskId,id]);return r.rows;
});
app.get('/api/projects/:id/docs',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT * FROM documents WHERE project_id=$1 ORDER BY updated_at DESC',[id])).rows;});
app.post('/api/projects/:id/docs',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const {title,body}=parse(z.object({title:z.string().min(1).max(200),body:z.string().max(100000).default('')}),req.body);const docId=randomUUID();await pool.query('INSERT INTO documents(id,project_id,title,body) VALUES($1,$2,$3,$4)',[docId,id,title,body]);return reply.code(201).send({id:docId});});
app.patch('/api/projects/:id/docs/:docId',async(req:any,reply)=>{const {id,docId}=parse(z.object({id:z.string().uuid(),docId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const {title,body}=parse(z.object({title:z.string().min(1).max(200),body:z.string().max(100000)}),req.body);const r=await pool.query('UPDATE documents SET title=$1,body=$2,updated_at=now() WHERE id=$3 AND project_id=$4 RETURNING id',[title,body,docId,id]);if(!r.rowCount)return reply.code(404).send({error:'Документ не найден'});return {ok:true};});
app.get('/api/connections',async(req)=>{return (await pool.query('SELECT id,name,provider,created_at FROM connections WHERE owner_id=$1 ORDER BY created_at DESC',[uid(req)])).rows;});
app.post('/api/connections',async(req,reply)=>{
 const {name,provider,secret}=parse(z.object({name:z.string().min(1).max(100),provider:z.enum(['openai_api','github_token']),secret:z.string().min(8).max(2000)}),req.body);
 const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
 const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);const packed=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
 const id=randomUUID();await pool.query('INSERT INTO connections(id,owner_id,name,provider,secret_encrypted) VALUES($1,$2,$3,$4,$5)',[id,uid(req),name,provider,packed]);return reply.code(201).send({id,name,provider});
});
app.get('/api/projects/:id/connections',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT c.id,c.name,c.provider FROM connections c JOIN project_connections pc ON pc.connection_id=c.id WHERE pc.project_id=$1 AND c.owner_id=$2',[id,uid(req)])).rows;});
app.post('/api/projects/:id/connections',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const {connectionId}=parse(z.object({connectionId:z.string().uuid()}),req.body);const r=await pool.query('INSERT INTO project_connections(project_id,connection_id) SELECT $1,id FROM connections WHERE id=$2 AND owner_id=$3 ON CONFLICT DO NOTHING RETURNING connection_id',[id,connectionId,uid(req)]);if(!r.rowCount)return reply.code(400).send({error:'Подключение не найдено или уже добавлено'});return {ok:true};});
async function main(){await dbInit();await app.listen({port:Number(process.env.PORT||3001),host:'0.0.0.0'});}
main().catch(e=>{console.error(e);process.exit(1);});

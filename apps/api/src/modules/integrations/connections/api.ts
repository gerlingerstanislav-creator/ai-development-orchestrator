import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {encryptConnectionSecret} from './secret-cipher.js';

type ConnectionDeps={
 app:FastifyInstance;
 pool:Pick<Pool,'query'>;
 uid:(req:any)=>string;
 access:(req:any,reply:any,projectId:string)=>Promise<boolean>;
 encryptionKey:Buffer;
};
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T>{return schema.parse(input);}
const updateSchema=z.object({
 name:z.string().trim().min(1).max(100).optional(),
 secret:z.string().min(8).max(2000).optional()
}).refine(input=>input.name!==undefined||input.secret!==undefined);

/** Manage owned credentials and attach them to projects without exposing secrets. */
export function registerConnectionRoutes({app,pool,uid,access,encryptionKey}:ConnectionDeps){
 app.get('/api/connections',async req=>
  (await pool.query(`SELECT c.id,c.name,c.provider,c.created_at,
   (SELECT COUNT(*)::int FROM (
    SELECT project_id FROM project_git_repositories WHERE connection_id=c.id
    UNION SELECT project_id FROM project_connections WHERE connection_id=c.id
   ) linked) AS project_count
   FROM connections c WHERE c.owner_id=$1 ORDER BY c.created_at DESC`,[uid(req)])).rows
 );
 app.post('/api/connections',async(req,reply)=>{
  const {name,provider,secret}=parse(z.object({
   name:z.string().min(1).max(100),
   provider:z.enum(['openai_api','github_token']),
   secret:z.string().min(8).max(2000)
  }),req.body);
  const id=randomUUID();
  const encrypted=encryptConnectionSecret(secret,encryptionKey);
  await pool.query('INSERT INTO connections(id,owner_id,name,provider,secret_encrypted) VALUES($1,$2,$3,$4,$5)',[id,uid(req),name,provider,encrypted]);
  return reply.code(201).send({id,name,provider});
 });
 app.patch('/api/connections/:id',async(req:any,reply)=>{
  const {id}=parse(z.object({id:z.string().uuid()}),req.params);
  const body=parse(updateSchema,req.body);
  const encrypted=body.secret===undefined?null:encryptConnectionSecret(body.secret,encryptionKey);
  const result=await pool.query(`UPDATE connections
   SET name=COALESCE($3,name),secret_encrypted=COALESCE($4,secret_encrypted)
   WHERE id=$1 AND owner_id=$2 RETURNING id,name,provider`,
   [id,uid(req),body.name??null,encrypted]);
  if(!result.rowCount)return reply.code(404).send({error:'Подключение не найдено'});
  return result.rows[0];
 });
 app.delete('/api/connections/:id',async(req:any,reply)=>{
  const {id}=parse(z.object({id:z.string().uuid()}),req.params);
  // Preserve project bindings; a referenced token must be disconnected first.
  try{
   const result=await pool.query(`DELETE FROM connections c WHERE c.id=$1 AND c.owner_id=$2
    AND NOT EXISTS(SELECT 1 FROM project_git_repositories g WHERE g.connection_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM project_connections pc WHERE pc.connection_id=c.id)
    RETURNING c.id`,[id,uid(req)]);
   if(result.rowCount)return {ok:true};
  }catch(error){
   if((error as {code?:string}).code!=='23503')throw error;
   return reply.code(409).send({error:'Подключение используется проектом. Сначала отвяжи его в настройках проекта.'});
  }
  const owned=await pool.query('SELECT id FROM connections WHERE id=$1 AND owner_id=$2',[id,uid(req)]);
  if(!owned.rowCount)return reply.code(404).send({error:'Подключение не найдено'});
  return reply.code(409).send({error:'Подключение используется проектом. Сначала отвяжи его в настройках проекта.'});
 });
 app.get('/api/projects/:id/connections',async(req:any,reply)=>{
  const {id}=parse(z.object({id:z.string().uuid()}),req.params);
  if(!await access(req,reply,id))return;
  return (await pool.query('SELECT c.id,c.name,c.provider FROM connections c JOIN project_connections pc ON pc.connection_id=c.id WHERE pc.project_id=$1 AND c.owner_id=$2',[id,uid(req)])).rows;
 });
 app.post('/api/projects/:id/connections',async(req:any,reply)=>{
  const {id}=parse(z.object({id:z.string().uuid()}),req.params);
  if(!await access(req,reply,id))return;
  const {connectionId}=parse(z.object({connectionId:z.string().uuid()}),req.body);
  const result=await pool.query('INSERT INTO project_connections(project_id,connection_id) SELECT $1,id FROM connections WHERE id=$2 AND owner_id=$3 ON CONFLICT DO NOTHING RETURNING connection_id',[id,connectionId,uid(req)]);
  if(!result.rowCount)return reply.code(400).send({error:'Подключение не найдено или уже добавлено'});
  return {ok:true};
 });
}

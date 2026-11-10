import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const uuid=z.string().uuid();
/** Documentation changes outside AI-managed release notes are proposals until reviewed. */
export async function initKnowledgeDocumentUpdates(pool:Pool){
 await pool.query(String.raw`
 CREATE TABLE IF NOT EXISTS knowledge_document_updates(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  task_ids uuid[] NOT NULL DEFAULT '{}',
  base_version timestamptz NOT NULL,
  proposed_body text NOT NULL,reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','stale')),
  created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL
 );
 CREATE INDEX IF NOT EXISTS idx_knowledge_updates_project ON knowledge_document_updates(project_id,status,created_at DESC);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_update_pending ON knowledge_document_updates(project_id,document_id) WHERE status='pending';
 `);
}
type Deps={pool:Pool;uid:(req:any)=>string;access:(req:any,reply:any,id:string)=>Promise<boolean>;requireAdmin:(req:any,reply:any)=>Promise<boolean>};
export function registerKnowledgeDocumentUpdateRoutes(app:FastifyInstance,d:Deps){
 const {pool,uid,access,requireAdmin}=d;
 app.get('/api/projects/:id/knowledge/update-proposals',async(req:any,reply)=>{
  const {id}=z.object({id:uuid}).parse(req.params);
  if(!await access(req,reply,id))return;
  const q=z.object({status:z.enum(['pending','approved','rejected','stale','all']).default('pending'),document_id:uuid.optional()}).parse(req.query);
  const r=await pool.query("SELECT u.id,u.document_id,d.title AS document_title,u.task_ids,u.base_version,u.proposed_body,u.reason,u.status,u.created_at FROM knowledge_document_updates u JOIN documents d ON d.id=u.document_id AND d.project_id=u.project_id WHERE u.project_id=$1 AND ($2='all' OR u.status=$2) AND ($3::uuid IS NULL OR u.document_id=$3) ORDER BY u.created_at DESC LIMIT 100",[id,q.status,q.document_id||null]);
  return {proposals:r.rows};
 });
 app.post('/api/projects/:id/knowledge/update-proposals/:proposalId/decision',async(req:any,reply)=>{
  const {id,proposalId}=z.object({id:uuid,proposalId:uuid}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {decision}=z.object({decision:z.enum(['approve','reject'])}).parse(req.body);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const p=(await client.query("SELECT * FROM knowledge_document_updates WHERE id=$1 AND project_id=$2 AND status='pending' FOR UPDATE",[proposalId,id])).rows[0];
   if(!p){await client.query('ROLLBACK');return reply.code(409).send({error:'Предложение уже рассмотрено'});}
   const doc=(await client.query('SELECT id,body,updated_at,system_key FROM documents WHERE id=$1 AND project_id=$2 FOR UPDATE',[p.document_id,id])).rows[0];
   if(!doc||doc.system_key){await client.query('ROLLBACK');return reply.code(409).send({error:'Системный документ недоступен для автоматического обновления'});}
   if(decision==='approve'&&new Date(doc.updated_at).getTime()!==new Date(p.base_version).getTime()){
    await client.query("UPDATE knowledge_document_updates SET status='stale',resolved_at=now() WHERE id=$1",[proposalId]);
    // Re-run the documentation activity against the changed document rather than
    // approving a stale AI suggestion or marking the task finished.
    await client.query("UPDATE tasks SET documentation_updated_at=NULL,updated_at=now() WHERE project_id=$1 AND id=ANY($2::uuid[]) AND stage='documentation'",[id,p.task_ids]);
    await client.query('COMMIT');
    return reply.code(409).send({error:'Документ изменён после создания предложения. Нужна новая сверка.'});
   }
   if(decision==='approve'){
    const updated=await client.query('UPDATE documents SET body=$3,updated_at=clock_timestamp() WHERE id=$1 AND project_id=$2 RETURNING body',[doc.id,id,p.proposed_body]);
    if(updated.rowCount){
     await client.query('INSERT INTO document_versions(id,document_id,task_ids,body) VALUES($1,$2,$3,$4)',
      [randomUUID(),doc.id,JSON.stringify(p.task_ids),p.proposed_body]);
    }
   }
   await client.query('UPDATE knowledge_document_updates SET status=$2,resolved_at=now(),resolved_by=$3 WHERE id=$1',[proposalId,decision==='approve'?'approved':'rejected',uid(req)]);
   const finalized=await client.query("UPDATE tasks t SET stage='done',updated_at=now() WHERE t.project_id=$1 AND t.id=ANY($2::uuid[]) AND t.stage='documentation' AND t.documentation_updated_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge_document_updates u WHERE u.project_id=$1 AND u.status='pending' AND t.id=ANY(u.task_ids)) RETURNING id",[id,p.task_ids]);
   for(const task of finalized.rows)await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'documentation_updated','Тематическая документация рассмотрена, задача завершена')",[randomUUID(),task.id,uid(req)]);
   await client.query('COMMIT');
   return {ok:true,decision,document_id:p.document_id};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
}

import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const uuid=z.string().uuid();
const conversationalRoles=['manager','analyst'] as const;
const stageRoles=['backlog','analysis','development','testing','merge_queue','deployment','documentation','done'] as const;
const specialistRoles=['devops'] as const;
const roleSchema=z.enum([...conversationalRoles,...stageRoles,...specialistRoles]);
const memoryStatus=z.enum(['approved','rejected']);
const instructions=z.string().max(12000);
/** Data migrations are additive: existing workflow and specialist instructions remain the source of truth. */
export async function initProjectTeamSchema(pool:Pool){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS project_conversation_agents(
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('manager','analyst')),
  agent_name text NOT NULL,
  agent_instructions text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,role)
 );
 CREATE TABLE IF NOT EXISTS agent_instruction_history(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL,
  previous_name text NOT NULL,
  previous_instructions text NOT NULL,
  next_name text NOT NULL,
  next_instructions text NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_agent_instruction_history ON agent_instruction_history(project_id,role,created_at DESC);
 ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS author_id uuid REFERENCES users(id) ON DELETE SET NULL;
 ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agent';
 CREATE INDEX IF NOT EXISTS idx_agent_memory_role_status ON agent_memory(project_id,role,status,created_at DESC);
 INSERT INTO project_conversation_agents(project_id,role,agent_name,agent_instructions)
 SELECT p.id,r.role,r.agent_name,r.agent_instructions FROM projects p
 CROSS JOIN (VALUES
 ('manager','Менеджер проекта','Помогай владельцу проекта ставить задачи и принимать решения. Координируй работу других агентов, уточняй только существенные вопросы, показывай реальные состояния задач и не объявляй действие выполненным без подтверждения инструментов.'),
 ('analyst','Бизнес-аналитик','Работай с требованиями, исходными материалами и структурой технического задания. Отделяй подтверждённые требования от предположений, выявляй противоречия, задавай необходимые уточняющие вопросы и сохраняй согласованные решения в документации.')
 ) AS r(role,agent_name,agent_instructions)
 ON CONFLICT(project_id,role) DO NOTHING;
 `);
}
export async function conversationInstructions(pool:Pick<Pool,'query'>,projectId:string,role:'manager'|'analyst'){
 const row=(await pool.query('SELECT agent_name,agent_instructions FROM project_conversation_agents WHERE project_id=$1 AND role=$2',[projectId,role])).rows[0];
 return row?('Роль: '+row.agent_name+'\nПроектные инструкции:\n'+row.agent_instructions):'';
}
/** Only explicitly approved instruction proposals and observations are used at runtime. */
export async function agentMemoryContext(pool:Pick<Pool,'query'>,projectId:string,role:string){
 const rows=(await pool.query(`SELECT body,evidence,kind FROM agent_memory
 WHERE project_id=$1 AND role=$2 AND ((kind='observation' AND status IN ('recorded','approved')) OR (kind='instruction_suggestion' AND status='approved'))
 ORDER BY created_at DESC,id DESC LIMIT 20`,[projectId,role])).rows;
 return rows.reverse().map(r=>'- '+String(r.body).slice(0,800)+(r.evidence?' (основание: '+String(r.evidence).slice(0,160)+')':'')).join('\n').slice(0,12500);
}
async function roleExists(pool:Pool,projectId:string,role:string){
 if(conversationalRoles.includes(role as typeof conversationalRoles[number]))return !!(await pool.query('SELECT 1 FROM project_conversation_agents WHERE project_id=$1 AND role=$2',[projectId,role])).rowCount;
 if(specialistRoles.includes(role as typeof specialistRoles[number]))return !!(await pool.query('SELECT 1 FROM project_specialist_agents WHERE project_id=$1 AND role=$2',[projectId,role])).rowCount;
 return !!(await pool.query('SELECT 1 FROM workflow_stages WHERE project_id=$1 AND stage=$2',[projectId,role])).rowCount;
}
export function registerProjectTeamRoutes(app:FastifyInstance,deps:{
 pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;uid:(req:any)=>string
}){
 const {pool,access,requireAdmin,uid}=deps;
 const param=z.object({id:uuid});
 const changeParam=z.object({id:uuid,role:roleSchema});
 const canWrite=async(req:any,reply:any,id:string)=>await access(req,reply,id)&&await requireAdmin(req,reply);
 app.get('/api/projects/:id/team',async(req:any,reply)=>{
  const {id}=param.parse(req.params);if(!await access(req,reply,id))return;
  const [stages,specialists,conversations,memory]=await Promise.all([
   pool.query('SELECT stage,label,position,agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 ORDER BY position',[id]),
   pool.query('SELECT role,agent_name,agent_instructions FROM project_specialist_agents WHERE project_id=$1 ORDER BY role',[id]),
   pool.query('SELECT role,agent_name,agent_instructions FROM project_conversation_agents WHERE project_id=$1 ORDER BY CASE role WHEN \'manager\' THEN 0 ELSE 1 END',[id]),
   pool.query(`SELECT m.id,m.role,m.kind,m.body,m.evidence,m.status,m.origin,m.author_id,m.created_at,m.reviewed_at,
    u.email AS author_email FROM agent_memory m LEFT JOIN users u ON u.id=m.author_id
    WHERE m.project_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 1000`,[id])
  ]);
  const agents=[
   ...conversations.rows.map(r=>({id:'conversation:'+r.role,role:r.role,name:r.agent_name,stage:r.role==='manager'?'Коммуникации':'Бизнес-анализ',type:'conversation',instructions:r.agent_instructions})),
   ...stages.rows.map(r=>({id:'stage:'+r.stage,role:r.stage,name:r.agent_name,stage:r.label,type:'workflow',instructions:r.agent_instructions})),
   ...specialists.rows.map(r=>({id:'specialist:'+r.role,role:r.role,name:r.agent_name,stage:'Специалист',type:'specialist',instructions:r.agent_instructions}))
  ];
  return {agents,memory:memory.rows};
 });
 app.patch('/api/projects/:id/team/:role',async(req:any,reply)=>{
  const {id,role}=changeParam.parse(req.params);if(!await canWrite(req,reply,id))return;
  const data=z.object({name:z.string().trim().min(1).max(120),instructions}).parse(req.body);
  const table=conversationalRoles.includes(role as typeof conversationalRoles[number])?'project_conversation_agents':specialistRoles.includes(role as typeof specialistRoles[number])?'project_specialist_agents':'workflow_stages';
  const key=table==='workflow_stages'?'stage':'role';
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const row=(await client.query(`SELECT agent_name,agent_instructions FROM ${table} WHERE project_id=$1 AND ${key}=$2 FOR UPDATE`,[id,role])).rows[0];
   if(!row){await client.query('ROLLBACK');return reply.code(404).send({error:'Роль не найдена'});}
   if(row.agent_name!==data.name||row.agent_instructions!==data.instructions){
    await client.query(`UPDATE ${table} SET agent_name=$3,agent_instructions=$4${table==='workflow_stages'?'':',updated_at=now()'} WHERE project_id=$1 AND ${key}=$2`,[id,role,data.name,data.instructions]);
    await client.query(`INSERT INTO agent_instruction_history(id,project_id,role,previous_name,previous_instructions,next_name,next_instructions,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),id,role,row.agent_name,row.agent_instructions,data.name,data.instructions,uid(req)]);
   }
   await client.query('COMMIT');return {ok:true};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
 app.get('/api/projects/:id/team/:role/history',async(req:any,reply)=>{
  const {id,role}=changeParam.parse(req.params);if(!await access(req,reply,id))return;
  return {history:(await pool.query('SELECT id,previous_name,previous_instructions,next_name,next_instructions,created_at FROM agent_instruction_history WHERE project_id=$1 AND role=$2 ORDER BY created_at DESC LIMIT 50',[id,role])).rows};
 });
 app.post('/api/projects/:id/team/:role/memory',async(req:any,reply)=>{
  const {id,role}=changeParam.parse(req.params);if(!await canWrite(req,reply,id))return;
  if(!await roleExists(pool,id,role))return reply.code(404).send({error:'Роль не найдена'});
  const data=z.object({body:z.string().trim().min(5).max(1600),evidence:z.string().max(600).default('')}).parse(req.body);
  const newId=randomUUID();
  const row=(await pool.query(`INSERT INTO agent_memory(id,project_id,role,kind,body,evidence,status,origin,author_id,reviewed_at)
   VALUES($1,$2,$3,'instruction_suggestion',$4,$5,'approved','user',$6,now())
   RETURNING id`,[newId,id,role,data.body,data.evidence,uid(req)])).rows[0];
  return reply.code(201).send({id:row.id});
 });
 app.patch('/api/projects/:id/team/:role/memory/:memoryId',async(req:any,reply)=>{
  const {id,role,memoryId}=changeParam.extend({memoryId:uuid}).parse(req.params);
  if(!await canWrite(req,reply,id))return;
  const {status}=z.object({status:memoryStatus}).parse(req.body);
  const row=(await pool.query(`UPDATE agent_memory SET status=$4,reviewed_at=now() WHERE project_id=$1 AND role=$2 AND id=$3
   AND kind='instruction_suggestion' AND origin='agent' RETURNING id`,[id,role,memoryId,status])).rows[0];
  if(!row)return reply.code(404).send({error:'Предложение не найдено'});
  return {ok:true};
 });
 app.delete('/api/projects/:id/team/:role/memory/:memoryId',async(req:any,reply)=>{
  const {id,role,memoryId}=changeParam.extend({memoryId:uuid}).parse(req.params);
  if(!await canWrite(req,reply,id))return;
  const row=(await pool.query(`DELETE FROM agent_memory WHERE project_id=$1 AND role=$2 AND id=$3 AND origin='user' RETURNING id`,[id,role,memoryId])).rows[0];
  if(!row)return reply.code(404).send({error:'Пользовательская инструкция не найдена'});
  return {ok:true};
 });
}

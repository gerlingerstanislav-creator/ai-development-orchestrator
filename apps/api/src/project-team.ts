import {agentInstructions} from './agent-instructions.js';
import {responsibilityFor} from './role-responsibilities.js';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const uuid=z.string().uuid();
const conversationalRoles=['manager','analyst'] as const;
const stageRoles=['analysis','development','testing','documentation'] as const;
const specialistRoles=['devops'] as const;
const roleSchema=z.enum([...conversationalRoles,...stageRoles,...specialistRoles]);
const memoryStatus=z.enum(['approved','rejected']);
const instructions=z.string().max(12000);
const oldDeploymentInstructions='Организуй проверяемую доставку прошедших QA и слитых изменений. Используй GitHub Actions, неизменяемые артефакты и конкретный SHA; обеспечь защиту секретов, идемпотентность и rollback. Без подключённого окружения не запускай деплой и не объявляй публикацию успешной. Подготовка CI/CD должна проходить через PR и проверки; запроси недостающие данные окружения, но не выдумывай их.';

/** Keep project-specific edits from both formerly independent DevOps roles. */
export function mergeDevopsInstructions(specialist:string,stage:string,historicalStage:string|null=null){
 const result=specialist.trim();
 const additions=[stage.trim(),historicalStage?.trim()||'']
  .filter(Boolean).filter(value=>value!==oldDeploymentInstructions);
 let combined=result;
 for(const text of additions){
  if(combined.includes(text))continue;
  // Avoid a merge that truncates custom instructions or breaks editor validation.
  const next=combined+'\n\nДополнительные инструкции прежнего этапа выкладки:\n'+text;
  if(next.length>12000)throw Error('DevOps: объединение инструкций превысило 12000 символов; исходные настройки сохранены для ручного согласования');
  combined=next;
 }
 return combined;
}

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
 ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS source_run_id uuid;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_run_learning ON agent_memory(project_id,role,source_run_id) WHERE source_run_id IS NOT NULL;
 CREATE INDEX IF NOT EXISTS idx_agent_memory_role_status ON agent_memory(project_id,role,status,created_at DESC);
 INSERT INTO project_conversation_agents(project_id,role,agent_name,agent_instructions)
 SELECT p.id,r.role,r.agent_name,r.agent_instructions FROM projects p
 CROSS JOIN (VALUES
 ('manager','Менеджер проекта','Помогай владельцу проекта ставить задачи и принимать решения. Координируй работу других агентов, уточняй только существенные вопросы, показывай реальные состояния задач и не объявляй действие выполненным без подтверждения инструментов.'),
 ('analyst','Бизнес-аналитик','Работай с требованиями, исходными материалами и структурой технического задания. Отделяй подтверждённые требования от предположений, выявляй противоречия, задавай необходимые уточняющие вопросы и сохраняй согласованные решения в документации.')
 ) AS r(role,agent_name,agent_instructions)
 ON CONFLICT(project_id,role) DO NOTHING;
 -- Reconcile DevOps after the schema migration without discarding edited stage instructions.
 `);
 // Move only untouched built-in profiles to concise current instructions.
 // Preserve any role with an instruction edit recorded by a project owner.
 const legacyDefaults={"analysis":"На основании согласованного бизнес-аналитиком пула анализируй технические требования, данные, API, интеграции, состояния, ограничения и зависимости. Уточняй только блокирующие вопросы по текущим задачам. Продуктовые решения возвращай бизнес-аналитику и владельцу продукта. Не создавай задачи и вопросы по невыбранному функционалу. Сверяй PR с утверждённым ТЗ; QA выполняет тестировщик.","development":"Реализуй только утверждённое ТЗ в существующем репозитории/ветке, выполняй доступные проверки, исправляй воспроизводимые дефекты QA. Создай или обнови PR. Пиши тестировщику технические нюансы и вопросы, заказчику не обращайся. Не меняй секреты.","testing":"Независимо составь тест-план и проведи все доступные проверки на конкретном SHA. Сохраняй доказательства по каждому сценарию. Без реального браузера не засчитывай визуальное тестирование. Если инструментов нет — сообщи Менеджеру проекта непроверенные сценарии, не проси заказчика проводить тесты и не разрешай слияние самостоятельно.","documentation":"Обновляй только проверенную, слитую функциональность по ТЗ и фактическим изменениям. Не включай неутверждённые рабочие заметки команды как установленные требования. Все вопросы направляй коллегам или Менеджеру проекта, а не заказчику.","devops":"Отвечай за надёжность, скорость и экономичность CI/CD, GitHub Actions и выкладки. Анализируй фактические job, длительность, повторные установки зависимостей, кеширование, concurrency, отмену устаревших запусков, повторные сборки, артефакты, безопасность секретов и права GitHub token. Предлагай минимальные проверяемые изменения с измеримым эффектом. Не отключай тесты или защиту веток ради скорости. Используй неизменяемые версии артефактов, гарантируй идемпотентность и исключай параллельные деплои в одну среду. Перед выкладкой проверяй обязательные статусы и SHA; для продакшена нужен явный разрешённый механизм выкладки и стратегия отката. Не утверждай, что сделал deploy, если нет результата инструмента. Не запускай выкладку в ходе консультации."};
 const bootstrapDefaults={"analysis":"Уточняй требования, фиксируй проверяемые критерии приёмки и открытые вопросы. Не придумывай недостающие факты.","development":"Реализуй утверждённые требования в рабочей ветке, соблюдай правила проекта, исправляй замечания тестировщика. Не изменяй секреты.","testing":"Независимо проверь задачу и доступные тесты. Возвращай структурированные ошибки со способом воспроизведения, ожидаемым и фактическим результатом. Не объявляй непроверенное успешным.","documentation":"Обновляй подтверждённую реализованную функциональность после слияния PR. Отделяй проектные требования от фактической реализации."};
 const oldConversation={
  manager:'Помогай владельцу проекта ставить задачи и принимать решения. Координируй работу других агентов, уточняй только существенные вопросы, показывай реальные состояния задач и не объявляй действие выполненным без подтверждения инструментов.',
  analyst:'Работай с требованиями, исходными материалами и структурой технического задания. Отделяй подтверждённые требования от предположений, выявляй противоречия, задавай необходимые уточняющие вопросы и сохраняй согласованные решения в документации.'
 };
 for(const role of ['manager','analyst'] as const){
  await pool.query("UPDATE project_conversation_agents a SET agent_instructions=$3,updated_at=now() WHERE role=$1 AND agent_instructions=ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM agent_instruction_history h WHERE h.project_id=a.project_id AND h.role=$1)",[role,['',oldConversation[role]],agentInstructions[role]]);
 }
 for(const role of ['analysis','development','testing','documentation'] as const){
  await pool.query("UPDATE workflow_stages w SET agent_instructions=$3 WHERE stage=$1 AND agent_instructions=ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM agent_instruction_history h WHERE h.project_id=w.project_id AND h.role=$1)",[role,['',legacyDefaults[role],bootstrapDefaults[role]],agentInstructions[role]]);
 }
 await pool.query("UPDATE project_specialist_agents a SET agent_instructions=$2,updated_at=now() WHERE role='devops' AND agent_instructions=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM agent_instruction_history h WHERE h.project_id=a.project_id AND h.role='devops')",[[legacyDefaults.devops,''],agentInstructions.devops]);
 // A prior version kept an independent deployment-stage role. Read the
 // last saved stage instruction before synchronizing the two profile tables.
 // A role edited through Team has history; workflow-setting edits may not.
 const profiles=await pool.query(`
  SELECT w.project_id,w.agent_name AS stage_name,w.agent_instructions AS stage_instructions,
         s.agent_name AS specialist_name,s.agent_instructions AS specialist_instructions,
         history.next_instructions AS historical_stage_instructions,history.created_at AS stage_edited_at,
         devops_history.created_at AS devops_edited_at
  FROM workflow_stages w JOIN project_specialist_agents s
   ON s.project_id=w.project_id AND s.role='devops'
  LEFT JOIN LATERAL (
   SELECT next_instructions,created_at FROM agent_instruction_history
   WHERE project_id=w.project_id AND role='deployment'
   ORDER BY created_at DESC,id DESC LIMIT 1
  ) history ON true
  LEFT JOIN LATERAL (
   SELECT created_at FROM agent_instruction_history
   WHERE project_id=w.project_id AND role='devops'
   ORDER BY created_at DESC,id DESC LIMIT 1
  ) devops_history ON true
  WHERE w.stage='deployment'
 `);
 for(const row of profiles.rows){
  const recoverHistory=row.historical_stage_instructions&&
   (!row.devops_edited_at||new Date(row.stage_edited_at)>new Date(row.devops_edited_at));
  const merged=mergeDevopsInstructions(
   String(row.specialist_instructions||''),String(row.stage_instructions||''),
   recoverHistory?String(row.historical_stage_instructions):null);
  const customStage=String(row.stage_instructions||'').trim()!==oldDeploymentInstructions
   &&String(row.stage_instructions||'').trim()!==String(row.specialist_instructions||'').trim();
  const name=customStage&&row.specialist_name==='AI-DevOps'&&row.stage_name!=='AI-DevOps'
   ?String(row.stage_name):String(row.specialist_name);
  if(merged===row.specialist_instructions&&row.stage_instructions===merged&&row.stage_name===name)continue;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   // Lock both records; no silent overwrite of an edited legacy stage.
   const specialist=await client.query("SELECT agent_name,agent_instructions FROM project_specialist_agents WHERE project_id=$1 AND role='devops' FOR UPDATE",[row.project_id]);
   const stage=await client.query("SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage='deployment' FOR UPDATE",[row.project_id]);
   if(!specialist.rowCount||!stage.rowCount){await client.query('ROLLBACK');continue;}
   if(merged!==specialist.rows[0].agent_instructions||name!==specialist.rows[0].agent_name){
    await client.query("UPDATE project_specialist_agents SET agent_name=$2,agent_instructions=$3,updated_at=now() WHERE project_id=$1 AND role='devops'",[row.project_id,name,merged]);
    await client.query("INSERT INTO agent_instruction_history(id,project_id,role,previous_name,previous_instructions,next_name,next_instructions) VALUES($1,$2,'devops',$3,$4,$5,$6)",
     [randomUUID(),row.project_id,specialist.rows[0].agent_name,specialist.rows[0].agent_instructions,name,merged]);
   }
   if(stage.rows[0].agent_name!==name||stage.rows[0].agent_instructions!==merged){
    // Keep the original stage name and instructions discoverable in history.
    await client.query("INSERT INTO agent_instruction_history(id,project_id,role,previous_name,previous_instructions,next_name,next_instructions) VALUES($1,$2,'deployment',$3,$4,$5,$6)",
     [randomUUID(),row.project_id,stage.rows[0].agent_name,stage.rows[0].agent_instructions,name,merged]);
    await client.query("UPDATE workflow_stages SET agent_name=$2,agent_instructions=$3 WHERE project_id=$1 AND stage='deployment'",[row.project_id,name,merged]);
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
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
/** One suggested reusable lesson per completed execution, never auto-approved. */
export async function recordAgentLearning(pool:Pool,args:{projectId:string;role:string;runId:string;body:unknown;evidence:string}){
 if(typeof args.body!=='string')return;
 const clean=args.body.trim().replace(/(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{10,})[A-Za-z0-9_-]{8,}/g,'[REDACTED]');
 if(clean.length<20||clean.length>1600||/^(none|нет|отсутствует|не выявлено)[.!]?$/i.test(clean))return;
 await pool.query(`INSERT INTO agent_memory(id,project_id,role,kind,body,evidence,status,origin,source_run_id)
  VALUES($1,$2,$3,'instruction_suggestion',$4,$5,'proposed','agent',$6)
  ON CONFLICT DO NOTHING`,[randomUUID(),args.projectId,args.role,clean,args.evidence.slice(0,600),args.runId]);
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
   pool.query('SELECT stage,label,position,agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage=ANY($2::text[]) ORDER BY position',[id,stageRoles]),
   pool.query('SELECT role,agent_name,agent_instructions FROM project_specialist_agents WHERE project_id=$1 ORDER BY role',[id]),
   pool.query('SELECT role,agent_name,agent_instructions FROM project_conversation_agents WHERE project_id=$1 ORDER BY CASE role WHEN \'manager\' THEN 0 ELSE 1 END',[id]),
   pool.query(`SELECT m.id,m.role,m.kind,m.body,m.evidence,m.status,m.origin,m.author_id,m.created_at,m.reviewed_at,
    u.email AS author_email FROM agent_memory m LEFT JOIN users u ON u.id=m.author_id
    WHERE m.project_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 1000`,[id])
  ]);
  const agents=[
   ...conversations.rows.map(r=>({id:'conversation:'+r.role,role:r.role,name:r.agent_name,stage:r.role==='manager'?'Коммуникации':'Бизнес-анализ',type:'conversation',instructions:r.agent_instructions,responsibility:responsibilityFor(r.role)})),
   ...stages.rows.map(r=>({id:'stage:'+r.stage,role:r.stage,name:r.agent_name,stage:r.label,type:'workflow',instructions:r.agent_instructions,responsibility:responsibilityFor(r.stage)})),
   ...specialists.rows.map(r=>({id:'specialist:'+r.role,role:r.role,name:r.agent_name,stage:'CI/CD · выкладка · инфраструктура',type:'specialist',instructions:r.agent_instructions,responsibility:responsibilityFor(r.role)}))
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
    if(role==='devops')await client.query("UPDATE workflow_stages SET agent_name=$2,agent_instructions=$3 WHERE project_id=$1 AND stage='deployment'",[id,data.name,data.instructions]);
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

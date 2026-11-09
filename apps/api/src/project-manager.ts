import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {latestQaWaiver} from './qa-waiver.js';

/** One human-facing role; agents retain their own independent, private context. */
export const MANAGER_NAME='Менеджер проекта';
export async function initProjectManagerSchema(pool:Pool){
 await pool.query([
  "CREATE TABLE IF NOT EXISTS manager_messages (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,role text NOT NULL CHECK(role IN ('user','manager')),body text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'completed',reply_to uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())",
  "CREATE INDEX IF NOT EXISTS idx_manager_messages_task ON manager_messages(project_id,task_id,created_at)",
  "CREATE TABLE IF NOT EXISTS manager_requests (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,source_key text NOT NULL,kind text NOT NULL,source_id uuid NOT NULL,payload jsonb NOT NULL DEFAULT '{}'::jsonb,status text NOT NULL DEFAULT 'open',created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,decided_by uuid REFERENCES users(id) ON DELETE SET NULL,decision text,UNIQUE(task_id,source_key))",
  "CREATE INDEX IF NOT EXISTS idx_manager_requests_active ON manager_requests(project_id,task_id,status,created_at DESC)"
 ].join(';\n')+';');
}
export function managerRequestText(kind:string,payload:any):string{
 if(kind==='qa_visual'){
  const c=payload.assessment;
  return 'Тестировщик завершил доступные проверки, но не смог проверить '+c.unverified.length+
   ' сценариев из '+c.total+' (пройдено '+c.passed+'). Причины и доказательства:\n'+
   c.unverified.map((x:any)=>'• '+x.title+': '+x.evidence).join('\n').slice(0,2800)+
   '\n\nКак поступим: разрешаем слияние с явно непроверенными сценариями или ждём появления инструментов для полноценного тестирования? Я не объявляю эти проверки успешными.';
 }
 if(kind==='requirements')return 'Аналитик обнаружил существенное отличие реализации от утверждённого ТЗ: '+String(payload.summary||'').slice(0,1300)+
  '\nПредложение по требованиям: '+String(payload.proposed_description||'').slice(0,1700)+
  '\nНужно твоё решение: согласовать изменение поведения или отклонить его и вернуть исправления разработчику.';
 if(kind==='question')return 'Команде не удалось разрешить вопрос самостоятельно: '+String(payload.question||'').slice(0,2000)+
  '\nОтветь мне, и я передам ответ ответственному агенту.';
 return 'Необходимо решение по задаче.';
}
export type ManagerRequest={id:string;kind:string;source_id:string;payload:any;status:string;created_at:string;decision:string|null};

/** Deterministic gate projection: the manager does not hallucinate required approvals. */
export async function syncManagerInbox(pool:Pool,projectId:string,taskId:string){
 const task=(await pool.query('SELECT id,stage,spec_review_status,spec_version FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId])).rows[0];
 if(!task)return;
 const add=async(kind:string,source:string,sourceId:string,payload:any)=>{
  const result=await pool.query(
   "INSERT INTO manager_requests(id,project_id,task_id,source_key,kind,source_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(task_id,source_key) DO NOTHING RETURNING id",
   [randomUUID(),projectId,taskId,source,kind,sourceId,JSON.stringify(payload)]);
  if(result.rowCount){
   await pool.query("INSERT INTO manager_messages(id,project_id,task_id,role,body) VALUES($1,$2,$3,'manager',$4)",
    [randomUUID(),projectId,taskId,managerRequestText(kind,payload)]);
  }
 };
 if(task.stage==='testing'){
  const latest=await latestQaWaiver(pool,projectId,taskId);
  if(latest.run_id&&latest.assessment.eligible&&!latest.approval){
   await add('qa_visual','qa:'+latest.run_id,latest.run_id,{assessment:latest.assessment,stage:'testing'});
  }
 }
 const review=await pool.query(
  "SELECT id,classification,summary,proposed_description FROM task_requirement_reviews WHERE project_id=$1 AND task_id=$2 AND spec_version=$3 AND status='needs_approval' ORDER BY created_at DESC LIMIT 1",
  [projectId,taskId,task.spec_version]);
 if(task.spec_review_status==='needs_approval'&&review.rows[0]?.classification==='material_change'){
  const v=review.rows[0];
  await add('requirements','req:'+v.id,v.id,{summary:v.summary,proposed_description:v.proposed_description,stage:task.stage});
 }
 // Genuine user-facing questions only. Tool access requests belong to the manager,
 // not the customer, and cannot be treated as changing the product requirements.
 const questions=await pool.query(
  "SELECT id,body,author_name,target_stage FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status='open' ORDER BY created_at DESC LIMIT 15",
  [projectId,taskId]);
 for(const note of questions.rows){
  const toolQuestion=/\b(diff|patch|PR|pull request|репозитор|файл|доступ к коду|скриншот|браузер)\b/i.test(note.body)&&/предостав|пришл|не (вижу|могу|хватает)|нужен|требует/i.test(note.body);
  if(toolQuestion)continue;
  await add('question','note:'+note.id,note.id,{question:note.body,author:note.author_name,stage:task.stage});
 }
 // Old pending requests must not be shown after a task advances or a question is answered.
 await pool.query(
  "UPDATE manager_requests r SET status='superseded',resolved_at=now() WHERE r.project_id=$1 AND r.task_id=$2 AND r.status='open' AND ((r.kind='qa_visual' AND (NOT EXISTS(SELECT 1 FROM ai_test_runs t WHERE t.id=r.source_id AND t.task_id=$2 AND t.status='completed' AND t.verdict='blocked') OR (SELECT stage FROM tasks WHERE id=$2)<>'testing')) OR (r.kind='question' AND NOT EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.id=r.source_id AND n.status='open')) OR (r.kind='requirements' AND NOT EXISTS(SELECT 1 FROM task_requirement_reviews v WHERE v.id=r.source_id AND v.status='needs_approval')))",
  [projectId,taskId]);
}
export async function managerSnapshot(pool:Pool,projectId:string,taskId:string){
 await syncManagerInbox(pool,projectId,taskId);
 const [messages,requests,task,owner,tests,notes]=await Promise.all([
  pool.query("SELECT id,role,body,status,reply_to,created_at FROM manager_messages WHERE project_id=$1 AND task_id=$2 ORDER BY created_at,id LIMIT 300",[projectId,taskId]),
  pool.query("SELECT id,kind,source_id,payload,status,created_at,decision FROM manager_requests WHERE project_id=$1 AND task_id=$2 AND status IN ('open','waiting') ORDER BY created_at,id",[projectId,taskId]),
  pool.query('SELECT id,title,description,stage,spec_version,spec_review_status,pr_url,pr_number,test_feedback FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]),
  pool.query("SELECT workflow_id,kind,started_at FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[projectId,taskId]),
  pool.query("SELECT id,status,verdict,report,created_at,completed_at FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1",[projectId,taskId]),
  pool.query("SELECT id,author_name,author_stage,target_stage,body,kind,status,created_at FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 80",[projectId,taskId])
 ]);
 if(!task.rowCount)return null;
 return {messages:messages.rows,requests:requests.rows,task:task.rows[0],owner:owner.rows[0]||null,latestTest:tests.rows[0]||null,internalNotes:notes.rows};
}

export type ManagerDeps={
 pool:Pool;access:(req:any,reply:any,id:string)=>Promise<boolean>;
 requireAdmin:(req:any,reply:any)=>Promise<boolean>;uid:(req:any)=>string;
 startManagerWorkflow:(arg:{projectId:string;taskId:string;messageId:string})=>Promise<void>
};
const scope=z.object({id:z.string().uuid(),taskId:z.string().uuid()});
export function registerProjectManagerRoutes(app:FastifyInstance,deps:ManagerDeps){
 const {pool,access,requireAdmin,uid,startManagerWorkflow}=deps;
 app.get('/api/projects/:id/tasks/:taskId/manager',async(req:any,reply)=>{
  const {id,taskId}=scope.parse(req.params);
  if(!await access(req,reply,id))return;
  const snapshot=await managerSnapshot(pool,id,taskId);
  if(!snapshot)return reply.code(404).send({error:'Задача не найдена'});
  return snapshot;
 });
 app.post('/api/projects/:id/tasks/:taskId/manager/messages',async(req:any,reply)=>{
  const {id,taskId}=scope.parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {message}=z.object({message:z.string().trim().min(1).max(4000)}).parse(req.body);
  const t=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
  if(!t.rowCount)return reply.code(404).send({error:'Задача не найдена'});
  const msgId=randomUUID();
  // This is committed BEFORE any AI call so browser refresh never loses the user message.
  await pool.query("INSERT INTO manager_messages(id,project_id,task_id,actor_id,role,body,status) VALUES($1,$2,$3,$4,'user',$5,'queued')",
   [msgId,id,taskId,uid(req),message]);
  try{await startManagerWorkflow({projectId:id,taskId,messageId:msgId});}
  catch(e){
   await pool.query("UPDATE manager_messages SET status='failed',updated_at=now() WHERE id=$1",[msgId]);
   return reply.code(503).send({error:'Сообщение сохранено, но менеджер проекта пока недоступен. Повторить обработку можно из истории.',message_id:msgId});
  }
  return reply.code(202).send({id:msgId,status:'queued'});
 });
 app.post('/api/projects/:id/tasks/:taskId/manager/messages/:messageId/retry',async(req:any,reply)=>{
  const {id,taskId,messageId}=z.object({...scope.shape,messageId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const r=await pool.query("UPDATE manager_messages SET status='queued',updated_at=now() WHERE id=$1 AND project_id=$2 AND task_id=$3 AND role='user' AND status='failed' RETURNING id",[messageId,id,taskId]);
  if(!r.rowCount)return reply.code(409).send({error:'Можно повторить только сообщение с ошибкой'});
  try{await startManagerWorkflow({projectId:id,taskId,messageId});}
  catch(e){await pool.query("UPDATE manager_messages SET status='failed',updated_at=now() WHERE id=$1",[messageId]);return reply.code(503).send({error:'Менеджер проекта пока недоступен'});}
  return reply.code(202).send({id:messageId,status:'queued'});
 });
 // Delegation is deliberate: the existing handlers enforce GitHub SHA, requirements
 // revision and QA waiver policy. The manager never bypasses them.
 app.post('/api/projects/:id/tasks/:taskId/manager/requests/:requestId/decision',async(req:any,reply)=>{
  const {id,taskId,requestId}=z.object({...scope.shape,requestId:z.string().uuid()}).parse(req.params);
  if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
  const {choice,answer}=z.object({
   choice:z.enum(['approve_without_visual','wait_for_tools','answer','approve_requirements','reject_requirements']),
   answer:z.string().trim().max(3000).default('')
  }).parse(req.body);
  const selected=await pool.query('SELECT * FROM manager_requests WHERE id=$1 AND project_id=$2 AND task_id=$3 AND status=$4',[requestId,id,taskId,'open']);
  if(!selected.rowCount)return reply.code(409).send({error:'Вопрос уже рассмотрен или устарел. Обнови чат менеджера проекта.'});
  const request=selected.rows[0];
  if(request.kind==='qa_visual'&&!['approve_without_visual','wait_for_tools'].includes(choice)
   ||request.kind==='question'&&choice!=='answer'
   ||request.kind==='requirements'&&!['approve_requirements','reject_requirements'].includes(choice))
   return reply.code(400).send({error:'Выбранное действие не соответствует запросу менеджера проекта'});
  if(choice==='answer'&&answer.length<3)return reply.code(400).send({error:'Укажи содержательный ответ'});
  if(choice==='wait_for_tools'){
   await pool.query("UPDATE manager_requests SET status='waiting',decision=$2,decided_by=$3,resolved_at=now() WHERE id=$1 AND status='open'",
    [requestId,choice,uid(req)]);
   await pool.query("INSERT INTO manager_messages(id,project_id,task_id,role,body) VALUES($1,$2,$3,'manager',$4)",
    [randomUUID(),id,taskId,'Решение принято: ждём инструменты для полноценного тестирования. Непроверенные сценарии остаются непроверенными, слияние PR не разрешено.']);
   return {ok:true,stage:'testing',status:'waiting'};
  }
  const route=choice==='approve_without_visual'?'/api/projects/'+id+'/tasks/'+taskId+'/qa-waiver'
   :choice==='answer'?'/api/projects/'+id+'/tasks/'+taskId+'/agent-notes/'+request.source_id+'/answer'
   :'/api/projects/'+id+'/tasks/'+taskId+'/requirements/'+request.source_id+'/decision';
  const payload=choice==='approve_without_visual'?{
   test_run_id:request.source_id,
   justification:'Решение пользователя через Менеджера проекта: разрешено слияние с перечисленными непроверенными визуальными сценариями; фактическое выполнение не подтверждено.',
   acknowledge_unverified:true
  }:choice==='answer'?{answer}:{decision:choice==='approve_requirements'?'approve':'reject'};
  const injected=await app.inject({
   method:'POST',url:route,
   headers:{authorization:String(req.headers.authorization||''),cookie:String(req.headers.cookie||'')},
   payload
  });
  let data:any;try{data=injected.json();}catch{data={error:injected.body.slice(0,300)};}
  if(injected.statusCode>=400)return reply.code(injected.statusCode).send(data);
  await pool.query("UPDATE manager_requests SET status='resolved',decision=$2,decided_by=$3,resolved_at=now() WHERE id=$1 AND status='open'",
   [requestId,choice,uid(req)]);
  const response=choice==='approve_without_visual'?'Получено разрешение на слияние без перечисленных визуальных проверок. Риск зафиксирован, дальнейшее слияние по-прежнему проходит проверки GitHub.'
   :choice==='answer'?'Ответ передан специалисту. При необходимости аналитик повторит сверку требований.'
   :choice==='approve_requirements'?'Изменение требований согласовано. Команда может продолжать процесс.'
   :'Изменение отклонено. Задача возвращается разработчику.';
  await pool.query("INSERT INTO manager_messages(id,project_id,task_id,role,body) VALUES($1,$2,$3,'manager',$4)",[randomUUID(),id,taskId,response]);
  return {ok:true,...data};
 });
}

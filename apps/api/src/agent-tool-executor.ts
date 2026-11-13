import {PENDING_OWNER_QUESTION_SQL} from './task-question-gates.js';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hashSecret,capabilitiesForRole,type AgentSession} from './agent-tools.js';
import {instructionProposal,reconcileInstructions,proposeInstruction} from './instruction-governance.js';
import {readPmTaskGoal} from './pm-task-goal.js';
import {readTaskWorkBrief} from './task-work-brief.js';
import {extractGitHubDocumentLocation} from './github-document-import.js';
import {listIterations,readIteration,saveIteration,queueIterationPlanning,recommendIterationLaunch,approveIterationViaManager,previewIterationPlanViaManager,publishIterationPlanViaManager,recordIterationDecision} from './project-iterations.js';
import {tasksWithCustomerQuestions} from './project-manager.js';
import {enqueueDevelopment,readDevelopmentQueue} from './agent-work-scheduler.js';
import {taskConversationEvidence} from './task-agent-notes.js';
import {buildKnowledgeContext} from './knowledge-workflow.js';
import {markdownSections,sectionBody} from './markdown-knowledge-sections.js';
import {workflowResponsibility} from './workflow-responsibilities.js';
import {routeTaskToBrowserEvidence,retryTaskBrowserEvidence} from './task-evidence-routing.js';
import {delegateWork,listWork,reportWork,reviewWork,workRoles} from './modules/agents/infrastructure/work-assignments.js';
import {responsibilityFor} from './role-responsibilities.js';
import {createDoc,updateDoc,deleteDoc,documentRevision as revision,parentExists,createPage,updatePage,deleteEmptyPage} from './modules/knowledge/infrastructure/agent-document-pages.js';
function rejected(message:string,statusCode=409){return Object.assign(new Error(message),{statusCode});}

const uuid=z.string().uuid();
export async function executeAgentTool(pool:Pick<Pool,'query'>,session:AgentSession,name:string,args:unknown,
 _startWorkflow:(jobId:string)=>Promise<void>,
 readSource?:(projectId:string,actorId:string,path?:string,commit?:string)=>Promise<unknown>):Promise<unknown>{
 const projectId=session.project_id,actorId=session.actor_id;
 const params={...(args&&typeof args==='object'&&!Array.isArray(args)?args:{})} as Record<string,unknown>;
 if(session.task_id&&['knowledge.read','knowledge.section','knowledge.context','tasks.read','tasks.history','processes.list'].includes(name)){
  if(params.task_id!==undefined&&params.task_id!==session.task_id)throw rejected('Сессия агента привязана к другой задаче',403);
  params.task_id=session.task_id;
 }
 switch(name){
 case 'project.source':{
  if(!readSource)throw rejected('Источник проекта недоступен для агента',503);
  const data=z.object({path:z.string().trim().max(500).optional(),commit:z.string().regex(/^[a-f0-9]{40}$/i).optional()}).parse(params);
  return readSource(projectId,actorId,data.path,data.commit);
 }
 case 'documentation.complete':{
  if(session.role!=='documentation'||!session.process_id||session.task_id)
   throw rejected('Завершить документацию вправе только назначенный аналитик',403);
  const {document_ids,summary}=z.object({
   document_ids:z.array(uuid).min(1).max(60),summary:z.string().trim().min(20).max(2400)
  }).parse(params);
  if(new Set(document_ids).size!==document_ids.length)throw rejected('Документы результата должны быть уникальными');
  const records=await pool.query(
   'SELECT id,title FROM documents WHERE project_id=$1 AND id=ANY($2::uuid[]) AND length(btrim(body))>=10',
   [projectId,document_ids]);
  if(records.rowCount!==document_ids.length)throw rejected('Не все документы результата существуют и содержат текст');
  const events=await pool.query(`SELECT e.tool,e.result FROM agent_tool_events e JOIN agent_sessions s ON s.id=e.session_id
   WHERE s.project_id=$1 AND s.process_id=$2 AND e.success=true AND e.tool IN ('documents.create','documents.update','documents.delete','documents.changeset')`,
   [projectId,session.process_id]);
  const writes=events.rows.reduce((n:number,row:any)=>n+(row.tool==='documents.changeset'
   ?(Array.isArray(row.result?.changed)?row.result.changed.length:0):1),0);
  const outcome={summary,document_ids,verified_documents:records.rows,
   saved_documents:writes,source:'mcp-documents'};
  const updated=await pool.query(`UPDATE document_import_jobs SET status='completed',
   message='Подтверждена документация: '||$3::text,result=$4::jsonb,saved_documents=$5,updated_at=now()
   WHERE id=$1 AND project_id=$2 AND status='running' RETURNING id`,
   [session.process_id,projectId,String(records.rowCount),JSON.stringify(outcome),writes]);
  if(!updated.rowCount)throw rejected('Поручение уже завершено или приостановлено');
  return {status:'completed',...outcome};
 }
 case 'documentation.request_input':{
  if(session.role!=='documentation'||!session.process_id||session.task_id)
   throw rejected('Запросить данные вправе только назначенный аналитик',403);
  const {question,context}=z.object({question:z.string().trim().min(12).max(1800),
   context:z.string().trim().max(1800).default('')}).parse(params);
  const result={question,context,waiting_for:'project_manager'};
  const updated=await pool.query(`UPDATE document_import_jobs SET status='waiting_input',message=$3,
   result=$4::jsonb,updated_at=now() WHERE id=$1 AND project_id=$2 AND status='running' RETURNING id`,
   [session.process_id,projectId,'Аналитик запросил данные у ПМ: '+question.slice(0,550),JSON.stringify(result)]);
  if(!updated.rowCount)throw rejected('Поручение уже не выполняется');
  return {status:'waiting_input',...result};
 }
 case 'blockers.list':{
  const {task_id}=z.object({task_id:uuid}).parse(params);
  if(session.task_id&&session.task_id!==task_id)throw rejected('Другую задачу читать нельзя',403);
  return {blockers:(await pool.query("SELECT id,role,kind,summary,evidence,resolution_hint,status,resolution_evidence,created_at,updated_at FROM agent_blockers WHERE project_id=$1 AND task_id=$2 ORDER BY (status='open') DESC,created_at DESC LIMIT 60",[projectId,task_id])).rows};
 }
 case 'blockers.report':{
  const {task_id,kind,summary,evidence,resolution_hint}=z.object({
   task_id:uuid,kind:z.enum(['requirements','tool','ci','qa','github','dependency','environment','code','other']),
   summary:z.string().trim().min(12).max(500),evidence:z.string().trim().min(12).max(2500),
   resolution_hint:z.string().trim().max(1000).default('')
  }).parse(params);
  if(session.task_id!==task_id&&session.role!=='manager')throw rejected('Блокер можно сообщить только для своей задачи',403);
  if(!await pool.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2',[projectId,task_id]).then(r=>r.rowCount))throw rejected('Задача не найдена',404);
  const id=randomUUID();
  await pool.query("INSERT INTO agent_blockers(id,project_id,task_id,process_id,role,kind,summary,evidence,resolution_hint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
   [id,projectId,task_id,session.process_id||null,session.role,kind,summary,evidence,resolution_hint]);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,level,task_id) VALUES($1,$2,$3,'agent','blocker_open',$4,'warning',$5)",
   [randomUUID(),projectId,session.process_id||id,kind+': '+summary,task_id]);
  await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'agent_blocker_open',$3)",
   [randomUUID(),task_id,session.role+' · '+kind+': '+summary]);
  return {id,status:'open',task_id,kind};
 }
 case 'blockers.resolve':{
  const {blocker_id,resolution_evidence}=z.object({blocker_id:uuid,resolution_evidence:z.string().trim().min(12).max(2500)}).parse(params);
  const blocker=await pool.query('SELECT id,task_id,role,status FROM agent_blockers WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,blocker_id]);
  if(!blocker.rowCount)throw rejected('Блокер не найден',404);
  const item=blocker.rows[0];
  if(session.task_id&&session.task_id!==item.task_id)throw rejected('Блокер другой задачи',403);
  if(session.role!=='manager'&&session.role!==item.role)throw rejected('Снять блокер может его автор или менеджер',403);
  const result=await pool.query("UPDATE agent_blockers SET status='resolved',resolution_evidence=$3,updated_at=now() WHERE project_id=$1 AND id=$2 AND status='open' RETURNING id",[projectId,blocker_id,resolution_evidence]);
  if(result.rowCount){
   await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail,task_id) VALUES($1,$2,$3,'agent','blocker_resolved',$4,$5)",
    [randomUUID(),projectId,session.process_id||blocker_id,resolution_evidence.slice(0,1600),item.task_id]);
   await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'agent_blocker_resolved',$3)",
    [randomUUID(),item.task_id,session.role+': '+resolution_evidence.slice(0,1200)]);
  }
  return {id:blocker_id,status:'resolved',already_resolved:!result.rowCount};
 }
 case 'agents.capabilities':{
  const {role}=z.object({role:z.enum(workRoles)}).parse(params);
  return {role,responsibility:responsibilityFor(role),
   tools:capabilitiesForRole(role,false).map(t=>({name:t.name,description:t.description,readOnly:t.readOnly})),
   note:'Возможность роли не означает наличие настроенной среды; реальные эффекты подтверждают инструменты.'};
 }
 case 'work.list':{
  const {task_id}=z.object({task_id:uuid}).parse(params);
  if(session.task_id&&session.task_id!==task_id)throw rejected('Нельзя читать поручения другой задачи',403);
  return listWork(pool,projectId,task_id);
 }
 case 'work.delegate':{
  const {task_id,role,objective,acceptance}=z.object({
   task_id:uuid,role:z.enum(workRoles),objective:z.string().trim().min(12).max(2000),
   acceptance:z.string().trim().min(12).max(2000)
  }).parse(params);
  if(session.role!=='manager'&&session.task_id!==task_id)throw rejected('Нельзя делегировать работу для чужой задачи',403);
  if(session.role!=='manager'&&!session.process_id)throw rejected('Нет активного процесса',403);
  let parentId:string|null=null;
  if(session.role!=='manager'){
   const active=await pool.query(`SELECT id FROM agent_work_assignments
    WHERE id=$1 AND project_id=$2 AND task_id=$3 AND role=$4 AND status='running'`,[session.process_id,projectId,task_id,session.role]);
   if(active.rowCount)parentId=session.process_id!;
   else {
    const authorized=await pool.query(`SELECT id FROM agent_peer_queue WHERE note_id=$1 AND project_id=$2 AND task_id=$3 AND role=$4 AND status='running'
     UNION ALL SELECT id FROM ai_task_runs WHERE id=$1 AND project_id=$2 AND task_id=$3 AND $4='development' AND status IN ('queued','running')
     UNION ALL SELECT id FROM ai_test_runs WHERE id=$1 AND project_id=$2 AND task_id=$3 AND $4='testing' AND status IN ('queued','running')
     UNION ALL SELECT id FROM agent_analysis_runs WHERE id=$1 AND project_id=$2 AND task_id=$3 AND $4='analysis' AND status IN ('queued','running')`,
     [session.process_id,projectId,task_id,session.role]);
    if(!authorized.rowCount)throw rejected('Назначать работу может только действующий исполнитель этой задачи',403);
   }
  }
  return delegateWork(pool,{projectId,taskId:task_id,role,objective,acceptance,sourceRole:session.role,parentId});
 }
 case 'work.report':{
  if(!session.task_id||!session.process_id)throw rejected('Нет активного поручения с привязкой к задаче',403);
  const {result,evidence,status}=z.object({
   result:z.string().trim().min(20).max(3000),evidence:z.string().trim().min(12).max(3000),
   status:z.enum(['submitted','blocked'])
  }).parse(params);
  return reportWork(pool,{projectId,taskId:session.task_id,assignmentId:session.process_id,
   role:session.role,status,result,evidence});
 }
 case 'work.review':{
  if(session.role!=='manager')throw rejected('Принять результат может только ПМ',403);
  const {assignment_id,action,reason}=z.object({
   assignment_id:uuid,action:z.enum(['accept','retry','cancel']),
   reason:z.string().trim().min(12).max(2000)
  }).parse(params);
  return reviewWork(pool,{projectId,assignmentId:assignment_id,action,reason});
 }
 case 'agents.consult':{
  const {task_id,target_role,question,idempotency_key}=z.object({
   task_id:uuid,target_role:z.enum(['analysis','development','testing','architect','devops','documentation','manager']),
   question:z.string().trim().min(12).max(2000),idempotency_key:z.string().min(8).max(120).optional()
  }).parse(params);
  if(session.task_id!==task_id&&session.role!=='manager'&&session.role!=='analyst')throw rejected('Консультация разрешена только для своей задачи',403);
  if(!await pool.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2',[projectId,task_id]).then(r=>r.rowCount))throw rejected('Задача не найдена',404);
  const key='agent-consult:'+(session.process_id||session.id)+':'+hashSecret(idempotency_key||target_role+':'+question).slice(0,40);
  const id=randomUUID(),needsOwner=target_role==='manager';
  const note=await pool.query(`INSERT INTO task_agent_notes(id,project_id,task_id,author_stage,author_name,target_stage,kind,body,source_kind,source_key,source_run_id,status,requires_customer)
   VALUES($1,$2,$3,$4,$5,$6,'question',$7,'agent',$8,$9,'open',$10)
   ON CONFLICT(task_id,source_key) DO UPDATE SET body=task_agent_notes.body
   RETURNING id,status`,
   [id,projectId,task_id,session.role,session.role,needsOwner?'all':target_role,question,key,session.process_id||null,needsOwner]);
  if(note.rows[0].id===id)
   await pool.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'agent_consultation_requested',$3)",
    [randomUUID(),task_id,session.role+' → '+target_role+': '+question.slice(0,1200)]);
  return {note_id:note.rows[0].id,status:note.rows[0].status,recipient:target_role,waiting_for:needsOwner?'owner':'specialist',task_id,
   message:'Вопрос сохранён в карточке задачи. Ответ появится там же после проверки источника.'};
 }
 case 'project.agents.start':{
  if(session.role!=='manager')throw rejected('Только ПМ может запускать агентов по поручению владельца',403);
  const result=await pool.query('UPDATE projects SET agents_running=true WHERE id=$1 AND deleted_at IS NULL RETURNING agents_running',[projectId]);
  if(!result.rowCount)throw rejected('Проект недоступен',404);
  return {running:true,project_id:projectId};
 }
 case 'approvals.answer_question':{
  const {task_id,note_id,answer}=z.object({task_id:uuid,note_id:uuid,answer:z.string().trim().min(3).max(3000)}).parse(params);
  const changed=await pool.query("UPDATE task_agent_notes SET status='answered',answer=$4,answered_at=now(),answered_by=$5,answer_author='Владелец через ПМ' WHERE project_id=$1 AND task_id=$2 AND id=$3 AND kind='question' AND status='open' AND requires_customer=true RETURNING id",[projectId,task_id,note_id,answer,actorId]);
  if(!changed.rowCount)throw rejected('Вопрос уже закрыт или не запрашивал решение владельца',409);
  await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'agent_question_answered',$4)",[randomUUID(),task_id,actorId,'Ответ владельца через ПМ: '+answer.slice(0,1600)]);
  // Reconcile the analyst assignment when the last owner question is answered.
  const resumed=await pool.query(`UPDATE tasks SET analysis_state='new',updated_at=now()
   WHERE project_id=$1 AND id=$2 AND stage='analysis' AND analysis_state='waiting_questions'
    AND NOT EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.task_id=$2 AND ${PENDING_OWNER_QUESTION_SQL})
   RETURNING id`,[projectId,task_id]);
  return {answered:true,task_id,note_id,analyst_resumed:!!resumed.rowCount,requires_requirements_recheck:false,
   message:'Ответ сохранён в задаче. После получения всех ответов СА продолжит работу автоматически.'};
 }
 case 'approvals.list':{
  const [pending,questions]=await Promise.all([
   pool.query("SELECT r.id AS request_id,r.task_id,r.kind,r.status,r.payload,r.created_at,t.title,t.stage FROM manager_requests r JOIN tasks t ON t.id=r.task_id AND t.project_id=r.project_id WHERE r.project_id=$1 AND r.status IN ('open','waiting') ORDER BY r.created_at DESC LIMIT 80",[projectId]),
   pool.query("SELECT n.id AS note_id,n.task_id,t.display_number,t.title,n.body AS question,n.status,n.author_stage,n.created_at FROM task_agent_notes n JOIN tasks t ON t.id=n.task_id AND t.project_id=n.project_id WHERE n.project_id=$1 AND n.kind='question' AND n.status IN ('open','processing') AND (n.requires_customer OR n.target_stage='all') ORDER BY n.created_at DESC LIMIT 100",[projectId])
  ]);
  return {requests:pending.rows,open_questions:questions.rows};
 }
 case 'discussions.read':{
  const {topic_id,limit}=z.object({topic_id:uuid,limit:z.number().int().min(1).max(20).default(6)}).parse(params);
  const topic=await pool.query('SELECT id,title,status FROM project_chat_topics WHERE id=$1 AND project_id=$2',[topic_id,projectId]);
  if(!topic.rowCount)throw rejected('Тема не найдена',404);
  const messages=await pool.query(
   "SELECT id,role,left(body,1300) AS body,reply_to,created_at FROM assistant_messages WHERE project_id=$1 AND topic_id=$2 AND channel='project' AND status='completed' ORDER BY created_at DESC,id DESC LIMIT $3",
   [projectId,topic_id,limit]);
  return {topic:topic.rows[0],messages:messages.rows.reverse()};
 }
 case 'history.search':{
  const {query,limit}=z.object({query:z.string().trim().min(2).max(120),limit:z.number().int().min(1).max(12).default(6)}).parse(params);
  const messages=await pool.query(
   "SELECT id,role,left(body,1400) AS excerpt,topic_id,created_at FROM assistant_messages WHERE project_id=$1 AND task_id IS NULL AND channel='project' AND status='completed' AND body ILIKE $2 ORDER BY created_at DESC,id DESC LIMIT $3",
   [projectId,'%'+query+'%',limit]);
  return {messages:messages.rows};
 }
 case 'discussions.list':{
  const topics=await pool.query('SELECT id,title,status,created_at,closed_at FROM project_chat_topics WHERE project_id=$1 ORDER BY status,created_at DESC LIMIT 100',[projectId]);
  return {topics:topics.rows};
 }
 case 'discussions.open':{
  const {title,opening_message,awaiting_reply}=z.object({
   title:z.string().trim().min(3).max(180),opening_message:z.string().trim().min(3).max(4000),awaiting_reply:z.boolean().default(true)
  }).parse(params);
  await pool.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
  const existing=await pool.query("SELECT id,title,status FROM project_chat_topics WHERE project_id=$1 AND status='open' AND lower(title)=lower($2) LIMIT 1",[projectId,title]);
  const topic=existing.rows[0]??(await pool.query("INSERT INTO project_chat_topics(id,project_id,title) VALUES($1,$2,$3) RETURNING id,title,status",[randomUUID(),projectId,title])).rows[0];
  await pool.query(`INSERT INTO assistant_messages(id,project_id,role,body,channel,status,topic_id)
   SELECT $1,$2,'assistant',$3,'project','completed',$4
   WHERE NOT EXISTS(SELECT 1 FROM assistant_messages WHERE project_id=$2 AND topic_id=$4 AND channel='project')`,
   [randomUUID(),projectId,opening_message,topic.id]);
  return {topic,existing:!!existing.rowCount,awaiting_reply};
 }
 case 'discussions.close':
 case 'discussions.reopen':{
  const {topic_id}=z.object({topic_id:uuid}).parse(params);
  const status=name==='discussions.close'?'closed':'open';
  const updated=await pool.query("UPDATE project_chat_topics SET status=$3,closed_at=CASE WHEN $3='closed' THEN now() ELSE NULL END WHERE project_id=$1 AND id=$2 RETURNING id,title,status",[projectId,topic_id,status]);
  if(!updated.rowCount)throw rejected('Тема не найдена',404);
  return {topic:updated.rows[0]};
 }
 case 'pm.decisions.list':{
  return {decisions:(await pool.query('SELECT id,question,answer,iteration_id,order_id,created_at FROM project_pm_decisions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[projectId])).rows};
 }
 case 'pm.decisions.record':{
  const {source_message_id,question,answer,iteration_id,order_id}=z.object({
   source_message_id:uuid,question:z.string().trim().min(3).max(2000),answer:z.string().trim().min(1).max(5000),
   iteration_id:uuid.optional(),order_id:uuid.optional()
  }).parse(params);
  const source=(await pool.query("SELECT id,pm_order_id FROM assistant_messages WHERE id=$1 AND project_id=$2 AND role='user' AND channel='project'",[source_message_id,projectId])).rows[0];
  if(!source)throw rejected('Решение должно иметь подтверждённый исходный ответ владельца',409);
  const parent=order_id||source.pm_order_id||null;
  if(parent){
   const exists=await pool.query('SELECT 1 FROM project_pm_orders WHERE id=$1 AND project_id=$2',[parent,projectId]);
   if(!exists.rowCount)throw rejected('Поручение не найдено',404);
  }
  if(iteration_id){
   const valid=await pool.query('SELECT 1 FROM project_iterations WHERE id=$1 AND project_id=$2',[iteration_id,projectId]);
   if(!valid.rowCount)throw rejected('Итерация не найдена',404);
  }
  const id=randomUUID();
  const saved=await pool.query("INSERT INTO project_pm_decisions(id,project_id,order_id,source_message_id,iteration_id,question,answer) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,source_message_id,question) WHERE source_message_id IS NOT NULL DO NOTHING RETURNING id",
   [id,projectId,parent,source_message_id,iteration_id||null,question,answer]);
  let planning:{planning_run_id?:string;status?:string}|null=null;
  if(saved.rowCount&&iteration_id){
   await recordIterationDecision(pool,projectId,iteration_id,actorId,question,answer);
   planning=await queueIterationPlanning(pool,projectId,actorId,{iteration_id,request:'Перепроверь план с новым подтверждённым решением: '+question.slice(0,250)});
  }
  return {id:saved.rows[0]?.id||null,recorded:!!saved.rowCount,iteration_id:iteration_id||null,planning_run_id:planning?.planning_run_id,status:planning?.status};
 }
 case 'pm.orders.watch_task':{
  if(session.role!=='manager')throw rejected('Контроль целей доступен только ПМ',403);
  const {task_id}=z.object({task_id:uuid}).parse(params);
  const state=await readPmTaskGoal(pool,projectId,task_id);
  if(state.status==='missing')throw rejected('Задача не найдена',404);
  if(state.status==='done')return {...state,watch_registered:false};
  if(state.status!=='running')return {...state,watch_registered:false};
  // Only PM Inbox starts the existing Temporal watch workflow. A task-chat or
  // legacy session must not return "watching" without actually scheduling it.
  const inbox=!!session.process_id&&(await pool.query(`SELECT 1 FROM assistant_messages
   WHERE id=$1 AND project_id=$2 AND role='user' AND channel IN ('project','pm-internal')
    AND status='processing'`,[session.process_id,projectId])).rowCount;
  if(!inbox)return {...state,status:'needs_action',watch_registered:false,
   reason:'Долгосрочное наблюдение запускается из общего чата ПМа. В этом канале доступны только текущие действия без регистрации Temporal-watch.'};
  return {...state,status:'watching',watch_registered:true,watch_id:randomUUID()};
 }
 case 'pm.orders.list':{
  return {orders:(await pool.query("SELECT id,summary,status,topic_id,updated_at FROM project_pm_orders WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 40",[projectId])).rows};
 }
 case 'pm.orders.update':{
  const {order_id,status,summary}=z.object({order_id:uuid,status:z.enum(['working','waiting_agents','waiting_user','completed','failed']),summary:z.string().trim().max(1000).optional()}).parse(params);
  const result=await pool.query("UPDATE project_pm_orders SET status=$3,summary=COALESCE($4,summary),updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING id,status",[projectId,order_id,status,summary??null]);
  if(!result.rowCount)throw rejected('Поручение не найдено',404);
  await pool.query("INSERT INTO project_pm_order_events(id,order_id,kind,detail) VALUES($1,$2,'status',$3)",[randomUUID(),order_id,status+': '+(summary||'')]);
  return result.rows[0];
 }
 case 'iterations.ask_question':{
  const {iteration_id,question}=z.object({iteration_id:uuid,question:z.string().trim().min(5).max(2000)}).parse(params);
  const found=await pool.query('SELECT id FROM project_iterations WHERE id=$1 AND project_id=$2',[iteration_id,projectId]);
  if(!found.rowCount)throw rejected('Итерация не найдена',404);
  const existing=await pool.query("SELECT id FROM iteration_questions WHERE iteration_id=$1 AND status='open' AND lower(question)=lower($2) LIMIT 1",[iteration_id,question]);
  if(existing.rowCount)return {id:existing.rows[0].id,existing:true};
  const id=randomUUID();
  await pool.query('INSERT INTO iteration_questions(id,iteration_id,actor_id,question) VALUES($1,$2,$3,$4)',[id,iteration_id,actorId,question]);
  return {id,iteration_id,status:'open'};
 }
 case 'iterations.record_decision':{
  const {iteration_id,question,answer}=z.object({iteration_id:uuid,question:z.string().trim().min(3).max(2000),answer:z.string().trim().min(3).max(5000)}).parse(params);
  return recordIterationDecision(pool,projectId,iteration_id,actorId,question,answer);
 }
 case 'iterations.approve':{
  const {iteration_id,expected_revision}=z.object({iteration_id:uuid,expected_revision:z.number().int().positive()}).parse(params);
  return approveIterationViaManager(pool,projectId,iteration_id,expected_revision);
 }
 case 'iterations.preview_plan':{
  const {iteration_id,plan_id}=z.object({iteration_id:uuid,plan_id:uuid}).parse(params);
  return previewIterationPlanViaManager(pool,projectId,iteration_id,plan_id);
 }
 case 'iterations.publish_plan':{
  const {iteration_id,plan_id,preview_revision,selected_changes}=z.object({iteration_id:uuid,plan_id:uuid,preview_revision:z.string().length(64),selected_changes:z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)).max(95)}).parse(params);
  return publishIterationPlanViaManager(pool,projectId,iteration_id,plan_id,actorId,preview_revision,selected_changes);
 }
 case 'iterations.list':return listIterations(pool,projectId);
 case 'iterations.read':{
  const {iteration_id}=z.object({iteration_id:uuid}).parse(params);
  return readIteration(pool,projectId,iteration_id);
 }
 case 'iterations.save':return saveIteration(pool,projectId,params);
 case 'iterations.prepare_plan':return queueIterationPlanning(pool,projectId,actorId,params);
 case 'iterations.recommend_launch':return recommendIterationLaunch(pool,projectId,params);
 case 'tasks.dependency_graph':{
  if(session.role!=='manager')throw rejected('Граф зависимостей доступен ПМ',403);
  const rows=await pool.query("SELECT id,title,stage,type,analysis_state,depends_on_task_id,dependency_source,git_branch,pr_url FROM tasks WHERE project_id=$1 AND type<>'epic' ORDER BY created_at LIMIT 400",[projectId]);
  return {tasks:rows.rows};
 }
 case 'iterations.launch':{
  if(session.role!=='manager')throw rejected('Запуск итерации доступен только ПМ',403);
  const data=z.object({iteration_id:uuid,expected_revision:z.number().int().positive()}).parse(params);
  const launched=await enqueueDevelopment(pool,projectId,actorId,{iterationId:data.iteration_id,revision:data.expected_revision});
  const queue=await readDevelopmentQueue(pool,projectId);
  const selectedIds=new Set(launched.tasks.map(task=>task.id));
  const blocked=queue.filter(task=>selectedIds.has(task.task_id)&&task.reason)
   .map(({task_id,reason,detail})=>({task_id,reason,detail}));
  return {...launched,blocked,github_required:blocked.some(item=>item.reason==='github'),
   message:blocked.some(item=>item.reason==='github')
    ?'Задачи есть на доске и поставлены в очередь, но разработка ждёт подключения GitHub. Проверь подключение репозитория и права токена.'
    :'Очередь разработки создана. Выполняются только готовые задачи без блокировок.'};
 }
 case 'capabilities.list':{
  const {category}=z.object({category:z.string().trim().max(60).optional()}).parse(params);
  return {capabilities:capabilitiesForRole(session.role,session.read_only,category).map(({name,category,description,effects,requiresConfirmation})=>({name,category,description,effects,requiresConfirmation}))};
 }
 case 'capabilities.describe':{
  const {name:target}=z.object({name:z.string().min(2).max(90)}).parse(params);
  const item=capabilitiesForRole(session.role,session.read_only).find(t=>t.name===target);
  if(!item)throw rejected('Возможность недоступна для текущей роли',403);
  return {capability:item};
 }
 case 'instructions.reconcile':{
  if(session.role!=='manager')throw rejected('Управление правилами доступно ПМ',403);
  const data=instructionProposal.pick({target_roles:true,text:true,applicability:true}).parse(params);
  return {matches:await reconcileInstructions(pool,projectId,data.target_roles,data.text,data.applicability)};
 }
 case 'instructions.propose':{
  if(session.role!=='manager')throw rejected('Распределять правила команды может только ПМ',403);
  const data=instructionProposal.parse(params);
  return proposeInstruction(pool,projectId,data);
 }
 case 'project.context':{
  const [p,stages,rules,github]=await Promise.all([
   pool.query('SELECT id,name,description,agents_running FROM projects WHERE id=$1',[projectId]),
   pool.query('SELECT stage,label,mode,agent_name,agent_instructions,position FROM workflow_stages WHERE project_id=$1 ORDER BY position',[projectId]),
   pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 80',[projectId]),
   pool.query('SELECT repository,target_branch,default_branch FROM project_git_repositories WHERE project_id=$1',[projectId])
  ]);
  return {project:p.rows[0],workflow:stages.rows.map(stage=>({...stage,responsibility:workflowResponsibility(stage.stage)})),rules:rules.rows.map(r=>r.body),github:github.rows[0]||null};
 }
 case 'documents.list':{
  const r=await pool.query('SELECT d.id,d.title,d.parent_id,d.system_key,d.updated_at,d.import_source,length(btrim(d.body))::int AS content_length,(SELECT count(*)::int FROM documents child WHERE child.project_id=d.project_id AND child.parent_id=d.id) AS child_count FROM documents d WHERE d.project_id=$1 ORDER BY d.title LIMIT 400',[projectId]);
  return {documents:r.rows.map(d=>({...d,revision:revision(d.updated_at)}))};
 }
 case 'documents.read':{
  const {document_id}=z.object({document_id:uuid}).parse(params);
  const r=await pool.query('SELECT id,title,body,parent_id,system_key,source_refs,updated_at,knowledge_status AS status FROM documents WHERE project_id=$1 AND id=$2',[projectId,document_id]);
  if(!r.rowCount)throw rejected('Страница не найдена',404);
  const document={...r.rows[0],revision:revision(r.rows[0].updated_at)};
  if(session.read_only)await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id,process_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [randomUUID(),projectId,session.task_id??null,document_id,document.revision,session.role,session.id,session.process_id??null]);
  return {document};
 }
 case 'documents.search':{
  const {query}=z.object({query:z.string().trim().min(2).max(150)}).parse(params);
  const r=await pool.query('SELECT id,title,parent_id,system_key,left(body,700) excerpt,updated_at,knowledge_status AS status FROM documents WHERE project_id=$1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY updated_at DESC LIMIT 40',
   [projectId,'%'+query+'%']);
  return {documents:r.rows.map(d=>({...d,revision:revision(d.updated_at)}))};
 }
 case 'tasks.request_owner_question_cleanup':
 case 'documentation.request_reset':{
  z.object({}).strict().parse(params);
  return {requires_user_confirmation:true};
 }
 case 'documents.create':return createPage(pool,projectId,createDoc.parse(params));
 case 'documents.update':{
  const values=updateDoc.parse(params);
  return updatePage(pool,projectId,values);
 }
 case 'documents.delete':return deleteEmptyPage(pool,projectId,deleteDoc.parse(params));
 case 'documents.changeset':{
  const {operations}=z.object({operations:z.array(z.discriminatedUnion('op',[
   createDoc.extend({op:z.literal('create')}),
   updateDoc.extend({op:z.literal('update')}),
   deleteDoc.extend({op:z.literal('delete')})
  ])).min(1).max(40)}).parse(params);
  const changed=[];
  for(const operation of operations){
   if(operation.op==='create')changed.push(await createPage(pool,projectId,operation));
   else if(operation.op==='update')changed.push(await updatePage(pool,projectId,operation));
   else changed.push(await deleteEmptyPage(pool,projectId,operation));
  }
  return {changed};
 }

 case 'knowledge.search':{
  const {query,limit}=z.object({query:z.string().trim().min(2).max(300),limit:z.number().int().min(1).max(20).default(8)}).parse(params);
  const r=await pool.query(
   "SELECT id,title,parent_id,knowledge_summary AS summary,knowledge_tags AS tags,updated_at AS version,ts_rank_cd(to_tsvector('simple',title||' '||body),plainto_tsquery('simple',$2)) AS score FROM documents WHERE project_id=$1 AND knowledge_status='approved' AND (to_tsvector('simple',title||' '||body) @@ plainto_tsquery('simple',$2) OR title ILIKE '%'||$2||'%' OR body ILIKE '%'||$2||'%') ORDER BY score DESC,updated_at DESC LIMIT $3",
   [projectId,query,limit]);
  return {results:r.rows};
 }
 case 'knowledge.read':{
  const {document_id,mode,task_id}=z.object({document_id:uuid,mode:z.enum(['summary','full']).default('summary'),task_id:uuid.optional()}).parse(params);
  const r=await pool.query("SELECT id,title,parent_id,body,knowledge_summary,knowledge_status,knowledge_tags,updated_at FROM documents WHERE project_id=$1 AND id=$2 AND knowledge_status='approved'",[projectId,document_id]);
  if(!r.rowCount)throw rejected('Утверждённый документ не найден',404);
  if(task_id){
   const task=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[task_id,projectId]);
   if(!task.rowCount)throw rejected('Задача не найдена',404);
  }
  const d=r.rows[0];
  await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id,process_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [randomUUID(),projectId,task_id||null,document_id,revision(d.updated_at),session.role,session.id,session.process_id??null]);
  return {document:{id:d.id,title:d.title,parent_id:d.parent_id,status:d.knowledge_status,summary:d.knowledge_summary||d.body.slice(0,360),tags:d.knowledge_tags,version:revision(d.updated_at),...(mode==='full'?{body:d.body}:{})}};
 }


 case 'knowledge.sections':{
  const {document_id}=z.object({document_id:uuid}).parse(params);
  const r=await pool.query("SELECT title,body,updated_at FROM documents WHERE project_id=$1 AND id=$2 AND knowledge_status='approved'",[projectId,document_id]);
  if(!r.rowCount)throw rejected('Утверждённый документ не найден',404);
  const sections=markdownSections(document_id,String(r.rows[0].body)).map(s=>({section_id:s.section_id,level:s.level,title:s.title}));
  return {document_id,title:r.rows[0].title,version:revision(r.rows[0].updated_at),sections};
 }
 case 'knowledge.section':{
  const {document_id,section_id,task_id}=z.object({document_id:uuid,section_id:z.union([uuid,z.number().int().min(0)]),task_id:uuid.optional()}).parse(params);
  const r=await pool.query("SELECT body,title,updated_at FROM documents WHERE project_id=$1 AND id=$2 AND knowledge_status='approved'",[projectId,document_id]);
  if(!r.rowCount)throw rejected('Утверждённый документ не найден',404);
  if(task_id&&!await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[task_id,projectId]).then(r=>r.rowCount))throw rejected('Задача не найдена',404);
  const section=markdownSections(document_id,String(r.rows[0].body)).find(s=>typeof section_id==='number'?s.line===section_id:s.section_id===section_id);
  if(!section)throw rejected('Раздел не найден',404);
  await pool.query('INSERT INTO knowledge_context_reads(id,project_id,task_id,document_id,document_version,agent_stage,agent_session_id,process_id,section_id,section_title) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [randomUUID(),projectId,task_id||null,document_id,revision(r.rows[0].updated_at),session.role,session.id,session.process_id??null,section.section_id,section.title]);
  return {document_id,section_id:section.section_id,title:section.title,body:sectionBody(String(r.rows[0].body),section),version:revision(r.rows[0].updated_at)};
 }

 case 'knowledge.related':{
  const {document_id}=z.object({document_id:uuid}).parse(params);
  const r=await pool.query("SELECT k.id,k.relation,d.id AS related_document_id,d.title,d.knowledge_summary AS summary FROM knowledge_links k JOIN documents d ON d.id=CASE WHEN k.source_document_id=$2 THEN k.target_document_id ELSE k.source_document_id END AND d.project_id=$1 WHERE k.project_id=$1 AND (k.source_document_id=$2 OR k.target_document_id=$2) AND d.knowledge_status='approved' LIMIT 60",[projectId,document_id]);
  return {results:r.rows};
 }
 case 'knowledge.context':{
  const {task_id,stage,tags}=z.object({
   task_id:uuid,stage:z.enum(['analysis','development','testing','documentation','manager']).default('analysis'),
   tags:z.array(z.string().min(1).max(60)).max(24).default([])
  }).parse(params);
  return buildKnowledgeContext(pool,{projectId,taskId:task_id,stage,sessionId:session.id,tags});
 }

 case 'tasks.list':{
  const {product_owner_questions_only}=z.object({product_owner_questions_only:z.boolean().optional()}).parse(params);
  if(product_owner_questions_only){
   const tasks=(await tasksWithCustomerQuestions(pool,projectId)).filter(task=>task.awaits_product_owner);
   return {tasks:tasks.map(({id,title,stage,type,document_id,question_status,analysis_state,display_number})=>({id,title,stage,type,document_id,question_status,analysis_state,display_number}))};
  }
  const r=await pool.query('SELECT id,title,description,type,stage,analysis_state,display_number,document_id,question_status,updated_at FROM tasks WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 500',[projectId]);
  return {tasks:r.rows};
 }
 case 'tasks.read':{
  const {task_id}=z.object({task_id:uuid}).parse(params);
  const r=await pool.query('SELECT id,title,description,stage,analysis_state,clarification_questions,depends_on_task_id,pr_url,pr_number,git_branch,pr_base_branch,spec_version,spec_review_status,spec_reviewed_commit,test_feedback,updated_at FROM tasks WHERE project_id=$1 AND id=$2',[projectId,task_id]);
  if(!r.rowCount)throw rejected('Задача не найдена',404);
  const [conversation,questions,open,answers,repository]=await Promise.all([
   taskConversationEvidence(pool,projectId,task_id),
   pool.query("SELECT id AS note_id,body AS question,answer,answer_author FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status='answered' AND answer IS NOT NULL ORDER BY answered_at DESC NULLS LAST,id DESC LIMIT 12",[projectId,task_id]),
   pool.query("SELECT id AS note_id,body AS question,author_stage,requires_customer,status FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status IN ('open','processing') ORDER BY created_at,id LIMIT 20",[projectId,task_id]),
   pool.query("SELECT body AS answer,source_key,created_at FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='resolution' AND source_key LIKE 'owner-answer:%' ORDER BY created_at DESC LIMIT 8",[projectId,task_id]),
   pool.query('SELECT repository,target_branch,default_branch FROM project_git_repositories WHERE project_id=$1',[projectId])
  ]);
  const work_brief=await readTaskWorkBrief(pool,projectId,task_id,4800);
  const task=r.rows[0],repo=repository.rows[0];
  // Return authoritative task/PR identity. The model can decide which extra
  // documents, QA evidence or process reports to fetch with its reader tools.
  const git=repo?{
   repository:repo.repository,
   branch:task.git_branch||null,
   base_branch:task.pr_base_branch||repo.target_branch||repo.default_branch||null,
   pr_url:task.pr_url||null,
   pr_number:task.pr_number||null,
   reviewed_commit:task.spec_reviewed_commit||null
  }:null;
  return {task,git,conversation,work_brief,open_questions:open.rows,answered_questions:questions.rows,owner_answers:answers.rows};
 }
 case 'tasks.history':{
  const {task_id,cursor,limit}=z.object({
   task_id:uuid,cursor:z.string().max(180).optional(),limit:z.number().int().min(10).max(80).default(40)
  }).parse(params);
  if(session.task_id&&session.task_id!==task_id)throw rejected('Сессия привязана к другой задаче',403);
  const task=await pool.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2',[projectId,task_id]);
  if(!task.rowCount)throw rejected('Задача не найдена',404);
  let beforeTime:string|null=null,beforeId:string|null=null;
  if(cursor){
   const parts=Buffer.from(cursor,'base64url').toString('utf8').split('|');
   if(parts.length!==2||!z.string().datetime({offset:true}).safeParse(parts[0]).success||!uuid.safeParse(parts[1]).success)
    throw rejected('Некорректный курсор истории',400);
   [beforeTime,beforeId]=parts;
  }
  const events=await pool.query(`
   SELECT h.id,h.created_at,h.kind,h.data FROM (
    SELECT m.id,m.created_at,'message' AS kind,
     jsonb_build_object('role',m.role,'body',left(m.body,2500),'channel',m.channel) AS data
     FROM assistant_messages m WHERE m.project_id=$1 AND m.task_id=$2
    UNION ALL
    SELECT n.id,n.created_at,'agent_note' AS kind,
     jsonb_build_object('stage',n.author_stage,'kind',n.kind,'body',left(n.body,2500),'target',n.target_stage) AS data
     FROM task_agent_notes n WHERE n.project_id=$1 AND n.task_id=$2
    UNION ALL
    SELECT e.id,e.created_at,'task_event' AS kind,
     jsonb_build_object('event',e.event,'detail',left(e.detail,2000)) AS data
     FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.project_id=$1 AND t.id=$2
   ) h WHERE ($3::timestamptz IS NULL OR (h.created_at,h.id)<($3::timestamptz,$4::uuid))
   ORDER BY h.created_at DESC,h.id DESC LIMIT $5`,[projectId,task_id,beforeTime,beforeId,limit+1]);
  const page=events.rows.slice(0,limit);
  const last=page.at(-1);
  return {task_id,events:page,next_cursor:events.rows.length>limit&&last
   ?Buffer.from(new Date(last.created_at).toISOString()+'|'+last.id).toString('base64url'):null};
 }
 case 'tasks.route_execution':{
  if(session.role!=='manager')throw rejected('Маршрутизация доступна только ПМ',403);
  const {task_id,source_sha,reason}=z.object({
   task_id:uuid,source_sha:z.string().regex(/^[a-f0-9]{40}$/i),
   reason:z.string().trim().min(12).max(1600)
  }).parse(params);
  return routeTaskToBrowserEvidence(pool,{
   projectId,taskId:task_id,actorId,sourceSha:source_sha,reason
  });
 }
 case 'tasks.retry_evidence':{
  if(session.role!=='manager')throw rejected('Повтор доступен только ПМ',403);
  const {task_id,reason}=z.object({task_id:uuid,reason:z.string().trim().min(12).max(1600)}).parse(params);
  return retryTaskBrowserEvidence(pool,{projectId,taskId:task_id,actorId,reason});
 }
 case 'tasks.create':{
  const {title,description}=z.object({title:z.string().trim().min(3).max(180),description:z.string().trim().min(10).max(12000)}).parse(params);
  const id=randomUUID();
  // Same initial state as the public task-creation API: the agent can create
  // work, but cannot bypass analysis or requirement acceptance by creating it.
  await pool.query("INSERT INTO tasks(id,project_id,title,description,type,position) VALUES($1,$2,$3,$4,'task',(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2))",[id,projectId,title,description]);
  await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'created','Создано агентом через инструменты сервиса')",[randomUUID(),id,actorId]);
  return {id,stage:'backlog'};
 }
 case 'questions.list':{
  const r=await pool.query("SELECT q.id,q.description AS question,q.question_answer AS answer,q.question_status AS status,q.document_id,d.title AS document_title FROM tasks q JOIN documents d ON d.id=q.document_id WHERE q.project_id=$1 AND q.type='question' AND q.question_status IN ('open','answered') ORDER BY q.created_at DESC LIMIT 500",[projectId]);
  return {questions:r.rows};
 }
 case 'questions.create':{
  const {document_id,question}=z.object({document_id:uuid,question:z.string().trim().min(8).max(700)}).parse(params);
  if(!await parentExists(pool,projectId,document_id))throw rejected('Документ не найден',404);
  const key=hashSecret(question.trim().toLowerCase()).slice(0,24);
  await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage,position,document_id,question_key,question_topic,question_status) VALUES($1,$2,$3,$4,'question','backlog',(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2),$5,$6,'agent','open') ON CONFLICT DO NOTHING",
   [randomUUID(),projectId,question.slice(0,300),question,document_id,key]);
  return {document_id,question_key:key};
 }
 case 'documentation.answer_question':{
  const {question_id,answer}=z.object({question_id:uuid,answer:z.string().trim().min(3).max(4000)}).parse(params);
  const changed=await pool.query("UPDATE tasks SET question_status='answered',question_answer=$3,question_answered_at=now(),updated_at=now() WHERE id=$1 AND project_id=$2 AND type='question' AND question_status='open' RETURNING document_id,description",
   [question_id,projectId,answer]);
  if(!changed.rowCount)throw rejected('Вопрос уже обработан или не найден');
  const question=changed.rows[0],jobId=randomUUID();
  const input={location:null,attachments:[],mode:'documentation',documentId:question.document_id,questionId:question_id};
  await pool.query("INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,request_text,source_key,analyst_input) VALUES($1,$2,$3,'queued','Аналитик обновит ТЗ по ответу',$4,$5,$6)",
   [jobId,projectId,actorId,'Ответ на вопрос: '+question.description+'\n\n'+answer,'po-answer:'+question_id,JSON.stringify(input)]);
  return {import_job_id:jobId,status:'queued'};
 }
 case 'documentation.resume_spec':{
  if(session.role!=='manager')throw rejected('Продолжить поручение может ПМ',403);
  const {job_id,answer}=z.object({job_id:uuid,answer:z.string().trim().min(5).max(6000)}).parse(params);
  const previous=(await pool.query(
   "SELECT actor_id,request_text,analyst_input,result FROM document_import_jobs WHERE id=$1 AND project_id=$2 AND status='waiting_input' FOR UPDATE",
   [job_id,projectId])).rows[0];
  if(!previous)throw rejected('Исходное поручение не ожидает ответа',409);
  const jobId=randomUUID(),context=previous.analyst_input||{};
  const input={...context,autonomous:true,previousJobId:job_id,readProjectSource:false,requireChanges:false};
  await pool.query(`INSERT INTO document_import_jobs
   (id,project_id,actor_id,status,message,request_text,source_key,analyst_input)
   VALUES($1,$2,$3,'queued','Продолжение после ответа ПМ',$4,$5,$6::jsonb)`,
   [jobId,projectId,previous.actor_id,String(previous.request_text||'')+
    '\n\nУточнение для продолжения от ПМ: '+answer,'documentation.continue:'+jobId,JSON.stringify(input)]);
  await pool.query("UPDATE document_import_jobs SET status='continued',updated_at=now() WHERE id=$1 AND status='waiting_input'",[job_id]);
  return {import_job_id:jobId,status:'queued',resumes:job_id,kind:'documentation.resume_spec'};
 }
 case 'documentation.prepare_spec':case 'documentation.import':case 'documentation.rebuild':case 'documentation.organize':{
  const data=z.object({source_url:z.string().url().max(1000).optional(),instructions:z.string().max(16000).default(''),document_id:uuid.optional()}).parse(params);
  const location=name==='documentation.import'?extractGitHubDocumentLocation(data.source_url||''):null;
  if(name==='documentation.import'&&!location)throw rejected('Укажи URL папки или Markdown-файла GitHub');
  if(name==='documentation.prepare_spec'&&!data.instructions.trim())throw rejected('Нужны вводные для аналитика',400);
  if(data.document_id&&!await parentExists(pool,projectId,data.document_id))throw rejected('Документ не найден',404);
  const jobId=randomUUID(),sourceUrl=data.source_url||null;
  const input={location,attachments:[],mode:'documentation',documentId:data.document_id??null,
   // All agent-triggered documentation operations share one autonomous MCP
   // workflow. The legacy imported-topic organizer remains available only
   // to explicit legacy jobs, never as the PM's default route.
   structureOnly:false,rebuildSpec:false,
   requireChanges:false,readProjectSource:false,autonomous:name!=='documentation.import'};
  const sourceKey=location?'github-ai:'+location.owner+'/'+location.repository+'@'+location.branch+':'+location.path:name+':'+jobId;
  const competing=await pool.query(
   "SELECT id FROM document_import_jobs WHERE project_id=$1 AND status IN ('running','queued','waiting_input') LIMIT 1 FOR UPDATE",
   [projectId]);
  if(competing.rowCount)throw rejected('В проекте уже выполняется процесс аналитика');
  // The job and audit event commit together. Temporal is started only after COMMIT,
  // and a retry of the same idempotency key recovers a queued job, not a new one.
  await pool.query(
   "INSERT INTO document_import_jobs(id,project_id,actor_id,status,message,source_url,source_key,request_text,analyst_input) VALUES($1,$2,$3,'queued','Запуск процесса ожидает Temporal',$4,$5,$6,$7)",
   [jobId,projectId,actorId,sourceUrl,sourceKey,data.instructions||name,JSON.stringify(input)]);
  return {import_job_id:jobId,status:'queued',kind:name};
 }
 case 'processes.list':{
  const {task_id,process_id}=z.object({task_id:uuid.optional(),process_id:uuid.optional()}).parse(params);
  if(process_id){
   if(session.task_id){
    const process=await pool.query(`SELECT id FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 AND id=$3
     UNION ALL SELECT id FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND id=$3
     UNION ALL SELECT id FROM requirement_review_runs WHERE project_id=$1 AND task_id=$2 AND id=$3
     UNION ALL SELECT id FROM agent_work_assignments WHERE project_id=$1 AND task_id=$2 AND id=$3`,[projectId,session.task_id,process_id]);
    if(!process.rowCount)throw rejected('Процесс не найден в задаче',404);
   }
   const test=(await pool.query('SELECT id,task_id,status,verdict,report,qa_plan_snapshot FROM ai_test_runs WHERE project_id=$1 AND id=$2',[projectId,process_id])).rows[0];
   if(test){
    const names=new Map((test.qa_plan_snapshot?.cases??[]).map((item:{id:string;title:string})=>[item.id,item.title]));
    const {qa_plan_snapshot:_,report,...run}=test;
    return {...run,report:report?{...report,caseResults:(report.caseResults??[]).map((item:{case_id:string})=>({...item,title:names.get(item.case_id)}))}:null};
   }
   const events=await pool.query('SELECT stage,detail,created_at FROM process_events WHERE project_id=$1 AND process_id=$2 ORDER BY created_at DESC LIMIT 20',[projectId,process_id]);
   return {process_id,events:events.rows};
  }
  const [a,b,queue,testing,reviews,assignments]=await Promise.all([
   pool.query('SELECT id,status,message,created_at,updated_at FROM document_import_jobs WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 30',[projectId]),
   pool.query('SELECT id,task_id,status,message,created_at,completed_at FROM ai_task_runs WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2) ORDER BY created_at DESC LIMIT 30',[projectId,task_id??null]),
   readDevelopmentQueue(pool,projectId),
   pool.query('SELECT id,task_id,status,verdict,message,created_at,completed_at FROM ai_test_runs WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2) ORDER BY created_at DESC LIMIT 30',[projectId,task_id??null]),
   pool.query('SELECT id,task_id,status,message,created_at,completed_at FROM requirement_review_runs WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2) ORDER BY created_at DESC LIMIT 30',[projectId,task_id??null]),
   pool.query('SELECT id,task_id,role,status,objective,result,evidence,created_at,updated_at FROM agent_work_assignments WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2) ORDER BY created_at DESC LIMIT 50',[projectId,task_id??null])
  ]);
  return {documentation:task_id?[]:a.rows,development:b.rows,testing:testing.rows,requirements:reviews.rows,assignments:assignments.rows,development_queue:queue.filter(row=>!task_id||row.task_id===task_id).map(({task_id,display_number,title,status,reason,detail})=>({task_id,display_number,title,status,reason,detail}))};
 }
 case 'processes.report':{
  const {stage,message}=z.object({stage:z.string().trim().min(2).max(80),message:z.string().trim().min(3).max(2000)}).parse(params);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'agent',$4,$5)",
   [randomUUID(),projectId,session.id,stage,message]);
  return {reported:true};
 }
 case 'memory.list':{
  const r=await pool.query('SELECT id,role,kind,body,evidence,status,created_at FROM agent_memory WHERE project_id=$1 ORDER BY created_at DESC LIMIT 60',[projectId]);
  return {memories:r.rows};
 }
 case 'memory.record':{
  const {kind,text,evidence}=z.object({kind:z.enum(['observation','instruction_suggestion']),text:z.string().trim().min(15).max(1600),evidence:z.string().max(600).default('')}).parse(params);
  const id=randomUUID(),status=kind==='observation'?'recorded':'proposed';
  await pool.query(
   'INSERT INTO agent_memory(id,project_id,session_id,role,kind,body,evidence,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [id,projectId,session.id,session.role,kind,text,evidence,status]);
  return {id,status};
 }
 default:throw rejected('Неизвестный инструмент: '+name,404);
 }
}

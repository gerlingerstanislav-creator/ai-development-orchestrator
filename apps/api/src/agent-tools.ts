import type {Pool} from 'pg';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {agentMemoryContext} from './project-team.js';

export const hashSecret=(text:string)=>createHash('sha256').update(text).digest('hex');
const field=(type:string,description:string)=>({type,description});
const readOnlyTools=new Set(['project.context','documents.list','documents.read','documents.search',
 'tasks.list','tasks.read','tasks.request_owner_question_cleanup','questions.list','processes.list','memory.list','documentation.request_reset',
 'iterations.list','iterations.read','knowledge.search','knowledge.read','knowledge.related','knowledge.context','knowledge.section','knowledge.sections']);
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[])=>({
 name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
 annotations:readOnlyTools.has(name)
  ?{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  :{readOnlyHint:false}
});
const id=field('string','UUID'),str=field('string','Произвольный текст');
const idem=field('string','Необязательный стабильный ключ идемпотентности для безопасных повторов');
export const agentToolCatalog=[
 tool('project.context','Получить информацию о проекте, правила, workflow, GitHub и инструкции.',{}),
 tool('iterations.list','Найти итерации в разделе «План разработки».',{}),
 tool('iterations.read','Прочитать объём итерации, ссылки на документы, текущие задачи и ревизии.',{iteration_id:id},['iteration_id']),
 tool('iterations.save','По явной просьбе сохрани согласованное в обсуждении описание как черновик итерации. Для обновления передай ID и текущую ревизию. Сохраняй цель, границы, критерии готовности и исходные страницы.',
  {iteration_id:id,expected_revision:field('integer','Текущая ревизия'),title:str,body:str,document_ids:{type:'array',items:id},idempotency_key:idem},['title','body']),
 tool('iterations.prepare_plan','Передать согласованный объём системному аналитику. Запускает подготовку черновика с эпиками, задачами, тегами и зависимостями. Для создания задач владелец подтверждает предпросмотр.',
  {iteration_id:id,request:field('string','Уточнение владельца к декомпозиции в границах согласованного объёма'),idempotency_key:idem},['iteration_id']),
 tool('iterations.recommend_launch','Сохранить предлагаемый пакет до пяти задач в порядке запуска для выбора владельцем. Вызов не запускает разработку.',
  {iteration_id:id,task_ids:{type:'array',items:id},idempotency_key:idem},['iteration_id','task_ids']),
 tool('documents.list','Показать дерево документации с ревизиями. Перед созданием страниц ознакомься с существующей структурой, вложенные разделы определяются агентами.',{}),
 tool('documents.read','Прочитать полную страницу и получить revision.',{document_id:id},['document_id']),
 tool('documents.search','Найти страницы по содержимому или названию.',{query:str},['query']),
 tool('documents.create','Создать страницу в выбранном существующем разделе. Прочитай дерево и проверь похожие страницы; при совпадении смысла обнови их вместо дублирования. Вложенную структуру выбирай по контексту проекта и практике подготовки ТЗ.',{title:str,body:str,parent_id:id,idempotency_key:idem},['title','body','parent_id']),
 tool('documents.update','Обновить страницу с проверкой revision. Не изменяй системные корни.',{document_id:id,expected_revision:str,title:str,body:str,parent_id:id,idempotency_key:idem},['document_id','expected_revision']),
 tool('documents.changeset','Атомарно применить список create/update. Сначала проверь дерево и существующие страницы, переиспользуй подходящие документы; создавай новые разделы по необходимости, избегая фиксированных шаблонов.',{operations:{type:'array',items:{type:'object',properties:{op:field('string','create или update'),document_id:id,expected_revision:str,title:str,body:str,parent_id:id},required:['op']}},idempotency_key:idem},['operations']),
 tool('knowledge.search','Поиск утверждённых проектных знаний по названию, тексту и метаданным. Верни сначала короткие результаты.',{query:str,limit:field('number','Максимум 20 результатов')},['query']),
 tool('knowledge.read','Адресно прочитать документ из базы знаний и записать использованную версию.',{document_id:id,mode:field('string','summary или full'),task_id:id},['document_id']),
 tool('knowledge.sections','Перечислить заголовки Markdown и получить стабильные UUID разделов без полного текста.',{document_id:id},['document_id']),
 tool('knowledge.section','Читать один Markdown-раздел по стабильному UUID из knowledge.sections; экономит контекст.',{document_id:id,section_id:field('string','UUID раздела из knowledge.sections'),task_id:id},['document_id','section_id']),
 tool('knowledge.related','Найти связанные требования и архитектурные документы.',{document_id:id},['document_id']),
 tool('knowledge.context','Получить минимальный обязательный контекст и релевантные документы для задачи.',{task_id:id,stage:str},['task_id']),
 tool('tasks.list','Получить задачи и этапы. Для колонки «Вопросы к ПО» передай product_owner_questions_only=true. Включает также вопросы по документации, созданные аналитиком: это задачи типа question.',{product_owner_questions_only:field('boolean','Показать только задачи из колонки «Вопросы к ПО»')}),
 tool('tasks.read','Прочитать задачу, недавние реплики и ответы на вопросы. Используй перед повторным обращением к пользователю по этой задаче.',{task_id:id},['task_id']),
 tool('tasks.request_owner_question_cleanup','По явному запросу пользователя открыть предпросмотр удаления из колонки «Вопросы к ПО». Учти задачи типа question, созданные аналитиком. Удаление — только после явного подтверждения владельца.',{}),
 tool('tasks.create','Создать задачу с конкретными требованиями в бэклоге. Запуск анализа и разработки выполняется отдельно.',{title:str,description:str,idempotency_key:idem},['title','description']),
 tool('questions.list','Посмотреть вопросы по документации (задачи типа question), включая их статус и привязку к документу.',{}),
 tool('questions.create','Задать вопрос владельцу продукта, привязав к документу.',{document_id:id,question:str,idempotency_key:idem},['document_id','question']),
 tool('documentation.import','Запустить через Temporal импорт Markdown из GitHub. Источники будут закреплены на SHA.',{source_url:str,instructions:str,idempotency_key:idem},['source_url']),
 tool('documentation.request_reset','Предложить пользователю открыть подтверждение полной очистки документации проекта. Вызывай только по явной просьбе пользователя удалить всю документацию. Вызов показывает кнопку и не изменяет документы.',{}),
 tool('documentation.rebuild','Запустить пересборку ТЗ с сохранением предыдущих документов.',{instructions:str,idempotency_key:idem}),
 tool('documentation.organize','Запустить улучшение структуры и расположения страниц.',{instructions:str,idempotency_key:idem}),
 tool('approvals.list','Прочитать ожидающие решения владельца согласования по задачам (требования, вопросы агентов, QA).',{}),
 tool('approvals.decide','Передать явно выраженное решение владельца на существующий запрос согласования. Проверки workflow обязательны; обход QA-проверок запрещён.',{task_id:id,request_id:id,choice:field('string','answer, approve_requirements, reject_requirements или wait_for_tools'),answer:field('string','Ответ владельца для choice=answer')},['task_id','request_id','choice']),
 tool('workflow.launch','По явному распоряжению владельца запустить подготовленную к разработке задачу через существующий API с проверкой условий.',{task_id:id},['task_id']),
 tool('discussions.list','Список тем ПМ проекта с открытыми и закрытыми обсуждениями.',{}),
 tool('discussions.open','Создать тему обсуждения с владельцем. Повторно используй уже открытую тему с тем же смыслом.',{title:str},['title']),
 tool('discussions.close','Закрыть обсуждение после ответа владельца и передачи решения. Можно открыть повторно через discussions.reopen.',{topic_id:id},['topic_id']),
 tool('discussions.reopen','Открыть закрытую тему для дополнительных уточнений.',{topic_id:id},['topic_id']),
 tool('processes.list','Получить текущие и завершённые процессы проекта.',{}),
 tool('processes.report','Зафиксировать прогресс автономного агента в журнале.',{stage:str,message:str},['stage','message']),
 tool('memory.list','Прочитать накопленный опыт и предлагаемые инструкции.',{}),
 tool('memory.record','Сохранить опыт либо предложить улучшение инструкции. Опыт не становится автоматически обязательным правилом.',{kind:field('string','observation или instruction_suggestion'),text:str,evidence:str,idempotency_key:idem},['kind','text'])
];
export type AgentRole='manager'|'analyst'|'business_analyst';

/** Business analysts own product knowledge, not the executable backlog. A handoff
 * requires an explicit authenticated user action outside the model tool catalog. */
const BA_DENIED=new Set(['tasks.create','tasks.request_owner_question_cleanup','questions.create','iterations.recommend_launch']);
export function toolsForRole(role:AgentRole){
 return agentToolCatalog.filter(t=>role==='manager'?t.name!=='documentation.request_reset':!BA_DENIED.has(t.name)&&!t.name.startsWith('discussions.'));
}
export function toolAllowedForRole(role:AgentRole,name:string){
 return toolsForRole(role).some(t=>t.name===name);
}
export type AgentSession={id:string;project_id:string;actor_id:string;role:AgentRole;status:string;expires_at:Date};

export async function initAgentToolsSchema(pool:Pick<Pool,'query'>){
 await pool.query([
 'CREATE TABLE IF NOT EXISTS agent_sessions(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,actor_id uuid NOT NULL REFERENCES users(id),role text NOT NULL,token_hash text NOT NULL UNIQUE,status text NOT NULL DEFAULT \'running\',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz)',
 'CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id,created_at DESC)',
 'CREATE TABLE IF NOT EXISTS agent_tool_events(id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,tool text NOT NULL,arguments jsonb NOT NULL DEFAULT \'{}\'::jsonb,result jsonb,success boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),idempotency_key text)',
 'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_idempotency ON agent_tool_events(project_id,tool,idempotency_key) WHERE idempotency_key IS NOT NULL AND success',
 'CREATE INDEX IF NOT EXISTS idx_agent_tool_events_session ON agent_tool_events(session_id,created_at)',
 'CREATE TABLE IF NOT EXISTS agent_memory(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,role text NOT NULL,kind text NOT NULL,body text NOT NULL,evidence text NOT NULL DEFAULT \'\',status text NOT NULL DEFAULT \'recorded\',created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz)',
 'CREATE INDEX IF NOT EXISTS idx_agent_memory_project ON agent_memory(project_id,created_at DESC)'
 ].join(';\n')+';');
}
export async function createAgentSession(pool:Pick<Pool,'query'>,projectId:string,actorId:string,role:AgentRole){
 const secret=randomBytes(32).toString('hex'),id=randomUUID();
 await pool.query("INSERT INTO agent_sessions(id,project_id,actor_id,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '40 minutes')",
  [id,projectId,actorId,role,hashSecret(secret)]);
 return {id,secret};
}
export async function finishAgentSession(pool:Pick<Pool,'query'>,id:string){
 await pool.query("UPDATE agent_sessions SET status='completed',finished_at=now() WHERE id=$1 AND status='running'",[id]);
}
export async function readAgentSession(pool:Pick<Pool,'query'>,secret:string):Promise<AgentSession|null>{
 if(!/^[0-9a-f]{64}$/.test(secret))return null;
 const r=await pool.query("SELECT id,project_id,actor_id,role,status,expires_at FROM agent_sessions WHERE token_hash=$1 AND status='running' AND expires_at>now()",[hashSecret(secret)]);
 return r.rows[0]||null;
}
export async function agentSessionEffects(pool:Pick<Pool,'query'>,id:string){
 const rows=(await pool.query('SELECT tool,result,success,created_at FROM agent_tool_events WHERE session_id=$1 ORDER BY created_at,id',[id])).rows;
 const value=(name:string,key:string)=>rows.filter(r=>r.success&&r.tool===name).map(r=>r.result?.[key]).filter(Boolean).at(-1)||null;
 return {events:rows,created_document_id:value('documents.create','id'),created_task_id:value('tasks.create','id'),
  owner_question_cleanup_requested:value('tasks.request_owner_question_cleanup','requires_user_confirmation')===true,
  documentation_reset_requested:value('documentation.request_reset','requires_user_confirmation')===true,
  import_job_id:value('documentation.import','import_job_id')||value('documentation.rebuild','import_job_id')||value('documentation.organize','import_job_id')};
}
export async function agentLearnedContext(pool:Pick<Pool,'query'>,projectId:string,role:AgentRole){
 return agentMemoryContext(pool,projectId,role);
}

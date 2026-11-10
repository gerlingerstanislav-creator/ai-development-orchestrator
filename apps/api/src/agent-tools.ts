import type {Pool} from 'pg';
import {randomBytes,randomUUID,createHash} from 'node:crypto';

export const hashSecret=(text:string)=>createHash('sha256').update(text).digest('hex');
const field=(type:string,description:string)=>({type,description});
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const id=field('string','UUID'),str=field('string','Произвольный текст');
const idem=field('string','Необязательный стабильный ключ идемпотентности для безопасных повторов');
export const agentToolCatalog=[
 tool('project.context','Получить информацию о проекте, правила, workflow, GitHub и инструкции.',{}),
 tool('documents.list','Показать дерево документации с ревизиями.',{}),
 tool('documents.read','Прочитать полную страницу и получить revision.',{document_id:id},['document_id']),
 tool('documents.search','Найти страницы по содержимому или названию.',{query:str},['query']),
 tool('documents.create','Создать страницу в выбранном родительском разделе.',{title:str,body:str,parent_id:id,idempotency_key:idem},['title','body','parent_id']),
 tool('documents.update','Обновить страницу с проверкой revision. Не изменяй системные корни.',{document_id:id,expected_revision:str,title:str,body:str,parent_id:id,idempotency_key:idem},['document_id','expected_revision']),
 tool('documents.changeset','Атомарно применить список create/update к страницам документации.',{operations:{type:'array',items:{type:'object',properties:{op:field('string','create или update'),document_id:id,expected_revision:str,title:str,body:str,parent_id:id},required:['op']}},idempotency_key:idem},['operations']),
 tool('tasks.list','Получить задачи и их реальные этапы.',{}),
 tool('tasks.read','Прочитать задачу по UUID.',{task_id:id},['task_id']),
 tool('tasks.create','Создать задачу в аналитике с конкретными требованиями.',{title:str,description:str,idempotency_key:idem},['title','description']),
 tool('questions.list','Посмотреть открытые вопросы к владельцу продукта.',{}),
 tool('questions.create','Задать вопрос владельцу продукта, привязав к документу.',{document_id:id,question:str,idempotency_key:idem},['document_id','question']),
 tool('documentation.import','Запустить через Temporal импорт Markdown из GitHub. Источники будут закреплены на SHA.',{source_url:str,instructions:str,idempotency_key:idem},['source_url']),
 tool('documentation.rebuild','Запустить пересборку ТЗ с сохранением предыдущих документов.',{instructions:str,idempotency_key:idem}),
 tool('documentation.organize','Запустить улучшение структуры и расположения страниц.',{instructions:str,idempotency_key:idem}),
 tool('processes.list','Получить текущие и завершённые процессы проекта.',{}),
 tool('processes.report','Зафиксировать прогресс автономного агента в журнале.',{stage:str,message:str},['stage','message']),
 tool('memory.list','Прочитать накопленный опыт и предлагаемые инструкции.',{}),
 tool('memory.record','Сохранить опыт либо предложить улучшение инструкции. Опыт не становится автоматически обязательным правилом.',{kind:field('string','observation или instruction_suggestion'),text:str,evidence:str,idempotency_key:idem},['kind','text'])
];
export type AgentRole='manager'|'analyst';
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
  import_job_id:value('documentation.import','import_job_id')||value('documentation.rebuild','import_job_id')||value('documentation.organize','import_job_id')};
}
export async function agentLearnedContext(pool:Pick<Pool,'query'>,projectId:string,role:AgentRole){
 const rows=(await pool.query("SELECT body,evidence,kind,status FROM agent_memory WHERE project_id=$1 AND role IN ($2,'manager') AND (kind='observation' OR (kind='instruction_suggestion' AND status='approved')) ORDER BY created_at DESC LIMIT 20",[projectId,role])).rows;
 return rows.reverse().map(r=>'- '+String(r.body).slice(0,800)+(r.evidence?' (основание: '+String(r.evidence).slice(0,160)+')':'')).join('\n');
}

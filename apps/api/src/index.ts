import {initAgentPromptAudit,recordAgentPrompt} from './agent-prompt.js';
import {workflowResponsibility} from './workflow-responsibilities.js';
import {initDiagnosticSchema,installDiagnosticHooks,registerDiagnosticRoutes} from './diagnostics.js';
import {initCloudDiagnosticsSchema,registerCloudDiagnosticsSettings,startCloudDiagnosticsSender} from './cloud-diagnostics.js';
import Fastify from 'fastify';
import {findActiveProjectOperation,projectDeletionConfirmation} from './project-lifecycle.js';
import {createMergeService} from './merge-service.js';
import {createMergeBatch,initMergeBatches,readMergeBatch,recoverMergeBatches} from './merge-batch.js';
import {initAutomaticDeployment,registerAutomaticDeploymentRoutes,validateHealthUrl} from './deployment-automation.js';
import { registerAssistantRoutes } from './assistant.js';
import {initChatImages,registerChatImageRoutes} from './chat-images.js';
import {initProjectIterations,registerProjectIterationRoutes} from './project-iterations.js';
import {resolveRoleAiSettings} from './project-team.js';
import {initAgentToolsSchema} from './agent-tools.js';
import {registerAgentToolRoutes} from './agent-tool-routes.js';
import {registerProjectTeamRoutes,initProjectTeamSchema} from './project-team.js';
import {agentInstructions} from './agent-instructions.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import {initDocumentationSystem} from './documentation-system.js';
import {initDocumentationReset,registerDocumentationResetRoutes} from './documentation-reset.js';
import {registerSafeTaskDeletion} from './task-deletion.js';
import {registerBusinessAnalystHandoff} from './business-analyst-handoff.js';
import {failProjectManagerInbox,initProjectManagerInbox,publishOwnerQuestionsToPmChat,pmInboxWorkflowId,registerProjectManagerInbox} from './project-manager-inbox.js';
import {initKnowledgeContext,registerKnowledgeContextRoutes} from './knowledge-context.js';
import {initKnowledgeWorkflow} from './knowledge-workflow.js';
import {registerKnowledgeWorkflowRoutes} from './knowledge-workflow-routes.js';
import {initKnowledgeDocumentUpdates,registerKnowledgeDocumentUpdateRoutes} from './knowledge-document-updates.js';
import {fingerprint} from './topic-import.js';
import { initQaSchema,registerQaRoutes } from './qa.js';
import {initQaWaiverSchema,registerQaWaiverRoutes} from './qa-waiver.js';
import {initRequirementsSchema,saveSpecRevision,updateCurrentSpecification} from './requirements.js';
import {initTaskAgentNotesSchema,registerTaskAgentNotesRoutes,pendingAgentQuestions} from './task-agent-notes.js';
import {readAgentActivity} from './task-agent-activity.js';
import {initTaskCancellationSchema,registerTaskCancellationRoutes} from './task-cancellation.js';
import {initTaskOrchestrationSchema,acquireTaskOrchestration,releaseTaskOrchestration} from './task-orchestration.js';
import {enqueueDevelopment,readDevelopmentQueue,reconcileAgentWorkQueue} from './agent-work-scheduler.js';
import {initAgentPeerQueue,reconcileAgentPeerQueue} from './agent-peer-queue.js';
import {initTaskAnalysisQueue,reconcileTaskAnalysisQueue} from './task-analysis-queue.js';
import {initProjectManagerSchema,isPrEvidenceRequest,registerProjectManagerRoutes,tasksWithCustomerQuestions,type ManagerDeps} from './project-manager.js';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
const { compare, hash } = bcrypt;
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let temporalClient:Promise<Client>|null=null;
function temporal():Promise<Client>{
 return temporalClient??=Connection.connect({address:process.env.TEMPORAL_ADDRESS||'temporal:7233'})
  .then(connection=>new Client({connection,namespace:'default'}))
  .catch(error=>{temporalClient=null;throw error;});
}

const jwtKey = new TextEncoder().encode(process.env.JWT_SECRET || '');
const keyText = process.env.CREDENTIALS_KEY || '';
const encryptionKey = Buffer.from(keyText, 'hex');
if (!process.env.JWT_SECRET || jwtKey.length < 32 || encryptionKey.length !== 32) throw Error('Set secure JWT_SECRET and 64-char hex CREDENTIALS_KEY');
const validStages = z.enum(['backlog','analysis','development','testing','merge_queue','deployment','documentation','done']);
const validMode = z.enum(['automatic','approval','manual']);
const workflowDefaults = [
  ['backlog','Бэклог','manual'],
  ['analysis','Анализ','approval'],
  ['development','Разработка','approval'],
  ['testing','Тестирование','automatic'],
  ['merge_queue','Ожидает слияния','manual'],
  ['deployment','Выкладка','manual'],
  ['documentation','Документация','manual'],
  ['done','Готово','manual']
] as const;
const workflowStageDescriptions:Record<string,string>={
 "backlog": "Новые задачи и идеи ожидают утверждённого объёма.",
 "analysis": "Аналитики прорабатывают требования, техническую реализацию и зависимости.",
 "development": "Разработчики реализуют готовые задачи и прикрепляют PR.",
 "testing": "QA проверяет изменения и при необходимости возвращает дефекты.",
 "merge_queue": "Проверенные PR последовательно сливаются в целевую ветку.",
 "deployment": "DevOps выполняет либо согласованно пропускает выкладку.",
 "documentation": "Документация актуализируется по фактической реализации.",
 "done": "Работа завершена, результат и история сохранены."
};
const workflowAgentDefaults:Record<string,{name:string;instructions:string}>={
 backlog:{name:'',instructions:agentInstructions.backlog},
 analysis:{name:'Системный аналитик',instructions:agentInstructions.analysis},
 development:{name:'AI-разработчик',instructions:agentInstructions.development},
 testing:{name:'AI-тестировщик',instructions:agentInstructions.testing},
 deployment:{name:'AI-DevOps',instructions:agentInstructions.devops},
 documentation:{name:'AI-технический писатель',instructions:agentInstructions.documentation}
};
// Preserve the original administrator account when upgrading legacy local installs.
// A dotted reserved domain also passes conventional email validation.
function configuredAdminEmail(){
 const email=(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
 return email==='admin@localhost'?'admin@localhost.test':email;
}
async function dbInit() {
 await pool.query(`
 CREATE TABLE IF NOT EXISTS users (id uuid primary key, email text unique not null, password_hash text not null);
 CREATE TABLE IF NOT EXISTS auth_sessions (token_hash text primary key, user_id uuid not null references users(id) on delete cascade, expires_at timestamptz not null, created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
 CREATE TABLE IF NOT EXISTS projects (id uuid primary key, name text not null, description text not null default '', owner_id uuid not null references users(id), created_at timestamptz not null default now());
 ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
 CREATE INDEX IF NOT EXISTS idx_projects_owner_trash ON projects(owner_id,deleted_at,created_at DESC);
 CREATE TABLE IF NOT EXISTS memberships (project_id uuid references projects(id) on delete cascade, user_id uuid references users(id) on delete cascade, role text not null default 'member', primary key(project_id,user_id));
 CREATE TABLE IF NOT EXISTS workflow_stages (project_id uuid references projects(id) on delete cascade, stage text not null, label text not null, mode text not null, position int not null, primary key(project_id,stage));
 ALTER TABLE workflow_stages ADD COLUMN IF NOT EXISTS agent_name text NOT NULL DEFAULT '';
 ALTER TABLE workflow_stages ADD COLUMN IF NOT EXISTS agent_instructions text NOT NULL DEFAULT '';
 ALTER TABLE workflow_stages ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

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
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5);
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
 CREATE TABLE IF NOT EXISTS document_import_jobs (
  id uuid primary key, project_id uuid not null references projects(id) on delete cascade,
  actor_id uuid not null references users(id), status text not null,
  message text not null default '', result jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
 );
 CREATE INDEX IF NOT EXISTS idx_document_import_jobs_project ON document_import_jobs(project_id,created_at DESC);
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS source_url text;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS request_text text;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS source_file_count int;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS analyzed_chunks int not null default 0;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS total_chunks int;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS saved_documents int not null default 0;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS draft_result jsonb;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS source_key text;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS analyst_input jsonb;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_active_project_analyst ON document_import_jobs(project_id)
  WHERE status='running' AND analyst_input IS NOT NULL;
 CREATE TABLE IF NOT EXISTS document_import_checkpoints (
  job_id uuid not null references document_import_jobs(id) on delete cascade,
  chunk_index int not null,
  file_path text not null,
  content_sha text not null,
  notes text not null,
  created_at timestamptz not null default now(),
  primary key(job_id,chunk_index)
 );
 CREATE INDEX IF NOT EXISTS idx_document_import_checkpoints_source ON document_import_checkpoints(content_sha);

 CREATE TABLE IF NOT EXISTS process_events (
  id uuid primary key, project_id uuid not null references projects(id) on delete cascade,
  process_id uuid not null, process_kind text not null, level text not null default 'info',
  stage text not null, detail text not null default '',
  created_at timestamptz not null default now()
 );
 ALTER TABLE process_events ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id) ON DELETE CASCADE;
 CREATE INDEX IF NOT EXISTS idx_process_events_task ON process_events(project_id,task_id,created_at) WHERE task_id IS NOT NULL;
 CREATE INDEX IF NOT EXISTS idx_process_events_history ON process_events(project_id,process_id,created_at);
 CREATE TABLE IF NOT EXISTS process_instructions (
  id uuid primary key,project_id uuid not null references projects(id) on delete cascade,
  process_id uuid not null,actor_id uuid not null references users(id),
  body text not null,created_at timestamptz not null default now()
 );
 CREATE INDEX IF NOT EXISTS idx_process_instructions ON process_instructions(project_id,process_id,created_at);

 CREATE TABLE IF NOT EXISTS merge_process_runs (
  id uuid primary key,project_id uuid not null references projects(id) on delete cascade,
  actor_id uuid not null references users(id),status text not null default 'running',
  message text not null default '',current_task uuid,
  results jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),finished_at timestamptz
 );
 CREATE INDEX IF NOT EXISTS idx_merge_process_runs_project ON merge_process_runs(project_id,created_at DESC);


 ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_kind text not null default 'technical';
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS implementation_status text not null default 'unverified';
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS implementation_evidence text not null default '';

 UPDATE document_import_jobs SET status='failed',message='Импорт прерван перезапуском сервера. Повтори импорт.' WHERE status='running' AND analyst_input IS NULL;

 CREATE TABLE IF NOT EXISTS project_rules (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, body text not null, origin text not null default 'manual', source_task_id uuid references tasks(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_project_rules_project ON project_rules(project_id,created_at);
 CREATE TABLE IF NOT EXISTS project_rule_suggestions (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, task_id uuid references tasks(id) on delete cascade, body text not null, status text not null default 'pending', created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_rule_suggestions_project ON project_rule_suggestions(project_id,status);
 CREATE TABLE IF NOT EXISTS connections (id uuid primary key, owner_id uuid not null references users(id), name text not null, provider text not null, secret_encrypted text not null, created_at timestamptz not null default now());
 CREATE TABLE IF NOT EXISTS project_connections (project_id uuid references projects(id) on delete cascade, connection_id uuid references connections(id) on delete cascade, primary key(project_id,connection_id));
 CREATE TABLE IF NOT EXISTS project_deployment_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'skip' CHECK(mode IN ('skip','manual')),
  updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS task_deployment_records (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('skipped','pending','manual_confirmed')),
  reason text NOT NULL DEFAULT '',
  merge_sha text,
  actor_id uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_deployment_records_project ON task_deployment_records(project_id,status);
 INSERT INTO project_deployment_settings(project_id) SELECT id FROM projects ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS project_specialist_agents (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('devops')),
  agent_name text NOT NULL,
  agent_instructions text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,role)
 );
 INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions)
 SELECT id,'devops','AI-DevOps',
 'Отвечай за надёжность, скорость и экономичность CI/CD, GitHub Actions и выкладки. Анализируй фактические job, длительность, повторные установки зависимостей, кеширование, concurrency, отмену устаревших запусков, повторные сборки, артефакты, безопасность секретов и права GitHub token. Предлагай минимальные проверяемые изменения с измеримым эффектом. Не отключай тесты или защиту веток ради скорости. Используй неизменяемые версии артефактов, гарантируй идемпотентность и исключай параллельные деплои в одну среду. Перед выкладкой проверяй обязательные статусы и SHA; для продакшена нужен явный разрешённый механизм выкладки и стратегия отката. Не утверждай, что сделал deploy, если нет результата инструмента. Не запускай выкладку в ходе консультации.'
 FROM projects ON CONFLICT(project_id,role) DO NOTHING;
 CREATE TABLE IF NOT EXISTS project_git_repositories (project_id uuid primary key references projects(id) on delete cascade, connection_id uuid not null references connections(id), repository text not null, default_branch text not null, updated_at timestamptz not null default now());
 ALTER TABLE project_git_repositories ADD COLUMN IF NOT EXISTS target_branch text;
 UPDATE project_git_repositories SET target_branch=default_branch WHERE target_branch IS NULL;
 INSERT INTO workflow_stages(project_id,stage,label,mode,position)
 SELECT p.id,'merge_queue','Ожидает слияния','manual',4 FROM projects p
 ON CONFLICT(project_id,stage) DO NOTHING;
 INSERT INTO workflow_stages(project_id,stage,label,mode,position)
 SELECT p.id,'deployment','Выкладка','manual',6 FROM projects p
 ON CONFLICT(project_id,stage) DO NOTHING;
 INSERT INTO workflow_stages(project_id,stage,label,mode,position)
 SELECT p.id,'documentation','Документация','manual',5 FROM projects p
 ON CONFLICT(project_id,stage) DO NOTHING;
 INSERT INTO workflow_stages(project_id,stage,label,mode,position)
 SELECT p.id,'testing','Тестирование','automatic',4 FROM projects p
 ON CONFLICT(project_id,stage) DO NOTHING;
 UPDATE workflow_stages SET position=4 WHERE stage='testing';
 UPDATE workflow_stages SET position=5 WHERE stage='merge_queue';
 UPDATE workflow_stages SET position=6 WHERE stage='deployment';
 UPDATE workflow_stages SET position=7 WHERE stage='documentation';
 UPDATE workflow_stages SET position=8 WHERE stage='done';
 UPDATE workflow_stages SET agent_name=CASE stage
  WHEN 'analysis' THEN 'AI-аналитик'
  WHEN 'development' THEN 'AI-разработчик'
  WHEN 'testing' THEN 'AI-тестировщик'
  WHEN 'deployment' THEN 'AI-DevOps'
  WHEN 'documentation' THEN 'AI-технический писатель'
  ELSE 'Исполнитель' END WHERE agent_name='' AND stage NOT IN ('backlog','merge_queue','done');
 UPDATE workflow_stages SET agent_instructions=CASE stage
  WHEN 'analysis' THEN 'Уточняй требования, фиксируй проверяемые критерии приёмки и открытые вопросы. Не придумывай недостающие факты.'
  WHEN 'development' THEN 'Реализуй утверждённые требования в рабочей ветке, соблюдай правила проекта, исправляй замечания тестировщика. Не изменяй секреты.'
  WHEN 'testing' THEN 'Независимо проверь задачу и доступные тесты. Возвращай структурированные ошибки со способом воспроизведения, ожидаемым и фактическим результатом. Не объявляй непроверенное успешным.'
  WHEN 'documentation' THEN 'Обновляй подтверждённую реализованную функциональность после слияния PR. Отделяй проектные требования от фактической реализации.'
  WHEN 'deployment' THEN 'Проверяй готовность окружения и GitHub Actions. Не объявляй выкладку успешной без подтверждения. Обеспечь идемпотентность и возможность отката. Не храни секреты в коде.'
  WHEN 'backlog' THEN 'Регистрируй новые запросы и сохраняй их контекст до анализа.'
  ELSE '' END WHERE agent_instructions='';

 CREATE TABLE IF NOT EXISTS assistant_messages (id uuid primary key, project_id uuid not null references projects(id) on delete cascade, task_id uuid references tasks(id) on delete cascade, actor_id uuid references users(id), role text not null check(role in ('user','assistant')), body text not null, created_task_id uuid references tasks(id) on delete set null, created_at timestamptz not null default now());
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS created_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'project';
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed';
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES assistant_messages(id) ON DELETE SET NULL;
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS topic_id uuid;
 CREATE TABLE IF NOT EXISTS project_pm_orders(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES assistant_messages(id) ON DELETE SET NULL,
  topic_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','working','waiting_agents','waiting_user','completed','failed')),
  summary text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_project_pm_orders_project ON project_pm_orders(project_id,status,updated_at DESC);
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS pm_order_id uuid REFERENCES project_pm_orders(id) ON DELETE SET NULL;
 CREATE INDEX IF NOT EXISTS idx_assistant_pm_order ON assistant_messages(pm_order_id,created_at);
 CREATE TABLE IF NOT EXISTS project_pm_decisions(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  order_id uuid REFERENCES project_pm_orders(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES assistant_messages(id) ON DELETE SET NULL,
  iteration_id uuid,question text NOT NULL,answer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
 );
 CREATE INDEX IF NOT EXISTS idx_pm_decisions_project ON project_pm_decisions(project_id,created_at DESC);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_decision_source ON project_pm_decisions(project_id,source_message_id,question) WHERE source_message_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS project_pm_order_events(
  id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES project_pm_orders(id) ON DELETE CASCADE,
  kind text NOT NULL,detail text NOT NULL,process_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_pm_order_events ON project_pm_order_events(order_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS project_pm_process_reports(
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  process_id uuid NOT NULL,
  kind text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,process_id)
 );
 CREATE TABLE IF NOT EXISTS project_chat_topics (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz);
 CREATE INDEX IF NOT EXISTS idx_project_chat_topics_project ON project_chat_topics(project_id,status,created_at);
 CREATE INDEX IF NOT EXISTS idx_assistant_reply ON assistant_messages(project_id,reply_to);
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS documentation_reset_requested boolean NOT NULL DEFAULT false;
 ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS owner_question_cleanup_requested boolean NOT NULL DEFAULT false;
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
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS test_feedback text not null default '';
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS test_attempts int not null default 0;
 ALTER TABLE ai_task_runs ADD COLUMN IF NOT EXISTS cycle_id uuid;
 ALTER TABLE ai_task_runs ADD COLUMN IF NOT EXISTS runner_spec_version integer;
 ALTER TABLE ai_task_runs ADD COLUMN IF NOT EXISTS cycle_attempt int not null default 0;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_task_cycle_attempt ON ai_task_runs(cycle_id,cycle_attempt) WHERE cycle_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS ai_test_runs (
  id uuid primary key,project_id uuid not null references projects(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  cycle_id uuid not null,attempt int not null,
  status text not null default 'queued',message text not null default '',
  verdict text,report jsonb,created_at timestamptz not null default now(),
  completed_at timestamptz,unique(cycle_id,attempt)
 );
 CREATE INDEX IF NOT EXISTS idx_ai_test_runs_project ON ai_test_runs(project_id,created_at DESC);

 ALTER TABLE project_ai_settings ADD COLUMN IF NOT EXISTS daily_run_limit int not null default 3;
 `);
 const stageDefaults=Object.entries(workflowStageDescriptions);
 await pool.query(
  'UPDATE workflow_stages s SET description=d.description FROM (VALUES '+
   stageDefaults.map((_,i)=>'($'+(2*i+1)+'::text,$'+(2*i+2)+'::text)').join(',')+
  ') AS d(stage,description) WHERE s.stage=d.stage AND s.description=\'\'',
  stageDefaults.flat()
 );
 await initDocumentationSystem(pool);
 await initDocumentationReset(pool);
 await pool.query("UPDATE workflow_stages SET agent_name='Системный аналитик' WHERE stage='analysis' AND agent_name='AI-аналитик'");
 await initKnowledgeContext(pool);
 await initKnowledgeWorkflow(pool);
 await initKnowledgeDocumentUpdates(pool);
 const email=configuredAdminEmail();
 const password=process.env.ADMIN_PASSWORD;
 if (!email || !password || password.length < 12) throw Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters)');
 if(email==='admin@localhost.test'){
  // In-place migration keeps user ID, password hash, memberships and all owned data.
  await pool.query("UPDATE users SET email=$1 WHERE email='admin@localhost' AND NOT EXISTS (SELECT 1 FROM users WHERE email=$1)",[email]);
 }
 const existing=await pool.query('SELECT id FROM users WHERE email=$1',[email]);
 if (!existing.rowCount) await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[randomUUID(),email,await hash(password,12)]);
}
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.infer<T> { return schema.parse(input); }
installDiagnosticHooks(app,pool);
app.setErrorHandler((error,_,reply) => {
 if(error instanceof z.ZodError) return reply.code(400).send({error:'Некорректные данные',details:error.flatten()});
 app.log.error(error);
 const err = error as Error & {statusCode?:number};
 const status = typeof err.statusCode==='number' && err.statusCode>=400 && err.statusCode<500 ? err.statusCode : 500;
 return reply.code(status).send({error:status<500?err.message:'Ошибка сервера'});
});
const REFRESH_DAYS=30;
const REFRESH_COOKIE='ado-refresh';
function refreshHash(raw:string){return createHash('sha256').update(raw).digest('hex');}
function cookieValue(req:any,name:string){
 const line=String(req.headers.cookie||'');
 const item=line.split(';').map((x:string)=>x.trim()).find((x:string)=>x.startsWith(name+'='));
 return item?item.slice(name.length+1):null;
}
function setRefreshCookie(req:any,reply:any,raw:string|null){
 const secure=req.protocol==='https'||req.headers['x-forwarded-proto']==='https';
 const value=raw?encodeURIComponent(raw):'';
 const attrs=[REFRESH_COOKIE+'='+value,'HttpOnly','SameSite=Lax','Path=/api/auth',secure?'Secure':'',raw?'Max-Age='+REFRESH_DAYS*86400:'Max-Age=0'].filter(Boolean);
 reply.header('Set-Cookie',attrs.join('; '));
}
async function accessToken(userId:string,email:string){
 return new SignJWT({email}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuedAt().setExpirationTime('12h').sign(jwtKey);
}
app.post('/api/login',async(req,reply)=>{
 const {email,password}=parse(z.object({email:z.string().trim().min(3).max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),password:z.string()}),req.body);
 const u=await pool.query('SELECT * FROM users WHERE email=$1',[email.toLowerCase()]);
 if(!u.rowCount || !(await compare(password,u.rows[0].password_hash))) return reply.code(401).send({error:'Неверный логин или пароль'});
 const user=u.rows[0];
 const refresh=randomBytes(32).toString('base64url');
 await pool.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[refreshHash(refresh),user.id]);
 setRefreshCookie(req,reply,refresh);
 return {token:await accessToken(user.id,user.email)};
});
app.post('/api/auth/refresh',async(req,reply)=>{
 const old=cookieValue(req,REFRESH_COOKIE);
 if(!old||!/^[a-zA-Z0-9_-]{30,100}$/.test(old))return reply.code(401).send({error:'Сессия завершена'});
 const fresh=randomBytes(32).toString('base64url');
 const rotated=await pool.query("UPDATE auth_sessions SET token_hash=$2 WHERE token_hash=$1 AND expires_at>now() RETURNING user_id",[refreshHash(old),refreshHash(fresh)]);
 if(!rotated.rowCount){setRefreshCookie(req,reply,null);return reply.code(401).send({error:'Сессия завершена'});}
 const user=(await pool.query('SELECT email FROM users WHERE id=$1',[rotated.rows[0].user_id])).rows[0];
 if(!user){setRefreshCookie(req,reply,null);return reply.code(401).send({error:'Сессия завершена'});}
 setRefreshCookie(req,reply,fresh);
 return {token:await accessToken(rotated.rows[0].user_id,user.email)};
});
app.post('/api/auth/logout',async(req,reply)=>{
 const raw=cookieValue(req,REFRESH_COOKIE);
 if(raw)await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[refreshHash(raw)]);
 setRefreshCookie(req,reply,null);
 return {ok:true};
});
app.addHook('preHandler',async(req,reply)=>{
 if(req.url === '/api/login' || req.url === '/api/health' || req.url.startsWith('/api/auth/') || !req.url.startsWith('/api/')) return;
 try {const raw=req.headers.authorization?.replace(/^Bearer /,'');if(!raw)throw Error('no token');const {payload}=await jwtVerify(raw,jwtKey);(req as any).userId=payload.sub;}
 catch{return reply.code(401).send({error:'Требуется вход'});}
});
const uid=(req:any):string=>req.userId;
async function canAccess(projectId:string,userId:string) {
 const r=await pool.query('SELECT 1 FROM memberships m JOIN projects p ON p.id=m.project_id WHERE m.project_id=$1 AND m.user_id=$2 AND p.deleted_at IS NULL',[projectId,userId]);
 return !!r.rowCount;
}
async function access(req:any,reply:any,projectId:string) {
 if(!await canAccess(projectId,uid(req))){reply.code(403).send({error:'Нет доступа к проекту'});return false;}return true;
}
app.get('/api/health',async()=>({ok:true}));
registerChatImageRoutes(app,{pool,access});
registerDiagnosticRoutes(app,{pool,access});
// Codex uses a personal ChatGPT entitlement. Keep access restricted to the bootstrap administrator.
app.addHook('preHandler',async(req,reply)=>{
 if(!req.url.startsWith('/api/codex/'))return;
 const email=(await pool.query('SELECT email FROM users WHERE id=$1',[(req as any).userId])).rows[0]?.email;
 if(!email || email!==configuredAdminEmail())return reply.code(403).send({error:'Только администратор может подключать Codex'});
});
// Local-only Codex runner. The service is not exposed on a host port.
// Requests reach it only after the ordinary application session check.
const codexUrl=process.env.CODEX_RUNNER_URL||'http://codex:4300';
async function codexCall(path:string,method:'GET'|'POST'='GET') {
 const response=await fetch(codexUrl+path,{method,headers:{'X-Runner-Secret':runnerKey},signal:AbortSignal.timeout(path==='/test'?125000:15000)});
 const body=await response.json().catch(()=>({error:'Некорректный ответ Codex'}));
 if(!response.ok)throw Error(body.error||'Codex недоступен');
 return body;
}
app.get('/api/codex/rate-limits',async(req:any,reply)=>{
 if(!await requireAdmin(req,reply))return;
 const started=Date.now();
 const force=req.query?.refresh==='1';
 try{
  const response=await fetch(codexUrl+'/usage-limits'+(force?'?refresh=1':''),{
   headers:{'X-Runner-Secret':runnerKey},signal:AbortSignal.timeout(25000)
  });
  const body=await response.json().catch(()=>({error:'Codex Runner вернул некорректный JSON'})) as any;
  if(!response.ok){
   const message=String(body.error||'Codex Runner не предоставил лимиты').slice(0,260);
   req.log.warn({status:response.status,duration_ms:Date.now()-started},'Codex rate limits upstream unavailable');
   return reply.code(response.status===409?409:503).send({error:message});
  }
  if(!Array.isArray(body.windows)){
   req.log.warn({duration_ms:Date.now()-started},'Codex rate limits response has no windows array');
   return reply.code(503).send({error:'Codex Runner вернул неожиданный формат лимитов'});
  }
  return body;
 }catch(e){
  const cause=(e as {cause?:{code?:string}})?.cause;
  const reason=e instanceof Error?e.message:'Не удалось получить лимиты Codex';
  const suffix=cause?.code?' ('+cause.code+')':'';
  req.log.warn({error:reason,causeCode:cause?.code||null,duration_ms:Date.now()-started},'Codex rate limits request failed');
  return reply.code(503).send({error:'Нет соединения с Codex Runner: '+reason.slice(0,160)+suffix});
 }
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
if(runnerKey===process.env.JWT_SECRET)throw Error('RUNNER_SHARED_SECRET must differ from JWT_SECRET');
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
 if(u.rows[0]?.email!==configuredAdminEmail()){
  reply.code(403).send({error:'На первом этапе запуск AI разрешён только администратору'});
  return false;
 }
 return true;
}
registerCloudDiagnosticsSettings(app,{pool,requireAdmin});
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
 const runs=await pool.query(`SELECT id,task_id,model,status,branch,pr_url,message,created_at,completed_at,cycle_id
  FROM ai_task_runs WHERE project_id=$1
  UNION ALL
  SELECT q.run_id,q.task_id,COALESCE(s.model,'gpt-6-luna'),'queued',NULL,NULL,q.detail,q.created_at,NULL,NULL
   FROM iteration_execution_queue q LEFT JOIN project_ai_settings s ON s.project_id=q.project_id
   WHERE q.project_id=$1 AND q.status='queued' AND q.run_id IS NOT NULL
  ORDER BY created_at DESC LIMIT 30`,[id]);
 return runs.rows;
});
app.post('/api/projects/:id/tasks/:taskId/run-ai',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const {approveAnalysis,iterationApproval}=z.object({approveAnalysis:z.boolean().default(false),
  iterationApproval:z.object({id:z.string().uuid(),revision:z.number().int().positive()}).optional()}).parse(req.body||{});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const scope=iterationApproval
   ?{iterationId:iterationApproval.id,revision:iterationApproval.revision,taskIds:[taskId]}
   :{taskId,approveAnalysis};
  const {tasks:[intent]}=await enqueueDevelopment(client,id,uid(req),scope);
  const ai=await resolveRoleAiSettings(client,id,'development');
  await client.query('COMMIT');
  return reply.code(202).send({id:intent.run_id,task_id:taskId,status:'queued',
   message:'Запуск принят. Подробности ожидания — в Центре процессов.',model:ai.model,created_at:intent.created_at});
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
});
// One project-scoped source for QA activity in Kanban, task chat and Process Center.
app.get('/api/projects/:id/test-runs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const result=await pool.query(
  'SELECT id,task_id,cycle_id,attempt,status,message,verdict,report,created_at,completed_at FROM ai_test_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 150',
  [id]);
 return result.rows;
});
// Recovery of a completed QA result when a historical Temporal workflow ended
// between persisting the verdict and advancing the task. Never invent a test pass.
app.post('/api/projects/:id/tasks/:taskId/apply-qa-result',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const task=await pool.query("SELECT t.id,t.stage,t.pr_number,t.spec_version,t.spec_reviewed_version,t.spec_review_status,t.spec_reviewed_commit,g.repository,c.secret_encrypted FROM tasks t JOIN project_git_repositories g ON g.project_id=t.project_id JOIN connections c ON c.id=g.connection_id AND c.owner_id=$3 WHERE t.id=$1 AND t.project_id=$2",
  [taskId,id,uid(req)]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача или GitHub-подключение не найдены'});
 if(task.rows[0].stage!=='testing')return reply.code(409).send({error:'Задача уже вышла из этапа тестирования'});
 if(await pendingAgentQuestions(pool,id,taskId))return reply.code(409).send({error:'Сначала ответь на вопросы агентов по задаче'});
 const [owner,active,latest]=await Promise.all([
  pool.query("SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND project_id=$2 AND state='active'",[taskId,id]),
  pool.query("SELECT 1 FROM ai_test_runs WHERE task_id=$1 AND project_id=$2 AND status IN ('running','queued')",[taskId,id]),
  pool.query('SELECT id,verdict,status,qa_spec_version,report,qa_plan_snapshot FROM ai_test_runs WHERE task_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[taskId,id])
 ]);
 if(owner.rowCount||active.rowCount)return reply.code(409).send({error:'AI-цикл ещё выполняется. Итог будет применён самим процессом.'});
 const test=latest.rows[0], t=task.rows[0];
 if(!test||test.status!=='completed'||!['passed','failed'].includes(test.verdict))
  return reply.code(409).send({error:'Нет завершённого подтверждённого QA-результата. Повтори тестирование или рассмотри непроверенные сценарии.'});
 const findings=Array.isArray(test.report?.findings)?test.report.findings:[];
 const checks=Array.isArray(test.report?.checks)?test.report.checks:[];
 const cases=Array.isArray(test.report?.caseResults)?test.report.caseResults:[];
 const failed=cases.some((c:any)=>c.result==='failed')||checks.some((c:any)=>c.result==='failed')||findings.length>0;
 if(test.verdict==='passed'){
  if(t.spec_review_status!=='current'||t.spec_version!==t.spec_reviewed_version||t.spec_version!==test.qa_spec_version)
   return reply.code(409).send({error:'Результат QA относится к устаревшему ТЗ'});
  const snapshot=Array.isArray(test.qa_plan_snapshot?.cases)?test.qa_plan_snapshot.cases:[];
  const tested=new Map(cases.map((c:any)=>[c.case_id,c]));
  if(!snapshot.length||failed||!checks.length||checks.some((c:any)=>c.result!=='passed')||snapshot.some((c:any)=>!tested.has(c.id)||(tested.get(c.id) as any)?.result!=='passed'))
   return reply.code(409).send({error:'Отчёт не подтверждает успешное прохождение всех обязательных проверок'});
  if(!t.pr_number)return reply.code(409).send({error:'У задачи нет PR для проверки'});
  const gh=await fetch('https://api.github.com/repos/'+t.repository+'/pulls/'+t.pr_number,{
   headers:{Authorization:'Bearer '+decryptToken(t.secret_encrypted),Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
   signal:AbortSignal.timeout(15000)
  });
  if(!gh.ok)return reply.code(502).send({error:'Не удалось сверить текущий PR с QA-результатом: GitHub HTTP '+gh.status});
  const pr=await gh.json() as any;
  if(pr.state!=='open'||pr.head?.sha!==test.report?.commit||pr.head?.sha!==t.spec_reviewed_commit)
   return reply.code(409).send({error:'SHA PR изменился или аналитик проверял другую версию. Нужен повторный QA.'});
 }else if(!failed){
  return reply.code(409).send({error:'Для возврата разработчику нужны воспроизводимые дефекты или проваленные проверки; сбой QA-исполнителя не является дефектом.'});
 }
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const locked=await client.query("SELECT stage,spec_version,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE",[taskId,id]);
  const still=await client.query('SELECT id,status,verdict FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[id,taskId]);
  const running=await client.query("SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND state='active'",[taskId]);
  if(!locked.rowCount||locked.rows[0].stage!=='testing'||locked.rows[0].spec_version!==t.spec_version||locked.rows[0].spec_review_status!==t.spec_review_status||still.rows[0]?.id!==test.id||running.rowCount){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Состояние задачи изменилось. Обнови историю и повтори действие.'});
  }
  const passed=test.verdict==='passed';
  await client.query("UPDATE tasks SET stage=$3,test_feedback=$4,updated_at=now() WHERE id=$1 AND project_id=$2",
   [taskId,id,passed?'merge_queue':'development',passed?'':JSON.stringify(test.report).slice(0,9000)]);
  await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
   [randomUUID(),taskId,uid(req),passed?'tests_passed':'tests_failed',passed?'Результат QA подтверждён: PR готов к слиянию':'Подтверждённые дефекты переданы разработчику. '+String(test.report?.summary||'').slice(0,1500)]);
  await client.query('COMMIT');
  return {ok:true,stage:passed?'merge_queue':'development',message:passed?'Тесты подтверждены, PR ожидает слияния':'Дефекты переданы разработчику'};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/projects/:id/tasks/:taskId/start-testing',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const task=await pool.query('SELECT stage,pr_url,git_branch,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 if(await pendingAgentQuestions(pool,id,taskId))return reply.code(409).send({error:'Сначала ответь на вопросы агентов'});
 if(!['testing','merge_queue'].includes(task.rows[0].stage)||!task.rows[0].pr_url||!task.rows[0].git_branch)
  return reply.code(409).send({error:'Сначала заверши разработку и создай PR'});
 // A stale DB lock must not hide a finished QA run or prevent an explicit retry.
 // Verify actual Temporal state before reconciling ownership. Never start a second
 // worker when the first workflow (or Codex job) is still genuinely running.
 const temporalClient=await temporal();
 const owner=await pool.query("SELECT owner_id,workflow_id,started_at FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[id,taskId]);
 if(owner.rowCount){
  const row=owner.rows[0];
  try{
   const run=await temporalClient.workflow.getHandle(row.workflow_id).describe();
   if(run.status.name==='RUNNING')return reply.code(409).send({error:'Автоматический процесс для задачи всё ещё выполняется. Проверь его в Центре процессов.'});
   await releaseTaskOrchestration(pool,id,taskId,row.owner_id);
  }catch(error){
   const e=error as {code?:number;name?:string;message?:string};
   const notFound=e.code===5||String(e.name||'').includes('NotFound')||String(e.message||'').includes('not found');
   if(!notFound)return reply.code(503).send({error:'Не удалось проверить статус Temporal: '+String(e.message||error).slice(0,250)});
   if(Date.now()-new Date(row.started_at).getTime()<120000)
    return reply.code(409).send({error:'Процесс запускается. Повторный тестировщик не нужен.'});
   await releaseTaskOrchestration(pool,id,taskId,row.owner_id);
  }
 }
 const legacy=await pool.query("SELECT id FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND id=cycle_id ORDER BY created_at DESC LIMIT 15",[id,taskId]);
 for(const old of legacy.rows){
  try{
   const workflow=await temporalClient.workflow.getHandle('task-cycle-'+old.id).describe();
   if(workflow.status.name==='RUNNING')return reply.code(409).send({error:'Автоматический цикл ещё выполняется. Повторное тестирование пока недоступно.'});
  }catch(error){
   const e=error as {code?:number;name?:string;message?:string};
   if(e.code!==5&&!String(e.name||'').includes('NotFound')&&!String(e.message||'').includes('not found'))
    return reply.code(503).send({error:'Не удалось проверить исторический Temporal-процесс: '+String(e.message||error).slice(0,250)});
  }
 }
 const stale=await pool.query("SELECT id,status FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 8",[id,taskId]);
 for(const test of stale.rows){
  let remoteStatus='missing';
  try{
   const response=await fetch(codexUrl+'/jobs/'+test.id,{headers:{'X-Runner-Secret':runnerKey},signal:AbortSignal.timeout(12000)});
   if(response.status===404)remoteStatus='missing';
   else if(!response.ok)return reply.code(503).send({error:'QA-исполнитель недоступен: HTTP '+response.status});
   else remoteStatus=String((await response.json() as any).status||'unknown');
  }catch(error){return reply.code(503).send({error:'Не удалось достоверно проверить старый QA-запуск: '+String(error).slice(0,190)});}
  if(['queued','running','unknown'].includes(remoteStatus))
   return reply.code(409).send({error:'Предыдущий тестировщик ещё работает. Не запускай второго исполнителя.'});
  if(remoteStatus==='completed'){
   // Persist the actual previous QA report before starting a new attempt.
   try{await (await import('./temporal-activities.js')).checkTesting({projectId:id,taskId,testId:test.id});}
   catch(error){return reply.code(503).send({error:'Не удалось восстановить завершённый QA-отчёт: '+String(error).slice(0,220)});}
   continue;
  }
  await pool.query("UPDATE ai_test_runs SET status='failed',message='Предыдущий QA-процесс завершён или потерян. Можно выполнить новый запуск.',completed_at=now() WHERE id=$1 AND status IN ('running','queued')",[test.id]);
  await pool.query('INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)',[randomUUID(),taskId,'qa_retry_recovered','Предыдущий QA-процесс отсутствует или завершился с ошибкой. Запуск разблокирован.']);
 }
 const cycleId=randomUUID();
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const locked=(await db.query('SELECT stage,pr_url,git_branch,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id])).rows[0];
  if(!locked||!['testing','merge_queue'].includes(locked.stage)||!locked.pr_url||!locked.git_branch||
   await pendingAgentQuestions(db,id,taskId)){
   await db.query('ROLLBACK');
   return reply.code(409).send({error:'Условия повторной проверки изменились. Обновите карточку задачи.'});
  }
  if(!await acquireTaskOrchestration(db,id,taskId,cycleId,'manual-test-'+cycleId,'testing')){
   await db.query('ROLLBACK');
   return reply.code(409).send({error:'Для задачи уже идёт аналитика, формирование QA-плана или тестирование'});
  }
  if(locked.stage==='merge_queue'){
   await db.query("UPDATE tasks SET stage='testing',updated_at=now() WHERE project_id=$1 AND id=$2",[id,taskId]);
   await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'stage_changed','Повторное тестирование перед слиянием')",
    [randomUUID(),taskId,uid(req)]);
  }
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
 try{
  await temporalClient.workflow.start('manualTesting',{
   taskQueue:'agent-pipeline',workflowId:'manual-test-'+cycleId,
   args:[{projectId:id,taskId,cycleId}]
  });
 }catch(error){
  await releaseTaskOrchestration(pool,id,taskId,cycleId);
  return reply.code(503).send({error:'Temporal недоступен: '+(error as Error).message});
 }
 return reply.code(202).send({cycle_id:cycleId,status:'queued',message:'QA-цикл запущен; повторный запуск заблокирован до завершения'});
});
app.get('/api/projects/:id/ai-runs/:runId',async(req:any,reply)=>{
 const {id,runId}=parse(z.object({id:z.string().uuid(),runId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const run=await pool.query('SELECT id,task_id,model,status,branch,pr_url,message,created_at,completed_at,cycle_id FROM ai_task_runs WHERE id=$1 AND project_id=$2',[runId,id]);
 if(!run.rowCount){
  const intent=(await pool.query(`SELECT q.run_id AS id,q.task_id,q.status,q.created_at,q.detail AS message,
   COALESCE(s.model,'gpt-6-luna') AS model FROM iteration_execution_queue q
   LEFT JOIN project_ai_settings s ON s.project_id=q.project_id WHERE q.project_id=$1 AND q.run_id=$2`,[id,runId])).rows[0];
  if(!intent)return reply.code(404).send({error:'Запуск не найден'});
  return {...intent,status:intent.status==='stale'?'failed':intent.status==='dispatched'?'completed':intent.status,
   message:intent.message||'Ожидает диспетчера разработки'};
 }
 const current=run.rows[0];
 if(current.cycle_id)return current; // Temporal worker is the single owner of lifecycle transitions.
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
    await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,level,stage,detail) VALUES($1,$2,$3,'development',$4,$5,$6)",
     [randomUUID(),id,runId,remote.status==='failed'?'error':'info',remote.status||'running',phase]).catch(()=>{});
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
     await pool.query("UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$6,updated_at=now() WHERE id=$1 AND project_id=$5",[current.task_id,remote.branch,remote.prUrl,prMatch?Number(prMatch[1]):null,id,remote.baseBranch||null]);
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



const {mergeTaskPr}=createMergeService(pool,decryptToken);
app.post('/api/projects/:id/tasks/:taskId/merge',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 try{return await mergeTaskPr(id,taskId,uid(req));}
 catch(e){const err=e as Error&{statusCode?:number};return reply.code(err.statusCode||502).send({error:err.message});}
});

function developmentProcessDetail(message:string){
 return message.replace('Codex изменяет код','Изменяет код').replace('Codex не создал файлы.','Файлы не изменились.');
}

type BackgroundProcess={id:string;kind:'development'|'document_import'|'merge'|'testing'|'analysis';role:'development'|'testing'|'analysis'|'analyst'|'platform';projectId:string;projectName:string;taskId?:string;title:string;detail:string;status:'queued'|'running';createdAt:string;url:string};
app.get('/api/background-processes',async(req:any)=>{
 const userId=uid(req);
 const [developments,imports,tests,merges,analyses,iterationRuns,taskAnalyses]=await Promise.all([
  pool.query(`SELECT a.id,a.project_id,p.name AS project_name,a.task_id,t.title AS task_title,t.display_number,a.status,a.message,a.created_at,a.cycle_id
    FROM ai_task_runs a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.project_id=a.project_id AND m.user_id=$1
    JOIN tasks t ON t.id=a.task_id
    WHERE a.status IN ('queued','running')
    ORDER BY a.created_at DESC LIMIT 50`,[userId]),
  pool.query(`SELECT j.id,j.project_id,p.name AS project_name,j.status,j.message,j.created_at
    FROM document_import_jobs j JOIN projects p ON p.id=j.project_id
    JOIN memberships m ON m.project_id=j.project_id AND m.user_id=$1
    WHERE j.status IN ('queued','running') ORDER BY j.created_at DESC LIMIT 50`,[userId]),
  pool.query("SELECT t.id,t.project_id,t.task_id,t.status,t.message,t.created_at,p.name AS project_name FROM ai_test_runs t JOIN projects p ON p.id=t.project_id JOIN memberships m ON m.project_id=p.id AND m.user_id=$1 WHERE t.status IN ('queued','running') ORDER BY t.created_at DESC LIMIT 50",[userId]),
  pool.query("SELECT j.id,j.project_id,j.status,j.message,j.created_at,p.name AS project_name FROM merge_process_runs j JOIN projects p ON p.id=j.project_id JOIN memberships m ON m.project_id=p.id AND m.user_id=$1 WHERE j.status IN ('queued','running') ORDER BY j.created_at DESC LIMIT 50",[userId]),
  pool.query(`SELECT r.id,r.project_id,r.task_id,r.status,r.message,r.created_at,t.title,p.name AS project_name,phase.stage
   FROM requirement_review_runs r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=r.project_id
   JOIN memberships m ON m.project_id=r.project_id AND m.user_id=$1
   LEFT JOIN LATERAL (SELECT e.stage FROM process_events e WHERE e.project_id=r.project_id AND e.process_id=r.id
    AND e.stage IN ('review_started','test_design_started') ORDER BY e.created_at DESC,e.id DESC LIMIT 1) phase ON true
   WHERE r.status IN ('queued','running') ORDER BY r.created_at DESC LIMIT 50`,[userId]),
  pool.query(`SELECT r.id,r.status,r.message,r.created_at,i.id AS iteration_id,i.project_id,i.title,p.name AS project_name
   FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id JOIN projects p ON p.id=i.project_id
   JOIN memberships m ON m.project_id=i.project_id AND m.user_id=$1
   WHERE r.status IN ('queued','running') ORDER BY r.created_at DESC LIMIT 50`,[userId]),
  pool.query(`SELECT a.id,a.project_id,p.name AS project_name,a.task_id,t.display_number,t.title,a.status,a.message,a.created_at
   FROM agent_analysis_runs a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.project_id=a.project_id AND m.user_id=$1
   JOIN tasks t ON t.id=a.task_id WHERE a.status IN ('queued','running') ORDER BY a.created_at DESC LIMIT 50`,[userId])
 ]);
 const processes:BackgroundProcess[]=[];
 for(const row of developments.rows){
  let status:string=row.status,detail:string=developmentProcessDetail(row.message||'Работа над задачей');
  if(row.cycle_id){
   processes.push({id:'development:'+row.id,kind:'development',role:'development',projectId:row.project_id,projectName:row.project_name,
    taskId:row.task_id,title:'Разработка #'+row.display_number+' · '+row.task_title,
    detail,status:status==='queued'?'queued':'running',createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
   continue; // Temporal owns reconciliation; do not bypass tests and move to merge queue.
  }

  // Reconcile the actual runner state: DB status alone may remain stale if the
  // user closes the task page while a development run completes.
  try{
   const remote=await agentCall('/jobs/'+row.id);
   status=String(remote.status||status);
   detail=developmentProcessDetail(String(remote.message||detail)).slice(0,250);
   if(['completed','failed'].includes(status)){
    await pool.query("UPDATE ai_task_runs SET status=$2,message=$3,branch=COALESCE($4,branch),pr_url=COALESCE($5,pr_url),completed_at=now() WHERE id=$1 AND status IN ('running','queued')",
     [row.id,status,detail,remote.branch||null,remote.prUrl||null]).catch(()=>{});
    if(status==='completed'&&remote.prUrl){
     const match=/\/pull\/(\d+)$/.exec(remote.prUrl);
     await pool.query("UPDATE tasks SET stage='testing',git_branch=$2,pr_url=$3,pr_number=$4,pr_base_branch=$6,updated_at=now() WHERE id=$1 AND project_id=$5",
      [row.task_id,remote.branch||null,remote.prUrl,match?Number(match[1]):null,row.project_id,remote.baseBranch||null]).catch(()=>{});
    }
    if(remote.usage){
     const u=remote.usage;
     await pool.query("INSERT INTO ai_token_usage(id,project_id,task_id,source_id,operation,model,input_tokens,cached_input_tokens,output_tokens) SELECT $1,$2,$3,$4,'development',a.model,$5,$6,$7 FROM ai_task_runs a WHERE a.id=$4 ON CONFLICT(source_id) DO NOTHING",
      [randomUUID(),row.project_id,row.task_id,row.id,Math.max(0,Number(u.input_tokens)||0),Math.max(0,Number(u.cached_input_tokens)||0),Math.max(0,Number(u.output_tokens)||0)]).catch(()=>{});
    }
    await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,level,stage,detail) VALUES($1,$2,$3,'development',$4,$5,$6)",
     [randomUUID(),row.project_id,row.id,status==='failed'?'error':'info',status,detail]).catch(()=>{});
    continue;
   }
  }catch(error){
   const text=error instanceof Error?error.message:String(error);
   if(text.includes('Задача не найдена'))continue;
   detail='Связь с исполнителем временно недоступна · '+detail;
  }
  if(status!=='queued'&&status!=='running')continue;
  if(status!==row.status||detail!==row.message){
   await pool.query('UPDATE ai_task_runs SET status=$2,message=$3 WHERE id=$1',[row.id,status,detail]).catch(()=>{});
   await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'development',$4,$5)",
    [randomUUID(),row.project_id,row.id,status,detail]).catch(()=>{});
  }
  processes.push({id:'development:'+row.id,kind:'development',role:'development',projectId:row.project_id,projectName:row.project_name,
   taskId:row.task_id,title:'Разработка #'+row.display_number+' · '+row.task_title,
   detail,status,createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of imports.rows){
  processes.push({id:'import:'+row.id,kind:'document_import',role:'analyst',projectId:row.project_id,projectName:row.project_name,
   title:'Импорт документации',detail:String(row.message||'Обработка Markdown-документов').slice(0,250),
   status:row.status,createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of tests.rows){
  processes.push({id:'test:'+row.id,kind:'testing',role:'testing',taskId:row.task_id,projectId:row.project_id,projectName:row.project_name,
   title:'AI-тестирование',detail:row.message||'Проверка задачи',status:row.status,
   createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of analyses.rows){
  const preparingTests=row.stage==='test_design_started';
  processes.push({id:'analysis:'+row.id,kind:preparingTests?'testing':'analysis',role:preparingTests?'testing':'analysis',projectId:row.project_id,projectName:row.project_name,
   taskId:row.task_id,title:(preparingTests?'Подготовка тест-плана · ':'Сверка требований · ')+row.title,detail:row.message||'Проверка задачи',status:row.status,createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of taskAnalyses.rows){
  processes.push({id:'task-analysis:'+row.id,kind:'analysis',role:'analysis',projectId:row.project_id,projectName:row.project_name,
   taskId:row.task_id,title:'Анализ #'+row.display_number+' · '+row.title,detail:row.message||'Подготовка требований к разработке',
   status:row.status,createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 for(const row of iterationRuns.rows){
  processes.push({id:'iteration-plan:'+row.id,kind:'analysis',role:'analysis',projectId:row.project_id,projectName:row.project_name,
   title:'План задач · '+row.title,detail:row.message,status:row.status,createdAt:row.created_at,
   url:'/projects/'+row.project_id+'/docs/plan/'+row.iteration_id});
 }
 for(const row of merges.rows){
  processes.push({id:'merge:'+row.id,kind:'merge',role:'platform',projectId:row.project_id,projectName:row.project_name,
   title:'Последовательное слияние PR',detail:row.message||'Обработка PR',status:row.status==='queued'?'queued':'running',
   createdAt:row.created_at,url:'/projects/'+row.project_id+'/processes?process='+row.id});
 }
 processes.sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime());
 return {count:processes.length,processes,checkedAt:new Date().toISOString()};
});

async function startMergeBatch(batchId:string){
 const client=await temporal();
 await client.withDeadline(Date.now()+5000,()=>client.workflow.start('mergeReadyBatch',{
  workflowId:'merge-ready-'+batchId,workflowIdReusePolicy:'REJECT_DUPLICATE',taskQueue:'agent-pipeline',args:[batchId]
 }));
}
app.post('/api/projects/:id/merge-ready',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const batch=await createMergeBatch(pool,id,uid(req));
 return reply.code(202).send(batch);
});
app.get('/api/projects/:id/merge-ready/:batchId',async(req:any,reply)=>{
 const {id,batchId}=parse(z.object({id:z.string().uuid(),batchId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const batch=await readMergeBatch(pool,id,batchId);
 return batch??reply.code(404).send({error:'Очередь слияния не найдена'});
});

app.get('/api/me',async(req)=>{const r=await pool.query('SELECT id,email FROM users WHERE id=$1',[uid(req)]);return r.rows[0];});
app.get('/api/projects',async(req)=>{
 const r=await pool.query('SELECT p.id,p.name,p.description,p.created_at,(p.owner_id=$1) AS is_owner FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC',[uid(req)]);
 return r.rows;
});
app.get('/api/projects/trash',async(req)=>{
 const r=await pool.query('SELECT id,name,description,deleted_at FROM projects WHERE owner_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',[uid(req)]);
 return r.rows;
});
app.post('/api/projects/:id/trash',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const result=await client.query('SELECT id,name,owner_id,deleted_at FROM projects WHERE id=$1 FOR UPDATE',[id]);
  const project=result.rows[0];
  if(!project||project.owner_id!==uid(req)){await client.query('ROLLBACK');return reply.code(404).send({error:'Проект не найден или не принадлежит вам'});}
  if(project.deleted_at){await client.query('ROLLBACK');return reply.code(409).send({error:'Проект уже находится в корзине'});}
  if(await findActiveProjectOperation(client,id)){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'В проекте есть незавершённые процессы. Завершите или отмените их перед переносом в корзину.'});
  }
  const moved=await client.query('UPDATE projects SET deleted_at=now() WHERE id=$1 RETURNING id,name,deleted_at',[id]);
  await client.query('COMMIT');return moved.rows[0];
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.post('/api/projects/:id/restore',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 const restored=await pool.query('UPDATE projects SET deleted_at=NULL WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL RETURNING id,name,description',[id,uid(req)]);
 if(!restored.rowCount)return reply.code(404).send({error:'Проект не найден в корзине'});
 return restored.rows[0];
});
app.delete('/api/projects/:id/permanent',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 const {confirmation}=parse(z.object({confirmation:z.string().max(120)}),req.body||{});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const found=await client.query('SELECT id,name,owner_id,deleted_at FROM projects WHERE id=$1 FOR UPDATE',[id]);
  const project=found.rows[0];
  if(!project||project.owner_id!==uid(req)||!project.deleted_at){
   await client.query('ROLLBACK');return reply.code(404).send({error:'Проект отсутствует в корзине'});
  }
  if(!projectDeletionConfirmation(project.name,confirmation)){
   await client.query('ROLLBACK');return reply.code(400).send({error:'Для окончательного удаления введите точное название проекта'});
  }
  if(await findActiveProjectOperation(client,id)){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'Найдены незавершённые процессы. Удаление остановлено без потери данных.'});
  }
  const connections=await client.query('SELECT connection_id AS id FROM project_connections WHERE project_id=$1 UNION SELECT connection_id AS id FROM project_git_repositories WHERE project_id=$1',[id]);
  // Database FK cascades remove all scoped records atomically. No GitHub API calls are made.
  await client.query('DELETE FROM projects WHERE id=$1',[id]);
  const connectionIds=connections.rows.map((x:any)=>x.id);
  if(connectionIds.length){
   await client.query(`DELETE FROM connections c WHERE c.id=ANY($1::uuid[]) AND c.owner_id=$2
     AND NOT EXISTS(SELECT 1 FROM project_connections pc WHERE pc.connection_id=c.id)
     AND NOT EXISTS(SELECT 1 FROM project_git_repositories gr WHERE gr.connection_id=c.id)`,[connectionIds,uid(req)]);
  }
  await client.query('COMMIT');
  return {deleted:true,project_id:id,github_untouched:true};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.post('/api/projects',async(req,reply)=>{
 const {name,description}=parse(z.object({name:z.string().trim().min(1).max(120),description:z.string().max(5000).default('')}),req.body);
 const id=randomUUID(),client=await pool.connect();
 try{await client.query('BEGIN');
 await client.query('INSERT INTO projects(id,name,description,owner_id) VALUES($1,$2,$3,$4)',[id,name,description,uid(req)]);
 await client.query('INSERT INTO memberships(project_id,user_id,role) VALUES($1,$2,$3)',[id,uid(req),'admin']);
 for(let i=0;i<workflowDefaults.length;i++){const [stage,label,mode]=workflowDefaults[i];const agent=workflowAgentDefaults[stage];await client.query('INSERT INTO workflow_stages(project_id,stage,label,mode,position,agent_name,agent_instructions,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,stage,label,mode,i,agent?.name??'',agent?.instructions??'',workflowStageDescriptions[stage]??'']);}
 await client.query("INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions) VALUES($1,'devops','AI-DevOps',$2) ON CONFLICT DO NOTHING",[id,agentInstructions.devops]);
 await client.query(`INSERT INTO project_conversation_agents(project_id,role,agent_name,agent_instructions)
  VALUES($1,'manager','Менеджер проекта',$2),($1,'analyst','Бизнес-аналитик',$3)
  ON CONFLICT(project_id,role) DO NOTHING`,[id,agentInstructions.manager,agentInstructions.analyst]);
 await client.query('INSERT INTO project_deployment_settings(project_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
 await client.query('COMMIT');return reply.code(201).send({id,name,description});}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.get('/api/projects/:id',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;const r=await pool.query('SELECT * FROM projects WHERE id=$1',[id]);return r.rows[0];});
app.get('/api/projects/:id/specialist-agents/devops',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const r=await pool.query("SELECT role,agent_name,agent_instructions,updated_at FROM project_specialist_agents WHERE project_id=$1 AND role='devops'",[id]);
 return r.rows[0]||reply.code(404).send({error:'DevOps-агент не настроен'});
});
app.put('/api/projects/:id/specialist-agents/devops',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const p=parse(z.object({agent_name:z.string().trim().min(1).max(120),agent_instructions:z.string().trim().min(1).max(12000)}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const r=await client.query("INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions) VALUES($1,'devops',$2,$3) ON CONFLICT(project_id,role) DO UPDATE SET agent_name=EXCLUDED.agent_name,agent_instructions=EXCLUDED.agent_instructions,updated_at=now() RETURNING role,agent_name,agent_instructions,updated_at",[id,p.agent_name,p.agent_instructions]);
  await client.query("UPDATE workflow_stages SET agent_name=$2,agent_instructions=$3 WHERE project_id=$1 AND stage='deployment'",[id,p.agent_name,p.agent_instructions]);
  await client.query('COMMIT');
  return r.rows[0];
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.get('/api/projects/:id/deployment/settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 return (await pool.query("SELECT mode,health_url,environment,updated_at FROM project_deployment_settings WHERE project_id=$1",[id])).rows[0]||{mode:'skip'};
});
app.put('/api/projects/:id/deployment/settings',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {mode,health_url,environment}=parse(z.object({
  mode:z.enum(['skip','manual','automatic']),
  health_url:z.string().max(300).default(''),
  environment:z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).default('production')
 }),req.body);
 if(mode==='automatic'&&!health_url)return reply.code(400).send({error:'Настрой HTTPS URL проверки окружения'});
 if(health_url)validateHealthUrl(health_url);
 const updated=await pool.query("INSERT INTO project_deployment_settings(project_id,mode,health_url,environment) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET mode=$2,health_url=$3,environment=$4,updated_at=now() RETURNING mode,health_url,environment,updated_at",[id,mode,health_url,environment]);
 return updated.rows[0];
});
app.post('/api/projects/:id/tasks/:taskId/deployment/resolve',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {outcome,reason}=parse(z.object({outcome:z.enum(['skipped','manual_confirmed']),reason:z.string().trim().min(5).max(1500)}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const task=await client.query("SELECT stage FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE",[id,taskId]);
  if(!task.rowCount||task.rows[0].stage!=='deployment'){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Задача не находится на этапе выкладки'});
  }
  const record=await client.query("UPDATE task_deployment_records SET status=$3,reason=$4,actor_id=$5,updated_at=now() WHERE project_id=$1 AND task_id=$2 AND status='pending' RETURNING task_id",[id,taskId,outcome,reason,uid(req)]);
  if(!record.rowCount)throw Object.assign(new Error('Не найдена ожидающая выкладка для этой задачи'),{statusCode:409});
  await client.query("UPDATE tasks SET stage='documentation',updated_at=now() WHERE project_id=$1 AND id=$2",[id,taskId]);
  await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)",[randomUUID(),taskId,uid(req),outcome==='skipped'?'deployment_skipped':'deployment_manual_confirmed',reason]);
  await client.query('COMMIT');
  return {stage:'documentation',deployment_status:outcome};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.get('/api/projects/:id/workflow',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return (await pool.query('SELECT stage,label,mode,position,agent_name,agent_instructions,description FROM workflow_stages WHERE project_id=$1 ORDER BY position',[id])).rows.map(stage=>({...stage,responsibility:workflowResponsibility(stage.stage)}));});
app.patch('/api/projects/:id/workflow/:stage',async(req:any,reply)=>{
 const {id,stage}=parse(z.object({id:z.string().uuid(),stage:validStages}),req.params);
 if(!await access(req,reply,id))return;
 if(!await requireAdmin(req,reply))return;
 const {mode,agent_name,agent_instructions,description}=parse(z.object({
  description:z.string().trim().max(320).optional(),
  mode:validMode.optional(),
  agent_name:z.string().trim().min(1).max(100).optional(),
  agent_instructions:z.string().max(12000).optional()
 }).refine(v=>Object.keys(v).length>0,'Укажи настройку для изменения'),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const updated=await client.query(
   'UPDATE workflow_stages SET mode=COALESCE($1,mode),agent_name=COALESCE($2,agent_name),agent_instructions=COALESCE($3,agent_instructions),description=COALESCE($4,description) WHERE project_id=$5 AND stage=$6 RETURNING stage,label,mode,position,agent_name,agent_instructions,description',
   [mode??null,agent_name??null,agent_instructions??null,description??null,id,stage]);
  if(!updated.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Этап не найден'});}
  if(stage==='deployment'&&(agent_name!==undefined||agent_instructions!==undefined)){
   const current=updated.rows[0];
   await client.query("INSERT INTO project_specialist_agents(project_id,role,agent_name,agent_instructions) VALUES($1,'devops',$2,$3) ON CONFLICT(project_id,role) DO UPDATE SET agent_name=EXCLUDED.agent_name,agent_instructions=EXCLUDED.agent_instructions,updated_at=now()",
    [id,current.agent_name,current.agent_instructions]);
  }
  await client.query('COMMIT');
  return updated.rows[0];
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.get('/api/projects/:id/tasks',async(req:any,reply)=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;return tasksWithCustomerQuestions(pool,id);});
app.post('/api/projects/:id/tasks',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(300),description:z.string().max(20000).default(''),type:z.enum(['task','bug','improvement','epic','question']).default('task'),parent_id:z.string().uuid().nullable().optional(),document_id:z.string().uuid().nullable().optional()}),req.body);
 if(data.parent_id){const p=await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2',[data.parent_id,id]);if(!p.rowCount)return reply.code(400).send({error:'Родительская задача не найдена'});}
 if(data.type==='question'){
  if(!data.document_id||data.parent_id)return reply.code(400).send({error:'Вопрос к ПО должен быть связан с документом и не иметь родительской задачи'});
  const doc=await pool.query('SELECT 1 FROM documents WHERE project_id=$1 AND id=$2',[id,data.document_id]);
  if(!doc.rowCount)return reply.code(404).send({error:'Документ для вопроса не найден'});
 }else if(data.document_id)return reply.code(400).send({error:'Привязка к документу предусмотрена только для вопросов к ПО'});
 const taskId=randomUUID();
 if(data.type==='question'){
  await pool.query("INSERT INTO tasks(id,project_id,title,description,type,stage,position,document_id,question_key,question_topic,question_status) VALUES($1,$2,$3,$4,'question','backlog',(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2),$5,$6,'manual','open')",
   [taskId,id,data.title,data.description||data.title,data.document_id,taskId]);
 }else{
  await pool.query('INSERT INTO tasks(id,project_id,title,description,type,parent_id,position) VALUES($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(position)+1,0) FROM tasks WHERE project_id=$2))',[taskId,id,data.title,data.description,data.type,data.parent_id||null]);
 }
 await pool.query('INSERT INTO task_events(id,task_id,actor_id,event) VALUES($1,$2,$3,$4)',[randomUUID(),taskId,uid(req),'created']);
 return reply.code(201).send({id:taskId});
});
async function updateDependency(projectId:string,taskId:string,parentId:string|null,actorId:string){
 if(parentId===taskId)throw Object.assign(new Error('Задача не может зависеть от самой себя'),{statusCode:409});
 const task=await pool.query('SELECT id,stage,git_branch FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]);
 if(!task.rowCount)throw Object.assign(new Error('Задача не найдена'),{statusCode:404});
 if(['merge_queue','deployment','documentation','done'].includes(task.rows[0].stage)||task.rows[0].git_branch)
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
/** Manual task edits are spec changes; they invalidate QA and trigger analyst review. */
async function startRequirementsReview(projectId:string,taskId:string,version:number){
 const running=await pool.query("SELECT id FROM requirement_review_runs WHERE project_id=$1 AND task_id=$2 AND spec_version=$3 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",[projectId,taskId,version]);
 if(running.rowCount)return {started:true,runId:running.rows[0].id,message:'Проверка требований уже выполняется'};
 const enabled=await pool.query('SELECT enabled FROM project_ai_settings WHERE project_id=$1',[projectId]);
 if(!enabled.rows[0]?.enabled)return {started:false,message:'AI отключён; проверка требований ожидает включения'};
 const active=await pool.query("SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running') AND cycle_id IS NOT NULL LIMIT 1",[projectId,taskId]);
 if(active.rowCount)return {started:false,message:'Актуализацию требований выполнит аналитик в активном цикле разработки'};
 const runId=randomUUID();
 await pool.query("INSERT INTO requirement_review_runs(id,project_id,task_id,spec_version,status,message) VALUES($1,$2,$3,$4,'queued','Ожидает проверки аналитиком')",[runId,projectId,taskId,version]);
 try{
  const client=await temporal();
  await client.workflow.start('requirementsReview',{taskQueue:'agent-pipeline',workflowId:'requirements-'+taskId+'-v'+version+'-'+runId,args:[{projectId,taskId,runId}]});
  return {started:true,runId,message:'AI-аналитик проверяет изменение требований'};
 }catch(e){
  await pool.query("UPDATE requirement_review_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1",[runId,'Не удалось запустить Temporal: '+String(e).slice(0,500)]);
  return {started:false,runId,message:'Не удалось запустить проверку требований; повтори её вручную'};
 }
}
app.get('/api/projects/:id/tasks/:taskId/requirements',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const task=await pool.query('SELECT id,title,description,spec_version,spec_reviewed_version,spec_review_status,spec_reviewed_commit,spec_review_note FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 const [reviews,versions,runs]=await Promise.all([
  pool.query('SELECT id,classification,status,summary,proposed_description,questions,commit_sha,spec_version,created_at,resolved_at FROM task_requirement_reviews WHERE task_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 30',[taskId,id]),
  pool.query('SELECT id,version,origin,title,description,reason,created_at FROM task_spec_versions WHERE task_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 30',[taskId,id]),
  pool.query('SELECT id,status,message,spec_version,created_at,completed_at FROM requirement_review_runs WHERE task_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 12',[taskId,id])
 ]);
 return {task:task.rows[0],reviews:reviews.rows,versions:versions.rows,runs:runs.rows};
});
app.post('/api/projects/:id/tasks/:taskId/requirements/retry',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const task=await pool.query('SELECT spec_version,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 if(task.rows[0].spec_review_status==='needs_approval')return reply.code(409).send({error:'Сначала согласуй изменение требований'});
 const run=await startRequirementsReview(id,taskId,task.rows[0].spec_version);
 return reply.code(run.started?202:409).send(run);
});
app.post('/api/projects/:id/tasks/:taskId/requirements/:reviewId/decision',async(req:any,reply)=>{
 const {id,taskId,reviewId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid(),reviewId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {decision}=parse(z.object({decision:z.enum(['approve','reject'])}),req.body);
 if(decision==='approve'&&await pendingAgentQuestions(pool,id,taskId))return reply.code(409).send({error:'Нельзя согласовать изменение требований, пока остаются вопросы агентов без ответа'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const task=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
  const review=await client.query("SELECT * FROM task_requirement_reviews WHERE id=$1 AND task_id=$2 AND project_id=$3 FOR UPDATE",[reviewId,taskId,id]);
  if(!task.rowCount||!review.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Требования или предложение не найдены'});}
  const t=task.rows[0],v=review.rows[0];
  if(decision==='approve'){
   const pending=await client.query("SELECT 1 FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status='open' LIMIT 1",[id,taskId]);
   if(pending.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'Поступил новый вопрос агента: сначала ответь на него'});}
  }
  if(v.classification==='uncertain'&&decision==='approve'){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Аналитик не смог проверить требования. Сначала ответь на вопросы и уточни ТЗ.'});
  }
  if(v.status!=='needs_approval'||t.spec_version!==v.spec_version||t.spec_review_status!=='needs_approval'){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Предложение уже рассмотрено или относится к старой версии ТЗ'});
  }
  if(decision==='approve'){
   const newVersion=await saveSpecRevision(client,t,{title:t.title,description:v.proposed_description,origin:'approved_change',actorId:uid(req),reason:v.summary,reviewStatus:'current',reviewedCommit:v.commit_sha});
   if(newVersion===t.spec_version){
    await client.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note=$4,updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,id,v.commit_sha,v.summary]);
   }
   await client.query("UPDATE task_requirement_reviews SET status='approved',resolved_at=now(),resolved_by=$2 WHERE id=$1",[reviewId,uid(req)]);
  }else{
   const backToDevelopment=['testing','merge_queue'].includes(t.stage);
   await client.query("UPDATE tasks SET spec_review_status='rejected',spec_review_note=$3,test_feedback=$4,stage=CASE WHEN $5 THEN 'development' ELSE stage END,updated_at=now() WHERE id=$1 AND project_id=$2",
    [taskId,id,'Изменение требований отклонено: реализация должна соответствовать утверждённому ТЗ','Отклонено изменение поведения: '+v.summary,backToDevelopment]);
   await client.query("UPDATE task_requirement_reviews SET status='rejected',resolved_at=now(),resolved_by=$2 WHERE id=$1",[reviewId,uid(req)]);
  }
  await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),decision==='approve'?'requirements_approved':'requirements_rejected',v.summary.slice(0,1800)]);
  await client.query('COMMIT');
  return {ok:true,decision};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.patch('/api/projects/:id/tasks/:taskId',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(300).optional(),description:z.string().max(20000).optional(),stage:validStages.optional(),priority:z.number().int().min(1).max(5).optional()}),req.body);
 const client=await pool.connect();
 let version=0,changed=false;
 try{
  await client.query('BEGIN');
  const old=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,id]);
  if(!old.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Задача не найдена'});}
  const t=old.rows[0];
  if(t.type==='question'){
   if(data.stage&&data.stage!==t.stage){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Вопрос не участвует в этапах разработки'});
   }
   if(t.question_status!=='open'&&(data.title!==undefined||data.description!==undefined)){
    await client.query('ROLLBACK');return reply.code(409).send({error:'Вопрос уже передан аналитику и не редактируется'});
   }
   const questionTitle=data.title??t.title,questionText=data.description??t.description;
   await client.query('UPDATE tasks SET title=$3,description=$4,updated_at=now() WHERE id=$1 AND project_id=$2',[taskId,id,questionTitle,questionText]);
   if(questionTitle!==t.title||questionText!==t.description)
    await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',
     [randomUUID(),taskId,uid(req),'question_updated','Вопрос уточнён владельцем продукта']);
   await client.query('COMMIT');
   return {ok:true};
  }
  if(t.type==='question'&&data.stage&&data.stage!==t.stage){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Этап вопроса изменяется после обработки ответа аналитиком'});
  }
  if(data.stage&&data.stage!==t.stage&&(!['backlog','analysis'].includes(t.stage)||!['backlog','analysis'].includes(data.stage))){
   await client.query('ROLLBACK');return reply.code(409).send({error:'Перемещение между разработкой, PR и завершением выполняется только через действия workflow'});
  }
  const title=data.title??t.title,description=data.description??t.description;
  if(data.priority!==undefined&&data.priority!==t.priority){
   await client.query('UPDATE tasks SET priority=$2,updated_at=now() WHERE id=$1',[taskId,data.priority]);
   await client.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'priority_changed',$4)",[randomUUID(),taskId,uid(req),'Приоритет '+data.priority]);
  }
  if(['documentation','done'].includes(t.stage)&&description!==t.description){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'PR уже слит. Чтобы изменить завершённую функциональность, создай новую связанную задачу; нельзя переписывать утверждённое ТЗ уже внедрённой версии.'});
  }
  changed=title!==t.title||description!==t.description;
  version=t.spec_version;
  if(changed)await updateCurrentSpecification(client,id,taskId,title,description);
  const stage=data.stage&&data.stage!==t.stage?data.stage:changed&&t.stage==='merge_queue'?'testing':t.stage;
  if(stage!==t.stage)await client.query('UPDATE tasks SET stage=$2,updated_at=now() WHERE id=$1',[taskId,stage]);
  if(changed){
   if(['analysis','backlog'].includes(t.stage))await client.query("UPDATE tasks SET analysis_state='new' WHERE id=$1",[taskId]);
   await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'spec_changed','Обновлено текущее описание задачи']);
  }
  if(stage!==t.stage)await client.query('INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),taskId,uid(req),'stage_changed',t.stage+' → '+stage]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 return {ok:true,spec_version:version,requirements_review:null};
});
app.get('/api/projects/:id/tasks/:taskId/events',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const r=await pool.query('SELECT e.* FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.id=$1 AND t.project_id=$2 ORDER BY e.created_at DESC',[taskId,id]);return r.rows;
});
// Unified task feed: task actions and Temporal process steps visible before tests begin.
app.get('/api/projects/:id/tasks/:taskId/activity',async(req:any,reply)=>{
 const {id,taskId}=parse(z.object({id:z.string().uuid(),taskId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const task=await pool.query('SELECT id FROM tasks WHERE id=$1 AND project_id=$2',[taskId,id]);
 if(!task.rowCount)return reply.code(404).send({error:'Задача не найдена'});
 const [events,processes,ownership,tests,notes,agentRuns]=await Promise.all([
  pool.query('SELECT id,event,detail,created_at FROM task_events WHERE task_id=$1 ORDER BY created_at DESC LIMIT 200',[taskId]),
  pool.query("SELECT p.id,p.process_kind,p.stage,p.detail,p.level,p.created_at FROM process_events p WHERE p.project_id=$1 AND p.process_id IN (SELECT id FROM ai_task_runs WHERE project_id=$1 AND task_id=$2 UNION SELECT id FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 UNION SELECT id FROM requirement_review_runs WHERE project_id=$1 AND task_id=$2) ORDER BY p.created_at DESC,p.id DESC LIMIT 250",[id,taskId]),
  pool.query('SELECT owner_id,kind,workflow_id,state,started_at FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2',[id,taskId]),
  pool.query('SELECT id,task_id,cycle_id,attempt,status,message,verdict,report,created_at,completed_at,qa_spec_version FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 30',[id,taskId]),
  pool.query('SELECT id,author_stage,author_name,target_stage,kind,body,source_kind,status,answer,answered_at,created_at FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200',[id,taskId]),
  readAgentActivity(pool,id,taskId)
 ]);
 return {events:events.rows,processEvents:processes.rows,agentRuns,owner:ownership.rows[0]?.state==='active'?ownership.rows[0]:null,tests:tests.rows,notes:notes.rows};
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
// Project-scoped process center. The global counter uses this same data model.
// Read-only, project-scoped audit of the actual prompt sent to an AI agent.
// Only administrators can view potentially sensitive task text; secrets are redacted at write time.
app.get('/api/projects/:id/processes/:processId/prompts',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const rows=await pool.query('SELECT id,role,operation,prompt,original_chars,truncated,created_at FROM agent_prompt_audit WHERE project_id=$1 AND process_id=$2 ORDER BY created_at DESC LIMIT 10',[id,processId]);
 return {prompts:rows.rows};
});
// Codex Runner sends the exact final development/QA prompt after adding sandbox rules.
app.post('/internal/agent-prompt',async(req:any,reply)=>{
 const secret=process.env.RUNNER_SHARED_SECRET||'';
 if(!secret||req.headers['x-runner-secret']!==secret)return reply.code(403).send({error:'Forbidden'});
 const data=parse(z.object({
  projectId:z.string().uuid(),processId:z.string().uuid(),
  role:z.enum(['development','testing']),prompt:z.string().min(1).max(80000)
 }),req.body);
 const belongs=await pool.query(
  'SELECT 1 FROM ai_task_runs WHERE project_id=$1 AND id=$2 UNION ALL SELECT 1 FROM ai_test_runs WHERE project_id=$1 AND id=$2 LIMIT 1',
  [data.projectId,data.processId]);
 if(!belongs.rowCount)return reply.code(404).send({error:'Process not found'});
 await recordAgentPrompt(pool,{projectId:data.projectId,processId:data.processId,role:data.role,operation:'codex_exec',prompt:data.prompt});
 return {ok:true};
});
app.get('/api/projects/:id/processes',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const [imports,developments,tests,merges,analyses,iterationRuns,deployments,queuedTasks,peerQuestions,pmOrders,taskAnalyses]=await Promise.all([
  pool.query("SELECT j.id,j.status,j.message,j.source_url,j.request_text,j.source_file_count,j.analyzed_chunks,j.total_chunks,j.saved_documents,j.created_at,j.updated_at,j.result,j.draft_result IS NOT NULL AS has_draft,(SELECT count(*)::int FROM document_import_topics tp WHERE tp.job_id=j.id) AS topic_total,(SELECT count(*)::int FROM document_import_topics tp WHERE tp.job_id=j.id AND tp.status IN ('complete','conflict')) AS topic_completed FROM document_import_jobs j WHERE j.project_id=$1 ORDER BY j.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT r.id,r.task_id,r.status,r.message,r.model,r.created_at,r.completed_at,t.title AS task_title,t.display_number,r.pr_url FROM ai_task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT t.id,t.task_id,t.status,t.message,t.verdict,t.report,t.attempt,t.created_at,t.completed_at,k.title AS task_title,k.display_number FROM ai_test_runs t JOIN tasks k ON k.id=t.task_id WHERE t.project_id=$1 ORDER BY t.created_at DESC LIMIT 70",[id]),
  pool.query("SELECT id,status,message,created_at,finished_at,results FROM merge_process_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 70",[id]),
  pool.query("SELECT r.id,r.task_id,r.status,r.message,r.created_at,r.completed_at,r.spec_version,t.display_number,t.title AS task_title FROM requirement_review_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  pool.query(`SELECT r.id,r.status,r.message,r.created_at,r.updated_at,r.plan_id,i.id AS iteration_id,i.title
   FROM iteration_planning_runs r JOIN project_iterations i ON i.id=r.iteration_id
   WHERE i.project_id=$1 ORDER BY r.created_at DESC LIMIT 70`,[id]),
  pool.query("SELECT r.id,r.status,r.message,r.sha,r.github_url,r.task_id,r.created_at,r.updated_at,t.title,t.display_number FROM deployment_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id]),
  readDevelopmentQueue(pool,id),
  pool.query("SELECT q.note_id AS id,q.task_id,q.role,q.status,q.error AS detail,q.updated_at,n.body,t.display_number FROM agent_peer_queue q JOIN task_agent_notes n ON n.id=q.note_id JOIN tasks t ON t.id=q.task_id WHERE q.project_id=$1 AND q.status IN ('queued','running','waiting','failed') ORDER BY q.updated_at DESC LIMIT 60",[id]),
  pool.query("SELECT id,status,summary AS detail,updated_at,created_at FROM project_pm_orders WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 40",[id]),
  pool.query("SELECT r.id,r.task_id,r.status,r.message,r.created_at,r.updated_at,t.title,t.display_number FROM agent_analysis_runs r JOIN tasks t ON t.id=r.task_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 70",[id])
 ]);
 const promptRecords=await pool.query(
  'SELECT * FROM (SELECT DISTINCT ON (process_id) process_id AS id,role,operation,created_at FROM agent_prompt_audit WHERE project_id=$1 ORDER BY process_id,created_at DESC) entries ORDER BY created_at DESC LIMIT 50',
  [id]);
 const processes:any[]=[
  ...deployments.rows.map((r:any)=>({id:r.id,kind:'deployment',title:'Выкладка #'+r.display_number+' · '+r.title,
   status:r.status,detail:r.message,createdAt:r.created_at,updatedAt:r.updated_at,taskId:r.task_id,
   result:{message:r.message,sha:r.sha,github_url:r.github_url}})),
  ...iterationRuns.rows.map(row=>({id:row.id,kind:'analysis',title:'План задач · '+row.title,status:row.status,
   detail:row.message,createdAt:row.created_at,updatedAt:row.updated_at,iterationId:row.iteration_id,result:{message:row.message}})),
  ...imports.rows.map((r:any)=>({id:r.id,kind:'document_import',title:(r.source_url?'Анализ материалов · '+r.source_url.split('/').slice(-1)[0]:'Подготовка ТЗ'),status:r.status,detail:r.message,createdAt:r.created_at,updatedAt:r.updated_at,sourceUrl:r.source_url,requestText:r.request_text,progress:{completed:r.analyzed_chunks,total:r.total_chunks},topicProgress:{completed:r.topic_completed,total:r.topic_total},result:r.result,savedDocuments:r.saved_documents,hasDraft:r.has_draft,sourceFileCount:r.source_file_count})),
  ...developments.rows.map((r:any)=>({id:r.id,kind:'development',title:'Разработка #'+r.display_number+' · '+r.task_title,status:r.status,detail:queuedTasks.find(row=>row.run_id===r.id)?.detail||r.message,createdAt:r.created_at,updatedAt:r.completed_at,taskId:r.task_id,result:r.pr_url?{prUrl:r.pr_url}:null}))
 ];
 for(const row of tests.rows){
  processes.push({id:row.id,kind:'testing',title:'Тестирование #'+row.display_number+' · '+row.task_title,
   status:row.status,detail:row.message,createdAt:row.created_at,updatedAt:row.completed_at,taskId:row.task_id,
   result:row.report?{message:row.report.summary,verdict:row.verdict,findings:row.report.findings,checks:row.report.checks,commit:row.report.commit}:null});
 }
 for(const row of taskAnalyses.rows){
  processes.push({id:row.id,kind:'analysis',title:'Анализ задачи #'+row.display_number+' · '+row.title,status:row.status,detail:row.message||'Системный аналитик обрабатывает задачу',createdAt:row.created_at,updatedAt:row.updated_at,taskId:row.task_id,result:{message:row.message}});
 }
 for(const row of analyses.rows){
  if(developments.rows.some((dev:any)=>dev.id===row.id))continue; // Reconciliation is already recorded in the development process events.
  processes.push({id:row.id,kind:'analysis',title:'Сверка ТЗ #'+row.display_number+' · '+row.task_title,status:row.status,
   detail:row.message,createdAt:row.created_at,updatedAt:row.completed_at,taskId:row.task_id,result:{message:row.message}});
 }
 for(const row of queuedTasks){
  if(developments.rows.some(run=>run.id===row.run_id))continue;
  processes.push({id:row.run_id||row.task_id,kind:'development',title:'Очередь разработки #'+row.display_number+' · '+row.title,
   status:row.status==='dispatching'?'running':row.status,detail:row.detail,createdAt:row.created_at,updatedAt:row.updated_at,taskId:row.task_id});
 }
 for(const row of peerQuestions.rows){
  processes.push({id:row.id,kind:'analysis',title:'Вопрос специалисту · задача #'+row.display_number,status:row.status,detail:row.detail||row.body,createdAt:row.updated_at,updatedAt:row.updated_at,taskId:row.task_id});
 }
 for(const row of pmOrders.rows){
  processes.push({id:row.id,kind:'analysis',title:row.status==='waiting_user'?'ПМ · нужен твой ответ в чате':row.status==='waiting_agents'?'ПМ · ожидает команду':'Поручение ПМ',status:row.status==='working'?'running':row.status==='queued'?'queued':['completed','failed'].includes(row.status)?row.status:'waiting',detail:row.detail,createdAt:row.created_at,updatedAt:row.updated_at});
 }
 for(const row of merges.rows){
  processes.push({id:row.id,kind:'merge',title:'Слияние готовых PR',status:row.status,detail:row.message,createdAt:row.created_at,updatedAt:row.finished_at,result:{results:row.results}});
 }
 const visibleIds=new Set(processes.map(p=>p.id));
 for(const entry of promptRecords.rows){
  if(visibleIds.has(entry.id))continue;
  processes.push({id:entry.id,kind:'analysis',title:'AI-запрос · '+entry.role,
   status:'logged',detail:'Промпт подготовлен для вызова модели ('+entry.operation+'); результат смотри в соответствующем чате.',
   createdAt:entry.created_at,updatedAt:entry.created_at});
 }
 processes.sort((x,y)=>new Date(y.createdAt).getTime()-new Date(x.createdAt).getTime());
 return {processes,checkedAt:new Date().toISOString()};
});
app.post('/api/projects/:id/processes/:processId/instructions',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {message}=parse(z.object({message:z.string().trim().min(1).max(2000)}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const job=await client.query("SELECT status,message FROM document_import_jobs WHERE project_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE",[id,processId,uid(req)]);
  if(!job.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Процесс импорта не найден'});}
  if(job.rows[0].status!=='running'){await client.query('ROLLBACK');return reply.code(409).send({error:'Аналитик уже завершил или остановил этот процесс'});}
  if(/Формирование итоговой структуры|Сохранение документов/.test(String(job.rows[0].message))){
   await client.query('ROLLBACK');
   return reply.code(409).send({error:'Аналитик уже сохраняет результат. Уточнение на этой стадии не успеет примениться.'});
  }
  await client.query('INSERT INTO process_instructions(id,project_id,process_id,actor_id,body) VALUES($1,$2,$3,$4,$5)',
   [randomUUID(),id,processId,uid(req),message]);
  await client.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'document_import','user_instruction',$4)",
   [randomUUID(),id,processId,message]);
  const acknowledgement='Уточнение принято и передано аналитику. Оно будет учтено на текущем или следующем этапе.';
  await client.query("INSERT INTO assistant_messages(id,project_id,task_id,actor_id,role,body,channel,created_at) VALUES($1,$2,NULL,$3,'user',$4,'documentation',clock_timestamp()),($5,$2,NULL,NULL,'assistant',$6,'documentation',clock_timestamp())",
   [randomUUID(),id,uid(req),message,randomUUID(),acknowledgement]);
  await client.query('COMMIT');
  return {ok:true,message:acknowledgement};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
});
// Stop an active analyst run without rolling back previously committed checkpoints.
 // Locking the job row also serializes the request with document-writing checkpoints.
app.post('/api/projects/:id/processes/:processId/stop',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 // Stop the actual Codex job and its Temporal workflow, without deleting the task or PR.
 const cancelRunner=async(runId:string)=>{
  try{
   await fetch((process.env.CODEX_RUNNER_URL||'http://codex:4300')+'/jobs/'+runId+'/cancel',{
    method:'POST',headers:{'X-Runner-Secret':process.env.RUNNER_SHARED_SECRET||''},
    signal:AbortSignal.timeout(8000)
   });
  }catch(error){req.log.warn({error,runId},'Codex cancellation needs reconciliation');}
 };
 const cancelWorkflow=async(workflowId:string)=>{
  try{const client=await temporal();await client.workflow.getHandle(workflowId).cancel();}
  catch(error){req.log.warn({error,workflowId},'Temporal cancellation needs reconciliation');}
 };
 const analyst=await pool.query("UPDATE agent_analysis_runs SET status='cancelled',message='Прервано пользователем',updated_at=now() WHERE project_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING task_id,spec_version",[id,processId]);
 if(analyst.rowCount){
  await pool.query("UPDATE tasks SET analysis_state='paused',updated_at=now() WHERE project_id=$1 AND id=$2 AND stage='analysis' AND analysis_state='processing' AND spec_version=$3",[id,analyst.rows[0].task_id,analyst.rows[0].spec_version]);
  await cancelWorkflow('task-analysis-'+processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'analysis','cancelled','Анализ задачи остановлен пользователем')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const dev=await pool.query("UPDATE ai_task_runs SET status='cancelled',message='Прервано пользователем',completed_at=now() WHERE project_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING task_id,cycle_id",[id,processId]);
 if(dev.rowCount){
  await cancelRunner(processId);
  await cancelWorkflow('task-cycle-'+(dev.rows[0].cycle_id||processId));
  await releaseTaskOrchestration(pool,id,dev.rows[0].task_id,dev.rows[0].cycle_id||processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'development','cancelled','Разработка остановлена пользователем')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const test=await pool.query("UPDATE ai_test_runs SET status='cancelled',message='Прервано пользователем',completed_at=now() WHERE project_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING task_id,cycle_id",[id,processId]);
 if(test.rowCount){
  await cancelRunner(processId);
  const cycle=test.rows[0].cycle_id;
  if(cycle){await cancelWorkflow('task-cycle-'+cycle);await cancelWorkflow('manual-test-'+cycle);}
  await releaseTaskOrchestration(pool,id,test.rows[0].task_id,cycle||processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'testing','cancelled','Тестирование остановлено пользователем')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const queue=await pool.query("UPDATE iteration_execution_queue SET status='cancelled',detail='Запуск отменён пользователем',updated_at=now() WHERE project_id=$1 AND COALESCE(run_id,task_id)=$2 AND status='queued' RETURNING task_id",[id,processId]);
 if(queue.rowCount)return {ok:true,status:'cancelled'};
 const planning=await pool.query("UPDATE iteration_planning_runs r SET status='cancelled',message='Прервано пользователем',updated_at=now() FROM project_iterations i WHERE r.id=$2 AND r.iteration_id=i.id AND i.project_id=$1 AND r.status IN ('queued','running') RETURNING r.id",[id,processId]);
 if(planning.rowCount){
  await cancelWorkflow('iteration-plan-'+processId);
  await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'analysis','cancelled','Планирование итерации остановлено')",[randomUUID(),id,processId]);
  return {ok:true,status:'cancelled'};
 }
 const stopped=await pool.query(
  "UPDATE document_import_jobs SET status='cancelled',message='Остановлен пользователем',updated_at=now() WHERE project_id=$1 AND id=$2 AND actor_id=$3 AND status='running' RETURNING id",
  [id,processId,uid(req)]);
 if(!stopped.rowCount)return reply.code(409).send({error:'Процесс уже завершён или не принадлежит пользователю'});
 await pool.query("INSERT INTO process_events(id,project_id,process_id,process_kind,stage,detail) VALUES($1,$2,$3,'document_import','stopped','Пользователь остановил работу аналитика')",
  [randomUUID(),id,processId]);
 // The persisted status prevents subsequent writes even when cancellation reaches an
 // in-flight Codex request later. Workflow cancellation releases its worker slot.
 try{
  const client=await temporal();
  await client.workflow.getHandle('analyst-'+processId).cancel();
 }catch(error){req.log.warn({error},'Temporal cancel pending; persisted stop gate already active');}
 return {ok:true,status:'cancelled',message:'Аналитик остановлен. Уже сохранённые контрольные точки и документы не удалены.'};
});
app.get('/api/projects/:id/processes/:processId/events',async(req:any,reply)=>{
 const {id,processId}=parse(z.object({id:z.string().uuid(),processId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 const rows=await pool.query("SELECT id,process_kind,level,stage,detail,created_at FROM process_events WHERE project_id=$1 AND process_id=$2 ORDER BY created_at ASC LIMIT 500",[id,processId]);
 return rows.rows;
});

app.get('/api/projects/:id/documentation/proposals',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);
 if(!await access(req,reply,id))return;
 return (await pool.query("SELECT v.id,v.job_id,v.topic_key,v.document_id,v.title,v.proposed_body,v.status,v.created_at,d.title AS document_title FROM document_import_proposals v JOIN documents d ON d.id=v.document_id WHERE v.project_id=$1 AND v.status='open' ORDER BY v.created_at",[id])).rows;
});
app.post('/api/projects/:id/documentation/proposals/:proposalId/decision',async(req:any,reply)=>{
 const {id,proposalId}=parse(z.object({id:z.string().uuid(),proposalId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const {decision}=parse(z.object({decision:z.enum(['approve','reject'])}),req.body);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const v=(await client.query("SELECT * FROM document_import_proposals WHERE id=$1 AND project_id=$2 AND status='open' FOR UPDATE",[proposalId,id])).rows[0];
  if(!v){await client.query('ROLLBACK');return reply.code(409).send({error:'Предложение уже обработано'});}
  const d=(await client.query('SELECT id,title,body,system_key FROM documents WHERE id=$1 AND project_id=$2 FOR UPDATE',[v.document_id,id])).rows[0];
  if(!d||d.system_key){await client.query('ROLLBACK');return reply.code(409).send({error:'Страница недоступна для обновления'});}
  if(decision==='approve'){
   if(fingerprint(d.title,d.body)!==v.base_hash){await client.query('ROLLBACK');return reply.code(409).send({error:'Страница изменилась после формирования предложения. Нужна повторная сверка.'});}
   await client.query("UPDATE documents SET title=$2,body=$3,import_synced_hash=$4,updated_at=now() WHERE id=$1",[d.id,v.title,v.proposed_body,fingerprint(v.title,v.proposed_body)]);
  }
  await client.query("UPDATE document_import_proposals SET status=$2,decided_at=now() WHERE id=$1",[proposalId,decision==='approve'?'approved':'rejected']);
  await client.query('COMMIT');
  return {ok:true,decision};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.get('/api/projects/:id/docs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 return (await pool.query("SELECT * FROM documents WHERE project_id=$1 ORDER BY CASE system_key WHEN 'spec' THEN 0 WHEN 'architecture' THEN 1 WHEN 'operations' THEN 2 WHEN 'design' THEN 3 WHEN 'research' THEN 4 ELSE 5 END, title ASC, id ASC",[id])).rows;
});
app.post('/api/projects/:id/docs',async(req:any,reply)=>{
 const {id}=parse(z.object({id:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const {title,body,parent_id,document_kind,implementation_status,implementation_evidence}=parse(z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000).default(''),parent_id:docParent,document_kind:z.enum(['technical','functional']).default('technical'),implementation_status:z.enum(['unverified','planned','partial','implemented']).default('unverified'),implementation_evidence:z.string().max(2000).default('')}),req.body);
 if(!parent_id)return reply.code(409).send({error:'Создавай страницы внутри одного из пяти системных разделов'});
  if(!await validDocParent(id,null,parent_id))return reply.code(400).send({error:'Родительская страница не найдена в проекте'});
 const docId=randomUUID();
 await pool.query('INSERT INTO documents(id,project_id,title,body,parent_id,document_kind,implementation_status,implementation_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[docId,id,title,body,parent_id??null,document_kind,implementation_status,implementation_evidence]);
 return reply.code(201).send({id:docId});
});
app.patch('/api/projects/:id/docs/:docId',async(req:any,reply)=>{
 const {id,docId}=parse(z.object({id:z.string().uuid(),docId:z.string().uuid()}),req.params);if(!await access(req,reply,id))return;
 const data=parse(z.object({title:z.string().trim().min(1).max(200),body:z.string().max(100000),parent_id:docParent,document_kind:z.enum(['technical','functional']).optional(),implementation_status:z.enum(['unverified','planned','partial','implemented']).optional(),implementation_evidence:z.string().max(2000).optional()}),req.body);
 const old=await pool.query('SELECT parent_id,system_key,title FROM documents WHERE id=$1 AND project_id=$2',[docId,id]);
 if(!old.rowCount)return reply.code(404).send({error:'Документ не найден'});
 const parentId=data.parent_id===undefined?old.rows[0].parent_id:data.parent_id;
 if(old.rows[0].system_key && (data.title!==old.rows[0].title || parentId!==null))return reply.code(409).send({error:'Название и расположение системного раздела нельзя менять'});
  if(!old.rows[0].system_key&&!parentId)return reply.code(409).send({error:'Страницу нельзя переместить за пределы системных разделов'});
  if(!await validDocParent(id,docId,parentId))return reply.code(400).send({error:'Нельзя переместить страницу в себя, своего потомка или другой проект'});
 await pool.query("UPDATE documents SET title=$1,body=$2,parent_id=$3,document_kind=COALESCE($6,document_kind),implementation_status=COALESCE($7,implementation_status),implementation_evidence=COALESCE($8,implementation_evidence),updated_at=clock_timestamp() WHERE id=$4 AND project_id=$5",[data.title,data.body,parentId,docId,id,data.document_kind||null,data.implementation_status||null,data.implementation_evidence??null]);
 return {ok:true};
});
app.delete('/api/projects/:id/docs/:docId',async(req:any,reply)=>{
 const {id,docId}=parse(z.object({id:z.string().uuid(),docId:z.string().uuid()}),req.params);
 if(!await access(req,reply,id)||!await requireAdmin(req,reply))return;
 const document=await pool.query('SELECT id,system_key FROM documents WHERE id=$1 AND project_id=$2',[docId,id]);
 if(!document.rowCount)return reply.code(404).send({error:'Документ не найден'});
  if(document.rows[0].system_key)return reply.code(409).send({error:'Системный раздел документации нельзя удалить'});
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
async function startIterationPlanning(runId:string){
 try{
  const client=await temporal();
  await client.workflow.start('prepareIterationPlan',{taskQueue:'agent-pipeline',workflowId:'iteration-plan-'+runId,
   workflowIdReusePolicy:'REJECT_DUPLICATE',args:[runId]});
 }catch(error){if((error as Error)?.name!=='WorkflowExecutionAlreadyStartedError')throw error;}
}
registerAgentToolRoutes(app,{pool,access,requireAdmin,startIterationPlanning,startDocumentationWorkflow:async jobId=>{
 const client=await temporal();
 await client.workflow.start('prepareProjectSpecification',{taskQueue:'agent-pipeline',workflowId:'analyst-'+jobId,args:[jobId]});
},delegateManagerAction:async(session,name,args)=>{
 const projectId=session.project_id;
 if(session.role!=='manager')throw Object.assign(Error('Действие только для ПМ'),{statusCode:403});
 const user=(await pool.query('SELECT email FROM users WHERE id=$1',[session.actor_id])).rows[0];
 if(!user)throw Object.assign(Error('Пользователь не найден'),{statusCode:403});
 const id=z.string().uuid();
 if(name==='tasks.update_dependency'){
   const taskId=id.parse(args.task_id);
   const parentId=z.string().uuid().nullable().parse(args.depends_on_task_id);
   const reason=z.string().trim().min(10).max(1200).parse(args.reason);
   const result=await updateDependency(projectId,taskId,parentId,session.actor_id);
   await pool.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'pm_dependency_decision',$4)",
    [randomUUID(),taskId,session.actor_id,reason]);
   return result;
  }
  const taskId=id.parse(args.task_id);
 const task=(await pool.query('SELECT id,iteration_id,stage FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId])).rows[0];
 if(!task)throw Object.assign(Error('Задача не найдена'),{statusCode:404});
 const token=await accessToken(session.actor_id,user.email);
 let url='/api/projects/'+projectId+'/tasks/'+taskId,payload:Record<string,unknown>={};
 if(name==='approvals.answer_question'){
  const noteId=id.parse(args.note_id);
  const answer=z.string().trim().min(3).max(3000).parse(args.answer);
  url+='/agent-notes/'+noteId+'/answer';payload={answer};
 }else if(name==='approvals.decide'){
  const requestId=id.parse(args.request_id);
  const choice=z.enum(['approve_without_visual','wait_for_tools','answer','approve_requirements','reject_requirements']).parse(args.choice);
  const answer=z.string().trim().max(3000).default('').parse(args.answer);
  url+='/manager/requests/'+requestId+'/decision';payload={choice,answer};
 }else if(name==='qa.retry'){
  url+='/start-testing';payload={};
 }else if(name==='workflow.approve_development'){
  url+='/run-ai';payload={approveAnalysis:true};
  if(task.iteration_id){
   const iteration=(await pool.query('SELECT id,revision,approved_revision FROM project_iterations WHERE project_id=$1 AND id=$2',[projectId,task.iteration_id])).rows[0];
   if(!iteration||iteration.approved_revision!==iteration.revision)
    throw Object.assign(Error('Объём итерации не согласован или изменился'),{statusCode:409});
   payload.iterationApproval={id:iteration.id,revision:iteration.revision};
  }
 }else throw Object.assign(Error('Недопустимое действие ПМ'),{statusCode:403});
 const response=await app.inject({method:'POST',url,headers:{authorization:'Bearer '+token},payload});
 let result:any;
 try{result=response.json();}catch{result={error:response.body.slice(0,300)};}
 if(response.statusCode>=400)throw Object.assign(Error(String(result.error||'Операция не выполнена').slice(0,700)),{statusCode:response.statusCode});
 return name==='qa.retry'?{...result,task_id:taskId}:result;
}});
const assistant=registerAssistantRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey,decryptToken,
 startDocumentationWorkflow:async jobId=>{
  const client=await temporal();
  await client.workflow.start('prepareProjectSpecification',{taskQueue:'agent-pipeline',workflowId:'analyst-'+jobId,args:[jobId]});
 }
});
registerProjectManagerInbox(app,{pool,uid,access,requireAdmin,start:async turn=>{
 const client=await temporal();
 const workflowId=pmInboxWorkflowId(turn);
 try{
  await client.withDeadline(Date.now()+5000,()=>client.workflow.start('processProjectManagerInbox',{
   taskQueue:'agent-pipeline',workflowId,workflowIdReusePolicy:'REJECT_DUPLICATE',
   args:[turn.project_id,turn.id,turn.pm_dispatch_attempt]
  }));
 }catch(error){
  if((error as Error)?.name!=='WorkflowExecutionAlreadyStartedError')throw error;
  const previous=await client.withDeadline(Date.now()+5000,()=>client.workflow.getHandle(workflowId).describe());
  // A legacy workflow may have exhausted its retries before persisting the failure.
  if(['FAILED','CANCELLED','TERMINATED','TIMED_OUT','COMPLETED'].includes(previous.status.name))
   await failProjectManagerInbox(pool,turn.project_id,turn.id,turn.pm_dispatch_attempt);
 }
}});
registerKnowledgeRoutes(app,{pool,uid,access,requireAdmin,codexUrl,runnerKey});
registerKnowledgeContextRoutes(app,{pool,access,requireAdmin});
registerDocumentationResetRoutes(app,{pool,uid,access,requireAdmin});
registerSafeTaskDeletion(app,{pool,uid,access,requireAdmin});
registerProjectIterationRoutes(app,{pool,uid,access,requireAdmin,startPlanning:startIterationPlanning});
registerAutomaticDeploymentRoutes(app,{pool,uid,access,requireAdmin,decrypt:decryptToken,start:async runId=>{
 const client=await temporal();
 await client.workflow.start('automaticDeployment',{taskQueue:'agent-pipeline',workflowId:'deployment-'+runId,
  workflowIdReusePolicy:'REJECT_DUPLICATE',args:[runId]});
}});
registerBusinessAnalystHandoff(app,{pool,uid,access});
registerProjectTeamRoutes(app,{pool,access,requireAdmin,uid});
registerKnowledgeWorkflowRoutes(app,{pool,access,requireAdmin});
registerKnowledgeDocumentUpdateRoutes(app,{pool,uid,access,requireAdmin});
registerQaRoutes(app,{pool,uid,access,requireAdmin});
registerQaWaiverRoutes(app,{pool,uid,access,requireAdmin,decryptToken});
async function recoverTask({projectId,taskId,auth,cookie}:Parameters<ManagerDeps['recoverTask']>[0]):ReturnType<ManagerDeps['recoverTask']>{
  const task=(await pool.query("SELECT t.stage,t.analysis_state,t.pr_number,t.git_branch,t.pr_url,t.spec_review_status,t.spec_version,t.test_feedback,g.repository,c.secret_encrypted FROM tasks t LEFT JOIN project_git_repositories g ON g.project_id=t.project_id LEFT JOIN connections c ON c.id=g.connection_id WHERE t.id=$1 AND t.project_id=$2",
   [taskId,projectId])).rows[0];
  if(!task)return {ok:false,status:404,message:'Задача не найдена'};
  if(!['testing','development'].includes(task.stage))
   return {ok:false,status:409,message:'Восстановление доступно на этапе разработки или тестирования.'};
  const taskPath='/api/projects/'+projectId+'/tasks/'+taskId;
  const request=(route:string)=>app.inject({method:'POST',url:taskPath+route,headers:{authorization:auth,cookie},payload:{}});
  const owner=await pool.query("SELECT 1 FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[projectId,taskId]);
  if(owner.rowCount&&task.stage==='development')
   return {ok:false,status:409,message:'Для задачи уже зарегистрирован процесс разработки. Его состояние доступно в Центре процессов.'};
  const notes=await pool.query("SELECT id,body FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status='open' AND author_stage='analysis'",[projectId,taskId]);
  const evidenceNotes=notes.rows.filter(note=>isPrEvidenceRequest(note.body));
  const review=task.spec_review_status==='needs_approval'
   ?(await pool.query("SELECT id,classification,questions FROM task_requirement_reviews WHERE project_id=$1 AND task_id=$2 AND spec_version=$3 AND status='needs_approval' ORDER BY created_at DESC LIMIT 1",[projectId,taskId,task.spec_version])).rows[0]
   :null;
  const evidenceReview=review?.classification==='uncertain'&&Array.isArray(review.questions)
   &&review.questions.length>0&&review.questions.every(isPrEvidenceRequest);
  if(task.spec_review_status==='needs_approval'&&!evidenceReview)
   return {ok:false,status:409,message:'Сначала нужно разрешить содержательное замечание аналитика по требованиям.'};
  if(task.stage==='testing'){
   const decision=await pool.query("SELECT 1 FROM manager_requests WHERE project_id=$1 AND task_id=$2 AND kind='qa_visual' AND status IN ('open','waiting') AND source_id=(SELECT id FROM ai_test_runs WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1)",[projectId,taskId]);
   if(decision.rowCount)return {ok:false,status:409,message:'В Центре процессов ожидается решение по непроверенным визуальным сценариям.'};
  }
  // An existing PR may be parked in development even though no code revision is due.
  // A real rejection or QA finding still goes back through the developer.
  const handoff=task.stage==='development'&&task.analysis_state==='approved'&&task.pr_url&&task.git_branch&&!task.test_feedback&&task.spec_review_status!=='rejected';
  if(evidenceNotes.length||evidenceReview||handoff){
   if(!task.pr_number||!task.repository||!task.secret_encrypted)
    return {ok:false,status:409,message:'Не удалось найти PR через подключение GitHub проекта.'};
   const response=await fetch('https://api.github.com/repos/'+task.repository+'/pulls/'+task.pr_number,{
    headers:{Authorization:'Bearer '+decryptToken(task.secret_encrypted),Accept:'application/vnd.github+json','User-Agent':'ai-development-orchestrator'},
    signal:AbortSignal.timeout(15000)
   });
   if(!response.ok)return {ok:false,status:503,message:'Не удалось подтвердить PR в GitHub: HTTP '+response.status};
   const pr=await response.json() as any;
   if(pr.state!=='open'||pr.head?.ref!==task.git_branch||!pr.head?.sha)
    return {ok:false,status:409,message:'PR закрыт или не соответствует ветке задачи.'};
   const tx=await pool.connect();
   try{
    await tx.query('BEGIN');
    const current=(await tx.query("SELECT stage,analysis_state,spec_version,spec_review_status,pr_number,git_branch,test_feedback FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE",[taskId,projectId])).rows[0];
    if(!current||['stage','analysis_state','spec_version','spec_review_status','pr_number','git_branch','test_feedback'].some(key=>current[key]!==task[key])){
     await tx.query('ROLLBACK');return {ok:false,status:409,message:'Состояние задачи изменилось во время проверки PR.'};
    }
    if(evidenceNotes.length)await tx.query("UPDATE task_agent_notes SET status='answered',answer='PR подтверждён в GitHub. Аналитик получит изменения PR при сверке, а тестировщик проверит реализацию.',answer_author='Менеджер проекта',answered_at=now(),processing_at=NULL,requires_customer=false WHERE project_id=$1 AND task_id=$2 AND status='open' AND id=ANY($3::uuid[])",
     [projectId,taskId,evidenceNotes.map(note=>note.id)]);
    if(evidenceReview){
     const cleared=await tx.query("UPDATE task_requirement_reviews SET status='superseded',resolved_at=now() WHERE id=$1 AND status='needs_approval' RETURNING id",[review.id]);
     if(!cleared.rowCount){await tx.query('ROLLBACK');return {ok:false,status:409,message:'Решение по требованиям уже изменилось.'};}
     await tx.query("UPDATE tasks SET spec_review_status='pending',spec_review_note='Аналитик повторно сверит ТЗ по актуальному PR',updated_at=now() WHERE id=$1",[taskId]);
    }
    const pending=await tx.query("SELECT 1 FROM task_agent_notes WHERE project_id=$1 AND task_id=$2 AND kind='question' AND status IN ('open','processing') AND (target_stage='all' OR requires_customer) LIMIT 1",[projectId,taskId]);
    if(handoff&&!pending.rowCount){
     const advanced=await tx.query("UPDATE tasks SET stage='testing',updated_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND state='active') AND NOT EXISTS(SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND status IN ('queued','running')) RETURNING id",[taskId]);
     if(!advanced.rowCount){
      await tx.query('ROLLBACK');return {ok:false,status:409,message:'Для задачи уже запущена разработка.'};
     }
     await tx.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,'stage_changed',$3)",[randomUUID(),taskId,'Менеджер передал существующий PR на сверку и тестирование']);
     task.stage='testing';
    }
    await tx.query('COMMIT');
   }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
  }
  const response=await request(task.stage==='development'?'/run-ai':'/start-testing');
  const data=response.json() as any;
  if(response.statusCode>=400)
   return {ok:false,status:response.statusCode,message:String(data.error||'Проверка условий перехода не прошла'),details:data};
  return {ok:true,status:202,message:task.stage==='development'
   ?'Разработка в очереди. После неё автоматически запустится тестирование.'
   :'Запущено тестирование существующего PR.',details:data};
 }
registerTaskAgentNotesRoutes(app,{pool,uid,access,requireAdmin,startRequirementsReview,resumeAfterAnswer:async input=>{
 const owner=await pool.query("SELECT 1 FROM task_orchestration_owners WHERE project_id=$1 AND task_id=$2 AND state='active'",[input.projectId,input.taskId]);
 if(owner.rowCount)return {started:true,message:'Ответ передан в текущий процесс.'};
 const intent=(await pool.query(`SELECT q.status,q.spec_version,t.spec_version AS current_spec,q.iteration_id,t.iteration_id AS current_iteration,
  q.approved_revision,i.approved_revision AS current_approval,i.revision
  FROM iteration_execution_queue q JOIN tasks t ON t.id=q.task_id
  LEFT JOIN project_iterations i ON i.id=q.iteration_id
  WHERE q.project_id=$1 AND q.task_id=$2 AND q.status IN ('queued','stale')`,[input.projectId,input.taskId])).rows[0];
 if(intent){
  const valid=intent.status==='queued'&&intent.spec_version===intent.current_spec&&intent.iteration_id===intent.current_iteration
   &&(!intent.iteration_id||intent.approved_revision===intent.current_approval&&intent.approved_revision===intent.revision);
  if(valid)return {started:true,message:'Ответ сохранён. Диспетчер повторно проверит условия запуска.'};
  return {started:false,message:'Ответ сохранён. Изменившийся запуск нужно подтвердить повторно.'};
 }
 const result=await recoverTask(input);
 return {started:result.ok,message:result.message};
}});
registerTaskCancellationRoutes(app,{pool,uid,access,requireAdmin,decryptToken});
registerProjectManagerRoutes(app,{pool,uid,access,requireAdmin,
 decideAction:assistant.decideTaskManagerAction,
 workerSecret:runnerKey,
 workerAuthorization:async(actorId,email)=>'Bearer '+await new SignJWT({email}).setProtectedHeader({alg:'HS256'})
  .setSubject(actorId).setIssuedAt().setExpirationTime('2m').sign(jwtKey),
 recoverTask,
 stopManagerWorkflow:async messageId=>{
  const client=await temporal();
  await client.workflow.getHandle('manager-msg-'+messageId).cancel();
 },
 startManagerWorkflow:async({projectId,taskId,messageId})=>{
  const client=await temporal();
  await client.workflow.start('projectManagerReply',{taskQueue:'agent-pipeline',workflowId:'manager-msg-'+messageId,args:[{projectId,taskId,messageId}]});
 }
});
async function main(){await dbInit();await initAgentPromptAudit(pool);await initDiagnosticSchema(pool);await initCloudDiagnosticsSchema(pool);await initAutomaticDeployment(pool);await initProjectIterations(pool);await initAgentToolsSchema(pool);await initProjectTeamSchema(pool);await initQaSchema(pool);await initRequirementsSchema(pool);await initQaWaiverSchema(pool);await initTaskOrchestrationSchema(pool);await initTaskAgentNotesSchema(pool);await initAgentPeerQueue(pool);await initTaskAnalysisQueue(pool);await initTaskCancellationSchema(pool);await initProjectManagerSchema(pool);await initChatImages(pool);await initProjectManagerInbox(pool);await initMergeBatches(pool);await app.listen({port:Number(process.env.PORT||3001),host:'0.0.0.0'});
  startCloudDiagnosticsSender(pool,{url:process.env.SUPABASE_DIAGNOSTICS_URL||'',apiKey:process.env.SUPABASE_DIAGNOSTICS_API_KEY||'',logger:message=>app.log.warn(message)});
 const reconcile=()=>void (async()=>{
  try{await reconcileAgentPeerQueue(pool,temporal);}catch(error){app.log.error({error},'Agent peer queue reconciliation failed');}
  try{await recoverMergeBatches(pool,startMergeBatch);}catch(error){app.log.error({error},'Merge queue reconciliation failed');}
  try{await publishOwnerQuestionsToPmChat(pool);}catch(error){app.log.error({error},'PM owner questions reconciliation failed');}
  try{await reconcileTaskAnalysisQueue(pool,temporal);}catch(error){app.log.error({error},'Task analyst queue reconciliation failed');}
  try{await reconcileAgentWorkQueue(pool,temporal);}catch(error){app.log.error({error},'Agent work queue reconciliation failed');}
 })();
 reconcile();setInterval(reconcile,12000).unref();}
main().catch(e=>{console.error(e);process.exit(1);});

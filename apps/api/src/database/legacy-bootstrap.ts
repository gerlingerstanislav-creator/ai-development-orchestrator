/**
 * Legacy database bootstrap extracted without changing SQL ordering or startup
 * semantics. This is NOT a versioned migration engine: one-time backfills,
 * startup policies and DDL require classification before migration.
 */
import type {Pool} from 'pg';
import bcrypt from 'bcryptjs';
import {randomUUID} from 'node:crypto';
import {initDocumentationSystem} from '../documentation-system.js';
import {initDocumentationReset} from '../documentation-reset.js';
import {initKnowledgeContext} from '../knowledge-context.js';
import {initKnowledgeWorkflow} from '../knowledge-workflow.js';
import {initKnowledgeDocumentUpdates} from '../knowledge-document-updates.js';

const {hash}=bcrypt;

export async function initializeLegacyDatabase(pool:Pool,workflowStageDescriptions:Record<string,string>,adminEmail:string) {
 await pool.query(`
 CREATE TABLE IF NOT EXISTS users (id uuid primary key, email text unique not null, password_hash text not null);
 CREATE TABLE IF NOT EXISTS auth_sessions (token_hash text primary key, user_id uuid not null references users(id) on delete cascade, expires_at timestamptz not null, created_at timestamptz not null default now());
 CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
 CREATE TABLE IF NOT EXISTS projects (id uuid primary key, name text not null, description text not null default '', owner_id uuid not null references users(id), created_at timestamptz not null default now());
 ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
 -- Every backend rollout requires an explicit per-project resume. This flag is
 -- intentionally distinct from project_ai_settings.enabled (account setup).
 ALTER TABLE projects ADD COLUMN IF NOT EXISTS agents_running boolean NOT NULL DEFAULT false;
 UPDATE projects SET agents_running=false WHERE agents_running=true;
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
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS implementation_kind text NOT NULL DEFAULT 'pr';
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS implementation_commit text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS implementation_evidence jsonb;

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
 ALTER TABLE ai_task_runs ADD COLUMN IF NOT EXISTS result_kind text;
 ALTER TABLE ai_task_runs ADD COLUMN IF NOT EXISTS result_commit text;
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
 const email=adminEmail;
 const password=process.env.ADMIN_PASSWORD;
 if (!email || !password || password.length < 12) throw Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters)');
 if(email==='admin@localhost.test'){
  // In-place migration keeps user ID, password hash, memberships and all owned data.
  await pool.query("UPDATE users SET email=$1 WHERE email='admin@localhost' AND NOT EXISTS (SELECT 1 FROM users WHERE email=$1)",[email]);
 }
 const existing=await pool.query('SELECT id FROM users WHERE email=$1',[email]);
 if (!existing.rowCount) await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[randomUUID(),email,await hash(password,12)]);
}

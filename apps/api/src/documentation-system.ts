import type {Pool} from 'pg';

/** Stable keys are public API. Never regenerate these IDs or rename the five roots. */
export const DOCUMENT_ROOTS=[
 {key:'spec',title:'Техническое задание'},
 {key:'architecture',title:'Архитектура и технические решения'},
 {key:'operations',title:'Запуск и эксплуатация'},
 {key:'design',title:'Дизайн и интерфейсы'},
 {key:'research',title:'Исходные материалы и исследования'}
] as const;

export const documentRootTitle=(key:string)=>DOCUMENT_ROOTS.find(x=>x.key===key)?.title;

/**
 * Online, idempotent migration: adopt exact-name legacy roots in place, then
 * reparent unclassified top-level pages under Research (IDs and descendants stay).
 * A project trigger also seeds new projects in their creation transaction.
 */
export async function initDocumentationSystem(pool:Pool){
 await pool.query(String.raw`
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS source_commit text;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS rebuild_sources jsonb;
 ALTER TABLE document_import_jobs ADD COLUMN IF NOT EXISTS rebuild_plan jsonb;
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS system_key text;
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS import_synced_hash text;
 ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_system_root ON documents(project_id,system_key) WHERE system_key IS NOT NULL;
 ALTER TABLE documents DROP CONSTRAINT IF EXISTS chk_documents_system_key;
 ALTER TABLE documents ADD CONSTRAINT chk_documents_system_key
  CHECK(system_key IS NULL OR system_key IN ('spec','architecture','operations','design','research'));

 CREATE OR REPLACE FUNCTION seed_document_roots(p_project uuid) RETURNS void AS $seed$
 DECLARE r record; existing_id uuid; research_id uuid;
 BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_project::text));
  FOR r IN SELECT * FROM (VALUES
   ('spec','Техническое задание'),
   ('architecture','Архитектура и технические решения'),
   ('operations','Запуск и эксплуатация'),
   ('design','Дизайн и интерфейсы'),
   ('research','Исходные материалы и исследования')
  ) AS roots(root_key,root_title) LOOP
   IF EXISTS(SELECT 1 FROM documents WHERE project_id=p_project AND system_key=r.root_key) THEN CONTINUE; END IF;
   SELECT id INTO existing_id FROM documents
    WHERE project_id=p_project AND parent_id IS NULL AND system_key IS NULL AND title=r.root_title
    ORDER BY updated_at ASC,id ASC LIMIT 1;
   IF existing_id IS NOT NULL THEN
    UPDATE documents SET system_key=r.root_key WHERE id=existing_id;
   ELSE
    INSERT INTO documents(id,project_id,title,body,parent_id,system_key)
     VALUES(gen_random_uuid(),p_project,r.root_title,'',NULL,r.root_key);
   END IF;
   existing_id:=NULL;
  END LOOP;
  SELECT id INTO research_id FROM documents WHERE project_id=p_project AND system_key='research';
  -- Keep old IDs, content, descendants and import_source references.
  -- Only classify clear titles; ambiguous legacy pages stay under Research.
  UPDATE documents AS legacy
   SET parent_id=COALESCE(
    (SELECT system_root.id FROM documents AS system_root
     WHERE system_root.project_id=p_project AND system_root.system_key=
      CASE
       WHEN legacy.title ~* '^(ТЗ([[:space:]:-]|$)|Техническое задание|Требован|Концепц|Критерии при)' THEN 'spec'
       WHEN legacy.title ~* '(Архитектур|Технические решения|Реализованные возможности)' THEN 'architecture'
       WHEN legacy.title ~* '(Запуск|Разв[её]рт|Установк|Эксплуатац|Мониторинг)' THEN 'operations'
       WHEN legacy.title ~* '(Дизайн|Интерфейс|Макет|UI|UX)' THEN 'design'
       ELSE 'research'
      END LIMIT 1),research_id)
   WHERE legacy.project_id=p_project AND legacy.parent_id IS NULL AND legacy.system_key IS NULL;
 END $seed$ LANGUAGE plpgsql;

 SELECT seed_document_roots(id) FROM projects;

 CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique_top_level ON documents(project_id,title)
  WHERE parent_id IS NULL;

 CREATE OR REPLACE FUNCTION seed_new_project_document_roots() RETURNS trigger AS $new_project$
 BEGIN PERFORM seed_document_roots(NEW.id); RETURN NEW; END $new_project$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS trg_seed_project_document_roots ON projects;
 CREATE TRIGGER trg_seed_project_document_roots AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION seed_new_project_document_roots();

 CREATE OR REPLACE FUNCTION guard_document_roots() RETURNS trigger AS $guard$
 DECLARE canonical_title text;
 BEGIN
  IF TG_OP='DELETE' THEN
   IF OLD.system_key IS NOT NULL THEN RAISE EXCEPTION 'Системный раздел документации нельзя удалить' USING ERRCODE='23514'; END IF;
   RETURN OLD;
  END IF;
  IF NEW.system_key IS NOT NULL THEN
   canonical_title:=CASE NEW.system_key
    WHEN 'spec' THEN 'Техническое задание'
    WHEN 'architecture' THEN 'Архитектура и технические решения'
    WHEN 'operations' THEN 'Запуск и эксплуатация'
    WHEN 'design' THEN 'Дизайн и интерфейсы'
    WHEN 'research' THEN 'Исходные материалы и исследования' END;
   IF NEW.title IS DISTINCT FROM canonical_title OR NEW.parent_id IS NOT NULL
    THEN RAISE EXCEPTION 'Некорректный системный раздел документации' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.system_key IS NOT NULL AND (NEW.system_key IS DISTINCT FROM OLD.system_key
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id)
    THEN RAISE EXCEPTION 'Системный раздел документации нельзя переименовать или переместить' USING ERRCODE='23514'; END IF;
   IF OLD.system_key IS NULL AND NEW.system_key IS NOT NULL
    THEN RAISE EXCEPTION 'Нельзя создавать системный раздел через обычное редактирование' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.system_key IS NULL AND NEW.parent_id IS NULL
   THEN RAISE EXCEPTION 'Страницы создаются только внутри системных разделов' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END $guard$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS trg_guard_document_roots ON documents;
 CREATE TRIGGER trg_guard_document_roots BEFORE INSERT OR UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION guard_document_roots();

 CREATE TABLE IF NOT EXISTS document_import_fragments(
  job_id uuid NOT NULL REFERENCES document_import_jobs(id) ON DELETE CASCADE,
  fragment_index int NOT NULL,file_path text NOT NULL,heading text NOT NULL DEFAULT '',
  content_sha text NOT NULL,notes text NOT NULL DEFAULT '',topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclusion_reason text, PRIMARY KEY(job_id,fragment_index)
 );
 CREATE TABLE IF NOT EXISTS document_import_topics(
  job_id uuid NOT NULL REFERENCES document_import_jobs(id) ON DELETE CASCADE,
  topic_key text NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'pending',
  cursor int NOT NULL DEFAULT 0,page_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  draft_body text NOT NULL DEFAULT '',source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_suggestion text,updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,topic_key)
 );
 ALTER TABLE document_import_topics ADD COLUMN IF NOT EXISTS rebuild_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
 CREATE TABLE IF NOT EXISTS document_import_proposals(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES document_import_jobs(id) ON DELETE CASCADE,
  topic_key text NOT NULL,document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title text NOT NULL,proposed_body text NOT NULL,base_hash text NOT NULL,
  status text NOT NULL DEFAULT 'open',created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,UNIQUE(job_id,topic_key)
 );
 CREATE TABLE IF NOT EXISTS documentation_questions(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id uuid REFERENCES document_import_jobs(id) ON DELETE SET NULL,
  topic_key text NOT NULL,question_key text NOT NULL,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  question text NOT NULL,answer text,status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),answered_at timestamptz,
  UNIQUE(project_id,document_id,question_key)
 );
 `);

 await pool.query(String.raw`
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question_key text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question_topic text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question_status text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question_answer text;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question_answered_at timestamptz;
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question_job_id uuid REFERENCES document_import_jobs(id) ON DELETE SET NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_document_questions
  ON tasks(project_id,document_id,question_key) WHERE type='question' AND document_id IS NOT NULL AND question_key IS NOT NULL;
 -- Preserve the original UUIDs: existing Temporal answer jobs reference these IDs.
 INSERT INTO tasks(id,project_id,title,description,type,stage,position,created_at,updated_at,document_id,question_key,question_topic,question_status,question_answer,question_answered_at,question_job_id)
 SELECT q.id,q.project_id,left(q.question,300),q.question,'question','backlog',
  COALESCE((SELECT max(t.position)+1 FROM tasks t WHERE t.project_id=q.project_id),0),
  q.created_at,COALESCE(q.answered_at,q.created_at),q.document_id,q.question_key,q.topic_key,
  q.status,q.answer,q.answered_at,q.job_id
 FROM documentation_questions q
 WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=q.id)
 ON CONFLICT DO NOTHING;
 -- Keep the legacy table only during the upgrade transaction; runtime uses tasks.
 DROP TABLE documentation_questions;
 `);
}

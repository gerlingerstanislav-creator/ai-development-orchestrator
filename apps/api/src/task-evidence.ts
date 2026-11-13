import type {Pool} from 'pg';
import {PENDING_OWNER_QUESTION_SQL} from './task-question-gates.js';

/**
 * Additional execution lane for deliverables that do not modify source code.
 * This is task metadata, not a second Kanban or QA implementation.
 */
export type TaskExecutionMode='code'|'browser_evidence';

export async function installTaskEvidenceSchema(db:Pick<Pool,'query'>){
 await db.query(`
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'code';
 ALTER TABLE tasks ADD COLUMN IF NOT EXISTS evidence_source_sha text;
 ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_execution_mode;
 ALTER TABLE tasks ADD CONSTRAINT chk_tasks_execution_mode
  CHECK(execution_mode IN ('code','browser_evidence'));
 ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_evidence_source_sha;
 ALTER TABLE tasks ADD CONSTRAINT chk_tasks_evidence_source_sha
  CHECK(evidence_source_sha IS NULL OR evidence_source_sha ~ '^[a-fA-F0-9]{40}$');
 CREATE TABLE IF NOT EXISTS task_evidence_runs(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  spec_version integer NOT NULL,
  source_sha text NOT NULL CHECK(source_sha ~ '^[a-fA-F0-9]{40}$'),
  status text NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','dispatching','running','completed','blocked','failed','cancelled')),
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE UNIQUE INDEX IF NOT EXISTS idx_task_evidence_active
 ON task_evidence_runs(task_id) WHERE status IN ('queued','dispatching','running');
 CREATE INDEX IF NOT EXISTS idx_task_evidence_project
 ON task_evidence_runs(project_id,status,created_at);
 -- Applied after v11; never change the historical analysis-first migration.
 CREATE OR REPLACE FUNCTION ado_browser_evidence_guard() RETURNS trigger AS $
 BEGIN
  IF NEW.execution_mode='browser_evidence' AND NEW.stage='testing'
   AND (TG_OP='INSERT' OR OLD.stage IS DISTINCT FROM NEW.stage) THEN
   IF NEW.analysis_state<>'approved' OR NEW.implementation_kind<>'artifact'
     OR NEW.evidence_source_sha IS NULL OR NEW.implementation_commit IS DISTINCT FROM NEW.evidence_source_sha THEN
    RAISE EXCEPTION 'Нет подтверждённого анализа и закреплённого SHA для браузерного исполнения' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=NEW.id AND e.event='analysis_completed')
     OR COALESCE(jsonb_array_length(NEW.clarification_questions),0)>0
     OR EXISTS(SELECT 1 FROM task_agent_notes n WHERE n.project_id=NEW.project_id AND n.task_id=NEW.id
       AND ${PENDING_OWNER_QUESTION_SQL}) THEN
    RAISE EXCEPTION 'Нельзя миновать согласование требований для артефактов' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NEW;
 END;
 $ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS trg_ado_browser_evidence_guard ON tasks;
 CREATE TRIGGER trg_ado_browser_evidence_guard
 BEFORE INSERT OR UPDATE OF stage,execution_mode ON tasks
 FOR EACH ROW EXECUTE FUNCTION ado_browser_evidence_guard();
 `);
}

const shaPattern=/^[a-f0-9]{40}$/i;
export function validEvidenceSha(value:unknown):value is string{
 return typeof value==='string'&&shaPattern.test(value);
}

/** Filename includes viewport captured by real isolated Chromium, not a model claim. */
export function evidenceViewport(name:unknown):{width:number;height:number}|null{
 const match=typeof name==='string'?/^([0-9]{3,4})x([0-9]{3,4})-[a-f0-9-]{36}\.jpg$/i.exec(name):null;
 if(!match)return null;
 const width=Number(match[1]),height=Number(match[2]);
 return width>=240&&width<=2560&&height>=240&&height<=2560?{width,height}:null;
}
export function browserEvidenceAssessment(report:any,sourceSha:string){
 if(!validEvidenceSha(sourceSha)||report?.commit!==sourceSha||report?.executionVerified!==true)
  return {passed:false,reason:'Не подтверждён запуск на закреплённом SHA'};
 if(!Array.isArray(report.caseResults)||!report.caseResults.length||
  report.caseResults.some((result:any)=>result.result!=='passed'))
  return {passed:false,reason:'Не все критерии подтверждены реальными проверками'};
 if(!Array.isArray(report.checks)||!report.checks.length||
  report.checks.some((check:any)=>check.result!=='passed'))
  return {passed:false,reason:'Нет полностью пройденных проверок'};
 const screenshots=Array.isArray(report.screenshots)?report.screenshots:[];
 const dimensions=screenshots.map((shot:any)=>evidenceViewport(shot?.name));
 const desktop=dimensions.some((size:any)=>size&&size.width>=1000);
 const mobile=dimensions.some((size:any)=>size&&size.width<=500);
 if(!desktop||!mobile)return {passed:false,reason:'Нет подлинных desktop и mobile скриншотов, сохранённых Chromium'};
 if(screenshots.some((shot:any)=>shot.mime!=='image/jpeg'||typeof shot.data!=='string'||
  !/^[A-Za-z0-9+/=]+$/.test(shot.data)||Buffer.from(shot.data,'base64').length<100))
  return {passed:false,reason:'Повреждён или не сохранён файл доказательства'};
 return {passed:true,reason:'Подтверждены проверки и изображения desktop/mobile на закреплённом SHA'};
}

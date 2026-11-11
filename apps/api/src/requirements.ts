import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

/**
 * Requirements are the source of truth. The developer cannot silently redefine them;
 * reconciliation produces a human-approvable proposal for any behavioral deviation.
 */
export async function initRequirementsSchema(pool:Pool){
 await pool.query([
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS spec_version integer NOT NULL DEFAULT 1",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS spec_review_status text NOT NULL DEFAULT 'current'",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS spec_reviewed_version integer NOT NULL DEFAULT 1",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS spec_reviewed_commit text NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS spec_review_note text NOT NULL DEFAULT ''",
  "CREATE TABLE IF NOT EXISTS task_spec_versions (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,version integer NOT NULL,title text NOT NULL,description text NOT NULL,origin text NOT NULL,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,version))",
  "INSERT INTO task_spec_versions(id,project_id,task_id,version,title,description,origin) SELECT gen_random_uuid(),project_id,id,spec_version,title,description,'migration' FROM tasks ON CONFLICT(task_id,version) DO NOTHING",
  "CREATE TABLE IF NOT EXISTS task_requirement_reviews (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,spec_version integer NOT NULL,commit_sha text NOT NULL DEFAULT '',classification text NOT NULL,status text NOT NULL,summary text NOT NULL DEFAULT '',proposed_description text NOT NULL DEFAULT '',questions jsonb NOT NULL DEFAULT '[]'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,UNIQUE(task_id,spec_version,commit_sha))",
  "CREATE INDEX IF NOT EXISTS idx_requirement_reviews_task ON task_requirement_reviews(task_id,created_at DESC)",
  "CREATE TABLE IF NOT EXISTS requirement_review_runs (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,spec_version integer NOT NULL,status text NOT NULL DEFAULT 'queued',message text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz)",
  "CREATE INDEX IF NOT EXISTS idx_requirement_runs_project ON requirement_review_runs(project_id,created_at DESC)",
  "ALTER TABLE qa_test_plans ADD COLUMN IF NOT EXISTS spec_version integer NOT NULL DEFAULT 1",
  "ALTER TABLE ai_test_runs ADD COLUMN IF NOT EXISTS qa_spec_version integer",
  "ALTER TABLE ai_test_runs ADD COLUMN IF NOT EXISTS qa_plan_snapshot jsonb",
  "ALTER TABLE ai_test_runs ADD COLUMN IF NOT EXISTS runner_commit_sha text"
 ].join(';\n')+';');
}

export async function saveSpecRevision(client:PoolClient,old:any,data:{title:string;description:string;origin:string;actorId?:string|null;reason?:string;reviewStatus?:'current'|'pending';reviewedCommit?:string}):Promise<number>{
 if(data.title===old.title&&data.description===old.description)return Number(old.spec_version);
 const version=Number(old.spec_version||1)+1;
 const reviewed=data.reviewStatus==='current';
 // Preserve the pre-edit state for new tasks created after the migration.
 await client.query("INSERT INTO task_spec_versions(id,project_id,task_id,version,title,description,origin) VALUES($1,$2,$3,$4,$5,$6,'previous') ON CONFLICT(task_id,version) DO NOTHING",
  [randomUUID(),old.project_id,old.id,Number(old.spec_version||1),old.title,old.description]);
 await client.query("INSERT INTO task_spec_versions(id,project_id,task_id,version,title,description,origin,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(task_id,version) DO NOTHING",
  [randomUUID(),old.project_id,old.id,version,data.title,data.description,data.origin,data.actorId||null,data.reason||'']);
 const update=await client.query("UPDATE tasks SET title=$1,description=$2,spec_version=$3,spec_review_status=$4,spec_reviewed_version=CASE WHEN $5 THEN $3 ELSE spec_reviewed_version END,spec_reviewed_commit=CASE WHEN $5 THEN $6 ELSE '' END,spec_review_note=CASE WHEN $5 THEN $7 ELSE 'Изменение требований ожидает проверки аналитиком' END,updated_at=now() WHERE id=$8 AND project_id=$9 AND spec_version=$10",
 [data.title,data.description,version,reviewed?'current':'pending',reviewed,data.reviewedCommit||'',data.reason||'',old.id,old.project_id,Number(old.spec_version||1)]);
 if(!update.rowCount)throw new Error('Требования уже изменены другим процессом: повтори операцию');
 return version;
}

const analystAnswer=z.object({
 classification:z.enum(['aligned','clarification','material_change','uncertain','qa_validation']),
 summary:z.string().trim().min(5).max(3000),
 proposed_description:z.string().trim().min(5).max(20000),
 questions:z.array(z.string().min(3).max(700)).max(12).default([])
});
export type RequirementReviewResult='current'|'pending'|'needs_approval'|'rejected';

/**
 * A short bounded diff is supporting evidence, never a replacement for approved requirements.
 * Caller supplies live PR head SHA (or empty string if no PR exists).
 */
export async function reconcileTaskRequirements(pool:Pool,args:{projectId:string;taskId:string;commitSha:string;prEvidence:string;developerSummary?:string;taskContext?:string},ask:(prompt:string)=>Promise<string>):Promise<RequirementReviewResult>{
 const {projectId,taskId,commitSha,prEvidence}=args;
 const [task,previous,stage,rules]=await Promise.all([
  pool.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2',[taskId,projectId]),
  pool.query('SELECT version,title,description,origin FROM task_spec_versions WHERE task_id=$1 ORDER BY version DESC LIMIT 4',[taskId]),
  pool.query("SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage='analysis'",[projectId]),
  pool.query('SELECT body FROM project_rules WHERE project_id=$1 ORDER BY created_at LIMIT 35',[projectId])
 ]);
 if(!task.rowCount)throw Error('Не найдена задача для сверки требований');
 const row=task.rows[0];
 const version=Number(row.spec_version||1);
 if(row.spec_review_status==='current'&&Number(row.spec_reviewed_version)===version&&String(row.spec_reviewed_commit||'')===commitSha)return 'current';
 const old=await pool.query('SELECT status FROM task_requirement_reviews WHERE task_id=$1 AND spec_version=$2 AND commit_sha=$3',[taskId,version,commitSha]);
 if(old.rowCount&&old.rows[0].status==='needs_approval')return 'needs_approval';
 if(old.rowCount&&old.rows[0].status==='rejected')return 'rejected';
 const prompt=[
  'Ты независимый системный аналитик, ответственный за актуальность ТЗ на всех этапах разработки.',
  'Сверь УТВЕРЖДЁННОЕ ТЗ, предыдущие версии, сведения разработчика и изменения PR.',
  'НЕ приспосабливай требования под ошибочную реализацию. Изменение пользовательского поведения, API-контрактов, бизнес-правил или прав доступа требует явного согласования.',
  'Если реализация соответствует ТЗ, classification=aligned и proposed_description точно равен текущему ТЗ.',
  'Если нужно только уточнить формулировку БЕЗ изменения ожидаемого поведения, classification=clarification и proposed_description=полное актуализированное ТЗ.',
  'Если изменение поведения или новая трактовка требуют решения пользователя, classification=material_change, proposed_description=предлагаемое ПОЛНОЕ новое ТЗ, а summary объясняет отличие.',
  'Если полного PR diff недостаточно для оценки ФАКТИЧЕСКОГО поведения, а изменения бизнес-требований не обнаружены, classification=qa_validation. Передай конкретные проверки тестировщику, а не спрашивай заказчика о коде, diff, скриншотах или инструментах.',
  'classification=uncertain только когда НЕЯСНЫ именно пользовательские требования, а не фактическая работоспособность программы.',
  'Перед каждым вопросом сверь актуальное ТЗ и ответы в контексте задачи. Не проси повторить известные сведения. Реплики и рабочие комментарии не заменяют согласование изменения ТЗ.',
  'Не заявляй, что визуальная реализация проверена по diff. Визуальные тесты выполняет независимый тестировщик.',
  'Ответь только JSON {"classification":"aligned|clarification|material_change|uncertain|qa_validation","summary":"...","proposed_description":"...","questions":["..."]}.',
  'Агент: '+String(stage.rows[0]?.agent_name||'AI-аналитик'),
  'Инструкции аналитика: '+String(stage.rows[0]?.agent_instructions||'').slice(0,5500),
  'Название задачи: '+row.title,
  'Реплики и рабочие ответы в задаче:\n'+String(args.taskContext||'').slice(0,5200),
  'Актуальная версия ТЗ '+version+':\n'+String(row.description).slice(0,16000),
  'Предыдущие версии: '+JSON.stringify(previous.rows.slice(1)).slice(0,9000),
  'Правила проекта: '+rules.rows.map((x:any)=>x.body).join('\n').slice(0,6500),
  'Разработчик: '+String(args.developerSummary||'Нет отдельного отчёта').slice(0,2400),
  'SHA кода: '+(commitSha||'PR пока отсутствует'),
  'Изменения PR (или отсутствие PR): '+prEvidence.slice(0,17000)
 ].join('\n\n');
 const raw=await ask(prompt);
 const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
 if(first<0||last<=first)throw Error('AI-аналитик не вернул структурированное решение');
 const analysis=analystAnswer.parse(JSON.parse(raw.slice(first,last+1)));
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const locked=await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',[taskId,projectId]);
  if(!locked.rowCount||Number(locked.rows[0].spec_version)!==version){await client.query('ROLLBACK');return 'pending';}
  const current=locked.rows[0];
  if(current.spec_review_status==='current'&&current.spec_reviewed_commit===commitSha){await client.query('COMMIT');return 'current';}
  // Tool requests and missing browser evidence belong to QA. They are not a
  // change of requirements and must not become an unanswerable human gate.
  const toolOnly=analysis.classification==='uncertain'&&commitSha.length>0&&analysis.questions.length>0&&
   analysis.questions.every(q=>/(diff|patch|PR|pull request|скриншот|визуальн|браузер|исходн.{0,12}код|файл)/i.test(q)&&
    /(нуж|не вид|пришл|предостав|доступ|провер|отсутств)/i.test(q));
  if(toolOnly){
   analysis.classification='qa_validation';
   analysis.summary='Сверка требований не выявила предложения изменить ТЗ. Дополнительная проверка фактической реализации передана QA: '+analysis.questions.join('; ').slice(0,1100);
   analysis.questions=[];
  }
  const needsApproval=analysis.classification==='material_change'||analysis.classification==='uncertain';
  const status=needsApproval?'needs_approval':'aligned';
  const reviewId=randomUUID();
  await client.query("INSERT INTO task_requirement_reviews(id,project_id,task_id,spec_version,commit_sha,classification,status,summary,proposed_description,questions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(task_id,spec_version,commit_sha) DO UPDATE SET classification=EXCLUDED.classification,status=EXCLUDED.status,summary=EXCLUDED.summary,proposed_description=EXCLUDED.proposed_description,questions=EXCLUDED.questions",
   [reviewId,projectId,taskId,version,commitSha,analysis.classification,status,analysis.summary,analysis.proposed_description,JSON.stringify(analysis.questions)]);
  if(needsApproval){
   await client.query("UPDATE tasks SET spec_review_status='needs_approval',spec_review_note=$3,updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,projectId,analysis.summary.slice(0,2500)]);
  }else if(analysis.classification==='clarification'&&analysis.proposed_description!==current.description){
   await saveSpecRevision(client,current,{title:current.title,description:analysis.proposed_description,origin:'analyst',reason:analysis.summary,reviewStatus:'current',reviewedCommit:commitSha});
  }else{
   await client.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note=$4,updated_at=now() WHERE id=$1 AND project_id=$2",[taskId,projectId,commitSha,analysis.summary]);
  }
  await client.query("INSERT INTO task_events(id,task_id,event,detail) VALUES($1,$2,$3,$4)",[randomUUID(),taskId,needsApproval?'requirements_proposed':'requirements_reviewed',analysis.summary.slice(0,2500)]);
  await client.query('COMMIT');
  return needsApproval?'needs_approval':'current';
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function requirementState(pool:Pool,projectId:string,taskId:string):Promise<RequirementReviewResult>{
 const state=await pool.query('SELECT spec_version,spec_reviewed_version,spec_review_status FROM tasks WHERE project_id=$1 AND id=$2',[projectId,taskId]);
 if(!state.rowCount)throw Error('Задача не найдена');
 const row=state.rows[0];
 if(row.spec_review_status==='rejected')return 'rejected';
 if(row.spec_review_status==='needs_approval')return 'needs_approval';
 return row.spec_review_status==='current'&&row.spec_version===row.spec_reviewed_version?'current':'pending';
}

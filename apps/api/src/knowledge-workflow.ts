import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

type DB=Pick<Pool,'query'>|Pick<PoolClient,'query'>;
export type KnowledgeStage='analysis'|'development'|'testing'|'documentation'|'manager';
const stages=['analysis','development','testing','documentation','manager'] as const;
const uuid=z.string().uuid();
const status=z.enum(['draft','approved','obsolete']);
const moduleInput=z.object({
 title:z.string().trim().min(3).max(180),
 body:z.string().trim().min(5).max(12000),
 stage:z.enum(stages).nullable().default(null),
 tags:z.array(z.string().trim().min(1).max(60)).max(24).default([]),
 mandatory:z.boolean().default(false),
 status:status.default('draft'),
 priority:z.number().int().min(-100).max(100).default(0)
});
export {moduleInput};

export async function initKnowledgeWorkflow(pool:Pool){
 await pool.query(String.raw`
 CREATE TABLE IF NOT EXISTS knowledge_instruction_modules(
  id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,body text NOT NULL,
  stage text CHECK(stage IS NULL OR stage IN ('analysis','development','testing','documentation','manager')),
  tags text[] NOT NULL DEFAULT '{}',
  mandatory boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','obsolete')),
  priority int NOT NULL DEFAULT 0,revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,title,stage)
 );
 CREATE INDEX IF NOT EXISTS idx_instruction_modules_project ON knowledge_instruction_modules(project_id,stage,status);
 CREATE TABLE IF NOT EXISTS knowledge_task_links(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK(relation IN ('implements','requires','tests','documents','affected_by')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,document_id,task_id,relation)
 );
 CREATE INDEX IF NOT EXISTS idx_knowledge_task_links_task ON knowledge_task_links(project_id,task_id);
 CREATE TABLE IF NOT EXISTS knowledge_artifact_links(
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  artifact_kind text NOT NULL CHECK(artifact_kind IN ('qa_case','pr','component')),
  artifact_ref text NOT NULL,relation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,document_id,artifact_kind,artifact_ref,relation)
 );
 CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_doc ON knowledge_artifact_links(project_id,document_id);
 ALTER TABLE knowledge_context_snapshots ADD COLUMN IF NOT EXISTS process_id uuid;
 ALTER TABLE knowledge_context_reads ADD COLUMN IF NOT EXISTS process_id uuid;
 ALTER TABLE knowledge_context_reads ADD COLUMN IF NOT EXISTS agent_session_id uuid;
 CREATE INDEX IF NOT EXISTS idx_knowledge_reads_process ON knowledge_context_reads(project_id,process_id,created_at);
 `);
}

export type ContextArgs={projectId:string;taskId:string;stage:KnowledgeStage;processId?:string;sessionId?:string;budgetChars?:number;tags?:string[]};
export async function buildKnowledgeContext(db:DB,args:ContextArgs){
 const budget=Math.min(24000,Math.max(1000,args.budgetChars??10000));
 const task=(await db.query('SELECT id,title,description,pr_url FROM tasks WHERE project_id=$1 AND id=$2',[args.projectId,args.taskId])).rows[0];
 if(!task)throw new Error('Задача не найдена в проекте');
 const [rules,stage,modules,docs]=await Promise.all([
  db.query('SELECT id,body FROM project_rules WHERE project_id=$1 ORDER BY created_at',[args.projectId]),
  db.query('SELECT agent_name,agent_instructions FROM workflow_stages WHERE project_id=$1 AND stage=$2',[args.projectId,args.stage]),
  db.query("SELECT id,title,body,tags,mandatory,priority,revision FROM knowledge_instruction_modules WHERE (project_id=$1 OR project_id IS NULL) AND status='approved' AND (stage IS NULL OR stage=$2) ORDER BY mandatory DESC,priority DESC,updated_at DESC",[args.projectId,args.stage]),
  db.query("SELECT d.id,d.title,d.knowledge_summary AS summary,d.updated_at AS version,d.knowledge_key,COUNT(l.id)::int AS task_links,ts_rank_cd(to_tsvector('simple',d.title||' '||d.body),plainto_tsquery('simple',$3)) AS relevance FROM documents d LEFT JOIN knowledge_task_links l ON l.document_id=d.id AND l.project_id=$1 AND l.task_id=$2 WHERE d.project_id=$1 AND d.knowledge_status='approved' AND (l.id IS NOT NULL OR to_tsvector('simple',d.title||' '||d.body) @@ plainto_tsquery('simple',$3) OR d.title ILIKE '%'||$3||'%') GROUP BY d.id ORDER BY task_links DESC,relevance DESC,d.updated_at DESC LIMIT 30",[args.projectId,args.taskId,task.title])
 ]);
 const explicitTags=new Set((args.tags||[]).map(t=>t.trim().toLowerCase()));
 const matched=modules.rows.filter(row=>row.mandatory || !row.tags?.length || row.tags.some((t:string)=>explicitTags.has(t.toLowerCase())));
 const instructions={
  agent:stage.rows[0]||null,
  mandatory_rules:rules.rows,
  modules:matched.map(row=>({id:row.id,title:row.title,body:row.body,revision:row.revision,mandatory:row.mandatory}))
 };
 // Never silently truncate mandatory policy. The budget constrains optional context only.
 const requiredSize=JSON.stringify(instructions).length;
 const available=Math.max(0,budget-requiredSize);
 let used=0;
 const sources:{id:string;title:string;summary:string;version:string;reason:string}[]=[];
 for(const doc of docs.rows){
  const entry={id:doc.id,title:doc.title,summary:String(doc.summary||'').slice(0,320),version:new Date(doc.version).toISOString(),reason:doc.task_links?'Прямая связь с задачей':'Совпадение по тексту'};
  const size=JSON.stringify(entry).length;
  if(used+size>available)continue;
  sources.push(entry);used+=size;
  if(sources.length>=12)break;
 }
 const snapshotId=randomUUID();
 await db.query('INSERT INTO knowledge_context_snapshots(id,project_id,task_id,agent_stage,agent_session_id,process_id,sources,instructions) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
  [snapshotId,args.projectId,args.taskId,args.stage,args.sessionId||null,args.processId||null,JSON.stringify(sources),JSON.stringify(instructions)]);
 return {snapshot_id:snapshotId,task:{id:task.id,title:task.title,description:String(task.description||'').slice(0,12000)},stage:args.stage,instructions,documents:sources,budget:{limit:budget,mandatory_chars:requiredSize,selected_chars:used},hint:'Используй knowledge.search и knowledge.read для дополнительных разделов. Сначала проверяй связанные требования. Не принимай черновики за утверждённое ТЗ.'};
}

export function instructionApiSchemas(){
 return {uuid,moduleInput};
}

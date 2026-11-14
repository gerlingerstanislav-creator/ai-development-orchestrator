import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

type Db=Pick<Pool,'query'>;
const error=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});

/** Immutable, source-pinned artifacts produced by the trusted browser bridge.
 * Data is private to the project; no public filesystem path is exposed.
 */
export async function installWorkArtifactsSchema(db:Db){
 await db.query(`CREATE TABLE IF NOT EXISTS agent_work_artifacts(
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES agent_work_assignments(id) ON DELETE CASCADE,
  source_sha char(40) NOT NULL,
  sha256 char(64) NOT NULL,
  name text NOT NULL,
  mime text NOT NULL CHECK(mime='image/jpeg'),
  viewport jsonb NOT NULL,
  origin text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(assignment_id,sha256)
 );
 CREATE INDEX IF NOT EXISTS idx_agent_work_artifacts_task
  ON agent_work_artifacts(project_id,task_id,created_at DESC);`);
}
export type WorkArtifactInput={
 projectId:string;taskId:string;assignmentId:string;sourceSha:string;
 name:string;sha256:string;mime:string;viewport:{width:number;height:number};
 origin:string;data:string;
};
export function validateWorkArtifact(input:WorkArtifactInput){
 if(!/^[a-f0-9]{40}$/i.test(input.sourceSha)||!/^[a-f0-9]{64}$/i.test(input.sha256))
  throw error('Некорректные контрольные суммы артефакта',400);
 if(!/^[0-9]{3,4}x[0-9]{3,4}-[a-f0-9-]{36}\.jpg$/i.test(input.name))
  throw error('Имя браузерного артефакта не подтверждено',400);
 if(input.mime!=='image/jpeg'||input.origin!=='isolated-local-browser')
  throw error('Источник изображения не является доверенной браузерной средой',400);
 if(!Number.isInteger(input.viewport?.width)||!Number.isInteger(input.viewport?.height)||
   input.viewport.width<320||input.viewport.width>4000||input.viewport.height<240||input.viewport.height>4000)
  throw error('Некорректный viewport',400);
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)||input.data.length>450000)
  throw error('Недопустимый размер изображения',400);
 const bytes=Buffer.from(input.data,'base64');
 if(bytes.length<100||bytes.length>320000||bytes[0]!==255||bytes[1]!==216||
    bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)
  throw error('Нет подтверждённых JPEG-данных',400);
 if(createHash('sha256').update(bytes).digest('hex')!==input.sha256.toLowerCase())
  throw error('Данные изображения не совпадают с SHA256',400);
 return bytes;
}
export async function storeWorkArtifact(db:Db,input:WorkArtifactInput){
 const bytes=validateWorkArtifact(input),id=randomUUID();
 const inserted=await db.query(`INSERT INTO agent_work_artifacts
  (id,project_id,task_id,assignment_id,source_sha,sha256,name,mime,viewport,origin,data)
  SELECT $1,a.project_id,a.task_id,a.id,$5,$6,$7,'image/jpeg',$8::jsonb,$9,$10
   FROM agent_work_assignments a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
   WHERE a.id=$4 AND a.project_id=$2 AND a.task_id=$3 AND a.status IN ('running','submitted')
    AND t.spec_version=a.spec_version AND t.stage<>'done'
    AND (SELECT count(*) FROM agent_work_artifacts WHERE assignment_id=a.id)<10
  ON CONFLICT(assignment_id,sha256) DO NOTHING RETURNING id`,
  [id,input.projectId,input.taskId,input.assignmentId,input.sourceSha.toLowerCase(),input.sha256.toLowerCase(),
   input.name,JSON.stringify(input.viewport),input.origin,bytes]);
 if(!inserted.rowCount){
  const old=await db.query('SELECT id FROM agent_work_artifacts WHERE assignment_id=$1 AND sha256=$2',
   [input.assignmentId,input.sha256.toLowerCase()]);
  if(!old.rowCount)throw error('Поручение завершено или лимит артефактов достигнут');
  return {id:old.rows[0].id,duplicate:true};
 }
 return {id,duplicate:false};
}
export async function listWorkArtifacts(db:Db,projectId:string,taskId:string){
 const r=await db.query(`SELECT a.id,a.assignment_id,a.source_sha,a.sha256,a.name,
   a.mime,a.viewport,a.origin,a.created_at
  FROM agent_work_artifacts a WHERE a.project_id=$1 AND a.task_id=$2
  ORDER BY a.created_at DESC LIMIT 100`,[projectId,taskId]);
 return {artifacts:r.rows.map(a=>({...a,url:'/api/projects/'+projectId+'/tasks/'+taskId+'/work-artifacts/'+a.id}))};
}

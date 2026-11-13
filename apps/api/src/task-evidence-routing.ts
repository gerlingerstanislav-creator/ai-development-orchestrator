import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {validEvidenceSha} from './task-evidence.js';
import {PENDING_OWNER_QUESTION_SQL} from './task-question-gates.js';

type Db=Pick<Pool,'query'>;
const failure=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});

/** Reclassify previously analyzed, unfinished work without inventing a PR.
 * Requires a directly confirmed source SHA; all mutations are caller-transactional.
 */
export async function routeTaskToBrowserEvidence(db:Db,args:{
 projectId:string;taskId:string;actorId:string;sourceSha:string;reason:string
}){
 const {projectId,taskId,actorId,sourceSha}=args;
 if(!validEvidenceSha(sourceSha))throw failure('Укажи полный проверяемый commit SHA',400);
 if(args.reason.trim().length<12)throw failure('Укажи обоснование изменения маршрута',400);
 const task=(await db.query(`SELECT id,title,description,stage,type,analysis_state,spec_version,pr_url,
  implementation_kind,execution_mode FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE`,
 [taskId,projectId])).rows[0];
 if(!task)throw failure('Задача не найдена',404);
 if(!['task','bug','improvement'].includes(task.type)||!['analysis','development','testing'].includes(task.stage)||
   task.pr_url||task.implementation_kind==='code_changed')
  throw failure('Нельзя менять маршрут после реальных изменений с PR либо завершения задачи');
 if(task.stage==='analysis'||task.analysis_state!=='approved')
  throw failure('Сначала требуется завершить анализ задачи');
 if(!String(task.description||'').toLowerCase().includes(sourceSha.toLowerCase())&&
  !(await db.query("SELECT 1 FROM assistant_messages WHERE project_id=$1 AND task_id=$2 AND role='user' AND body ILIKE $3 LIMIT 1",
    [projectId,taskId,'%'+sourceSha+'%'])).rowCount)
  throw failure('Закреплённый SHA отсутствует в проверенных исходных требованиях или сообщениях владельца');
 if(!(await db.query("SELECT 1 FROM task_events WHERE task_id=$1 AND event='analysis_completed' LIMIT 1",[taskId])).rowCount)
  throw failure('Отсутствует подтверждённый результат аналитика');
 if((await db.query(`SELECT 1 FROM task_agent_notes n WHERE n.project_id=$1 AND n.task_id=$2 AND ${PENDING_OWNER_QUESTION_SQL} LIMIT 1`,[projectId,taskId])).rowCount)
  throw failure('Есть открытые вопросы владельцу');
 if((await db.query("SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND state='active' LIMIT 1",[taskId])).rowCount||
    (await db.query("SELECT 1 FROM ai_task_runs WHERE task_id=$1 AND status IN ('queued','running') LIMIT 1",[taskId])).rowCount||
    (await db.query("SELECT 1 FROM ai_test_runs WHERE task_id=$1 AND status IN ('queued','running') LIMIT 1",[taskId])).rowCount)
  throw failure('Предыдущий исполнитель ещё активен. Заверши или останови процесс штатно.');
 await db.query("UPDATE iteration_execution_queue SET status='stale',detail='Задача переведена в исполнение артефактов без разработки',updated_at=now() WHERE task_id=$1 AND project_id=$2 AND status IN ('queued','dispatching')",[taskId,projectId]);
 const changed=await db.query(`UPDATE tasks
  SET stage='testing',execution_mode='browser_evidence',evidence_source_sha=$3,
   implementation_kind='artifact',implementation_commit=$3,test_feedback=NULL,updated_at=now()
  WHERE id=$1 AND project_id=$2 AND stage IN ('development','testing') AND pr_url IS NULL
  RETURNING id,stage,execution_mode,evidence_source_sha`,[taskId,projectId,sourceSha.toLowerCase()]);
 if(!changed.rowCount)throw failure('Маршрут задачи изменился до сохранения');
 await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'execution_routed',$4)",
  [randomUUID(),taskId,actorId,'Без изменения кода и PR; источник '+sourceSha+'. '+args.reason.slice(0,1200)]);
 return {...changed.rows[0],status:'queued',message:'Задача ожидает браузерного исполнителя и независимой проверки'};
}

export async function retryTaskBrowserEvidence(db:Db,args:{projectId:string;taskId:string;actorId:string;reason:string}){
 if(args.reason.trim().length<12)throw failure('Укажи причину повторной проверки',400);
 const task=(await db.query(`SELECT id,stage,execution_mode,implementation_kind,evidence_source_sha,spec_version
  FROM tasks WHERE id=$1 AND project_id=$2 FOR UPDATE`,[args.taskId,args.projectId])).rows[0];
 if(!task)throw failure('Задача не найдена',404);
 if(task.stage!=='testing'||task.execution_mode!=='browser_evidence'||task.implementation_kind!=='artifact'||
  !validEvidenceSha(task.evidence_source_sha))throw failure('Нет незавершённой задачи для браузерной проверки');
 if((await db.query("SELECT 1 FROM task_orchestration_owners WHERE task_id=$1 AND state='active' LIMIT 1",[args.taskId])).rowCount||
   (await db.query("SELECT 1 FROM task_evidence_runs WHERE task_id=$1 AND status IN ('queued','dispatching','running') LIMIT 1",[args.taskId])).rowCount)
  throw failure('Браузерный процесс ещё выполняется');
 const prior=await db.query("SELECT id,status FROM task_evidence_runs WHERE task_id=$1 AND spec_version=$2 AND source_sha=$3 ORDER BY created_at DESC LIMIT 1",
  [args.taskId,task.spec_version,task.evidence_source_sha]);
 if(!prior.rowCount||!['blocked','failed','cancelled'].includes(prior.rows[0].status))
  throw failure('Нет завершённой с блокировкой попытки для повтора');
 const id=randomUUID();
 await db.query("INSERT INTO task_evidence_runs(id,project_id,task_id,spec_version,source_sha,status,message) VALUES($1,$2,$3,$4,$5,'queued',$6)",
  [id,args.projectId,args.taskId,task.spec_version,task.evidence_source_sha,'Повтор после устранения блокировки: '+args.reason.slice(0,600)]);
 await db.query("INSERT INTO task_events(id,task_id,actor_id,event,detail) VALUES($1,$2,$3,'evidence_retry',$4)",
  [randomUUID(),args.taskId,args.actorId,args.reason.slice(0,1000)]);
 return {run_id:id,status:'queued'};
}

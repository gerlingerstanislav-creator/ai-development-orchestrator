import type {Pool} from 'pg';
import {roleCapacity} from '../../../project-team.js';

type Db=Pick<Pool,'query'>;
/** Configuration is not proof that the agent can use an external environment.
 * Dispatch capacity is a snapshot; the Runner verifies browser and checkout
 * availability on every actual execution attempt.
 */
export async function readAgentCapabilityReadiness(db:Db,projectId:string,role:string){
 const [project,capacity]=await Promise.all([
  db.query(`SELECT p.agents_running,
   EXISTS(SELECT 1 FROM project_git_repositories g
    JOIN connections c ON c.id=g.connection_id
    WHERE g.project_id=p.id AND c.provider='github_token'
      AND length(COALESCE(c.secret_encrypted,''))>0) AS github_configured,
   (SELECT count(*)::int FROM agent_work_assignments a WHERE a.project_id=p.id
    AND a.role=$2 AND a.status='running') AS running_assignments,
   (SELECT count(*)::int FROM agent_work_assignments a WHERE a.project_id=p.id
    AND a.role=$2 AND a.status='queued') AS queued_assignments,
   (SELECT count(*)::int FROM agent_peer_queue q WHERE q.project_id=p.id
    AND q.role=$2 AND q.status='running') AS running_consultations
   FROM projects p WHERE p.id=$1 AND p.deleted_at IS NULL`,[projectId,role]),
  roleCapacity(db,projectId,role)
 ]);
 if(!project.rowCount)throw Object.assign(Error('Проект недоступен'),{statusCode:404});
 const row=project.rows[0];
 const active=Number(row.running_assignments||0)+Number(row.running_consultations||0);
 const maxConcurrent=Math.max(1,Number(capacity)||1);
 const dispatchSlots=Math.max(0,maxConcurrent-active);
 const agentsEnabled=row.agents_running===true;
 const githubConfigured=row.github_configured===true;
 return {
  agents_enabled:agentsEnabled,
  github_configured:githubConfigured,
  running_assignments:Number(row.running_assignments)||0,
  queued_assignments:Number(row.queued_assignments)||0,
  running_consultations:Number(row.running_consultations)||0,
  max_concurrent:maxConcurrent,
  dispatch_slots:dispatchSlots,
  scheduling_capacity_available:agentsEnabled&&dispatchSlots>0,
  environment:{
   project_source:githubConfigured?'configured_not_verified':'not_configured',
   isolated_browser:'unverified_until_runtime_probe',
   external_environment:'unverified_until_runtime_probe'
  },
  limitations:[
   ...(!agentsEnabled?['Агенты проекта остановлены']:[]),
   ...(!githubConfigured?['GitHub-источник не настроен; не утверждай, что работающий сайт доступен']:[]),
   ...(dispatchSlots===0?['Роль занята; работу можно поставить в очередь']:[]),
   'Наличие скриншотов или доступа к сайту подтверждается только результатом реального исполнения'
  ]
 };
}

import {composeAgentPrompt,recordAgentPrompt} from '../../../agent-prompt.js';
import {resolveRoleAiSettings} from '../../../project-team.js';
import {agentMemorySections} from '../../../agent-memory.js';
import {readTaskWorkBrief} from '../../../task-work-brief.js';
import type {RunnerImage} from '../../../chat-images.js';
import type {AgentReaderScope} from '../../../agent-tools.js';

type Db=Parameters<typeof recordAgentPrompt>[0];
type AskAssistant=(
 prompt:string,projectId:string,taskId:string|null,operation:string,
 ai:{model:string;reasoning:string},timeoutMs:number,images:RunnerImage[],
 reader?:Omit<AgentReaderScope,'projectId'|'taskId'>
)=>Promise<string>;

export type DelegatedSandboxItem={
 project_id:string;task_id:string|null;goal_id?:string|null;role:string;project_owner_id:string;
 task_description?:string|null;evidence_source_sha?:string|null;implementation_commit?:string|null;
};
type ExecuteSandbox=(item:DelegatedSandboxItem,assignmentId:string,prompt:string,
 ai:{model:string;reasoning:string})=>Promise<string>;

/** Temporal only dispatches this application activity.
 * The role selects tools and owns report evidence; a successful model reply
 * never implies that the scoped work.report operation succeeded.
 */
export function createDelegatedWorkActivities({
 pool,askRunnerAssistant,executeSandbox,resolveSettings=resolveRoleAiSettings,
 readMemory=agentMemorySections,readBrief=readTaskWorkBrief,
 recordPrompt=recordAgentPrompt,finalize
}:{
 pool:Db;
 askRunnerAssistant:AskAssistant;
 executeSandbox?:ExecuteSandbox;
 resolveSettings?:typeof resolveRoleAiSettings;
 readMemory?:typeof agentMemorySections;
 readBrief?:typeof readTaskWorkBrief;
 recordPrompt?:typeof recordAgentPrompt;
 finalize:(db:Db,id:string,reason:string)=>Promise<unknown>;
}){
async function runDelegatedWork(assignmentId:string):Promise<void>{
 const r=await pool.query(`SELECT a.*,COALESCE(t.title,g.objective) AS title,t.description AS task_description,t.stage,
  t.evidence_source_sha,t.implementation_commit,
  t.spec_version AS current_spec,g.status AS goal_status,p.agents_running,p.owner_id AS project_owner_id
  FROM agent_work_assignments a LEFT JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
  LEFT JOIN project_pm_goals g ON g.id=a.goal_id AND g.project_id=a.project_id
  JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL
  WHERE a.id=$1 AND a.status='running'`,[assignmentId]);
 if(!r.rowCount)return;
 const item=r.rows[0];
 if(!item.agents_running||
   (item.task_id&&(item.stage==='done'||item.spec_version!==item.current_spec))||
   (item.goal_id&&item.goal_status==='completed')){
  await finalize(pool,assignmentId,'Поручение потеряло актуальность или агенты проекта остановлены');
  return;
 }
 const config=(await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[item.project_id])).rows[0];
 if(!config?.enabled){
  await finalize(pool,assignmentId,'AI отключён в проекте');
  return;
 }
 const roleSettings=await resolveSettings(pool,item.project_id,item.role,config);
 const instruction=await pool.query(`SELECT agent_instructions FROM workflow_stages
   WHERE project_id=$1 AND stage=$2
   UNION ALL SELECT agent_instructions FROM project_specialist_agents
   WHERE project_id=$1 AND role=$2 LIMIT 1`,[item.project_id,item.role]);
 // Stable role knowledge and per-task state have different lifetimes. Only
 // approved, applicable instructions have authority; observations are data.
 const memory=await readMemory(pool,item.project_id,item.role,
  [item.title,item.objective,item.task_description].filter(Boolean).join(' '),
  {instructions:1000,observations:500});
 const brief=item.task_id
  ?await readBrief(pool,item.project_id,item.task_id,1400):'';
 const prompt=composeAgentPrompt({
  role:'Исполнитель поручения: '+item.role,
  objective:item.objective+'\nКритерии приёмки: '+item.acceptance,
  scope:'Проект '+item.project_id+'; '+(item.task_id?'задача '+item.task_id:'цель ПМ '+item.goal_id)+'; поручение '+assignmentId,
  tools:'MCP capabilities.list/describe, tasks.read/history, goals.read, knowledge.search/section, agents.consult, work.delegate, work.artifacts и work.report. Команды выполняй только в разрешённом sandbox; наличие браузера проверь фактически.',
  instructions:[String(instruction.rows[0]?.agent_instructions||''),
   memory.instructions?'Утверждённые применимые инструкции специалиста:\n'+memory.instructions:''
  ].filter(Boolean).join('\n'),
  continuation:[
   'Дополнительные права только данного поручения: '+JSON.stringify(item.granted_tools||[])+'.',
   'Сначала получи актуальные факты через tasks.read либо goals.read; прежний текст может устареть.',
   'Для необходимой помощи используй work.delegate; ожидание чужой работы не является результатом.',
   'При недостающем доступе назови точный блокер через work.report(status=blocked); PM может расширить безопасные права через work.grant.',
   'Подтверждай браузерные результаты через work.artifacts и фактический SHA. Локальный снимок не считай снимком production.',
   'После действий обязательно вызови MCP work.report(status=submitted,evidence=...) с реальными доказательствами. Текст ответа сам по себе не завершает поручение.'
  ].join('\n'),
  context:[
   'Срез постановки (перепроверь через MCP): '+item.title+'; '+String(item.task_description||'').slice(0,1600),
   brief?'Состояние и новые замечания этой задачи:\n'+brief:'',
   memory.observations?'Наблюдения из опыта (не обязательные инструкции):\n'+memory.observations:''
  ].filter(Boolean).join('\n\n'),
  output:'Кратко сообщи, что действительно сделано, приложи ссылки и идентификаторы. work.report — обязательное подтверждение; при отсутствии доказательств отчитайся о блокировке, а не об успехе.'
 });
 await recordPrompt(pool,{projectId:item.project_id,processId:assignmentId,role:item.role,operation:'delegated_work',prompt}).catch(()=>{});
 try{
  const output=executeSandbox
   ?await executeSandbox(item,assignmentId,prompt,roleSettings)
   :await askRunnerAssistant(prompt,item.project_id,item.task_id,'delegated_work',roleSettings,195000,[],
     {role:item.role,processId:assignmentId});
  // A message is not evidence of execution; only the scoped work.report tool moves status.
  await finalize(pool,assignmentId,'Агент завершил сессию без подтверждённого результата через work.report. '+String(output).slice(0,850));
 }catch(error){
  await finalize(pool,assignmentId,'Сбой исполнителя: '+String(error).slice(0,1200));
 }
}
async function failDelegatedWork(assignmentId:string,message:string){
 await finalize(pool,assignmentId,'Ошибка Temporal: '+message);
}

 return {runDelegatedWork,failDelegatedWork};
}

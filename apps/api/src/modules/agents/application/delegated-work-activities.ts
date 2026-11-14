import {composeAgentPrompt,recordAgentPrompt} from '../../../agent-prompt.js';
import {resolveRoleAiSettings} from '../../../project-team.js';
import type {RunnerImage} from '../../../chat-images.js';
import type {AgentReaderScope} from '../../../agent-tools.js';

type Db=Parameters<typeof recordAgentPrompt>[0];
type AskAssistant=(
 prompt:string,projectId:string,taskId:string|null,operation:string,
 ai:{model:string;reasoning:string},timeoutMs:number,images:RunnerImage[],
 reader?:Omit<AgentReaderScope,'projectId'|'taskId'>
)=>Promise<string>;

/** Temporal only dispatches this application activity.
 * The role selects tools and owns report evidence; a successful model reply
 * never implies that the scoped work.report operation succeeded.
 */
export function createDelegatedWorkActivities({
 pool,askRunnerAssistant,resolveSettings=resolveRoleAiSettings,
 recordPrompt=recordAgentPrompt,finalize
}:{
 pool:Db;
 askRunnerAssistant:AskAssistant;
 resolveSettings?:typeof resolveRoleAiSettings;
 recordPrompt?:typeof recordAgentPrompt;
 finalize:(db:Db,id:string,reason:string)=>Promise<unknown>;
}){
async function runDelegatedWork(assignmentId:string):Promise<void>{
 const r=await pool.query(`SELECT a.*,t.title,t.description AS task_description,t.stage,
  t.spec_version AS current_spec,p.agents_running
  FROM agent_work_assignments a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
  JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL
  WHERE a.id=$1 AND a.status='running'`,[assignmentId]);
 if(!r.rowCount)return;
 const item=r.rows[0];
 if(!item.agents_running||item.stage==='done'||item.spec_version!==item.current_spec){
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
 const prompt=composeAgentPrompt({
  role:'Исполнитель поручения: '+item.role,
  objective:item.objective,
  scope:'Проект '+item.project_id+'; задача '+item.task_id+'; поручение '+assignmentId,
  tools:'Используй MCP capabilities.list/describe, agents.capabilities, tasks.read/history, project.source, agents.consult, work.delegate и реальные доступные инструменты. Никаких вымышленных скриншотов, тестов, PR и деплоя.',
  instructions:String(instruction.rows[0]?.agent_instructions||''),
  continuation:[
   'Критерии приёмки: '+item.acceptance,
   'Дополнительные права именно этого поручения: '+JSON.stringify(item.granted_tools||[])+'. Они не гарантируют наличие внешней среды; проверяй результат инструментом.',
   'ТЗ и задача: '+item.title+'; '+String(item.task_description).slice(0,5000),
   'Ищи доступные инструменты и зависимости по смыслу результата, не по названию задачи.',
   'Если недостаёт безопасного инструмента, отчитайся work.report(status=blocked) и назови точное имя из agents.capabilities: ПМ может выдать право через work.grant, не создавая новую задачу.',
   'Если нужны действия другого специалиста, используй work.delegate и сообщи о зависимости через work.report(status=blocked); не выдавай ожидание за завершение.',
   'После реальных действий зафиксируй результат и конкретные ссылки/ID/артефакты инструментом work.report(status=submitted,evidence=...).',
   'Если фактические доказательства отсутствуют, вызови work.report(status=blocked) с причиной и необходимыми условиями.',
   'Только успешное применение work.report является статусом поручения. Простой текст ответа не завершает поручение.'
  ].join('\\n'),
  output:'Кратко объясни выполненные действия и фактические результаты; обязательно вызови work.report через MCP. Не утверждай успех без подтверждения инструмента.'
 });
 await recordPrompt(pool,{projectId:item.project_id,processId:assignmentId,role:item.role,operation:'delegated_work',prompt}).catch(()=>{});
 try{
  const output=await askRunnerAssistant(prompt,item.project_id,item.task_id,'delegated_work',roleSettings,195000,[],
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

import {composeAgentPrompt} from '../../../agent-prompt.js';

type QueryResult={rows:any[];rowCount:number|null};
type Database={query:(sql:string,args?:any[])=>Promise<QueryResult>};
export type QaPlanArgs={projectId:string;taskId:string;runId:string;simplified?:boolean};
export type QaPlanEvidence={commitSha:string;patch:string;summary:string};
export type QaPlanAiSettings={model:string;reasoning:string;enabled:boolean};

/** Explicit ports keep Temporal, PostgreSQL setup, GitHub and Runner transport
 * outside the QA plan use case. The worker keeps the original Activity export.
 */
export type QaPlanPorts={
 pool:Database;
 failNonRetryable:(message:string)=>Error;
 event:(projectId:string,runId:string,kind:string,stage:string,detail:string,level?:string)=>Promise<void>;
 recordActivity:(projectId:string,taskIds:string[],runId:string,kind:string,status:string,message:string)=>Promise<unknown>;
 pendingQuestions:(projectId:string,taskId:string)=>Promise<boolean>;
 prEvidence:(projectId:string,taskId:string)=>Promise<QaPlanEvidence>;
 loadKnowledge:(projectId:string,taskId:string,runId:string)=>Promise<{documents:string;modules:string}>;
 taskHandoffContext:(projectId:string,taskId:string,stage:string)=>Promise<string>;
 prepareDocumentation:(args:QaPlanArgs & {implementationEvidence:string},ask:(prompt:string)=>Promise<string>)=>Promise<number>;
 recordPrompt:(entry:{projectId:string;processId:string;role:string;operation:string;prompt:string})=>Promise<unknown>;
 askQaAgent:(prompt:string,projectId:string,taskId:string,ai:QaPlanAiSettings,runId:string)=>Promise<string>;
 recordNote:(entry:{projectId:string;taskId:string;authorStage:'testing';authorName:string;targetStage:'all';kind:'observation';body:string;sourceKey:string;sourceRunId:string})=>Promise<unknown>;
};

export function createQaPlanActivity({
 pool,failNonRetryable,event,recordActivity,pendingQuestions,prEvidence,loadKnowledge,
 taskHandoffContext,prepareDocumentation,recordPrompt,askQaAgent,recordNote
}:QaPlanPorts){
async function prepareQaPlan(args:{projectId:string;taskId:string;runId:string;simplified?:boolean}):Promise<number>{
 const {projectId,taskId,runId}=args;
 const settings=await pool.query('SELECT model,reasoning,enabled FROM project_ai_settings WHERE project_id=$1',[projectId]);
 const ai=settings.rows[0];
 if(!ai?.enabled)throw failNonRetryable('AI отключён для проекта');
 await pool.query("UPDATE requirement_review_runs SET status='running',message='QA-агент формирует тест-кейсы',completed_at=NULL WHERE id=$1 AND project_id=$2",[runId,projectId]);
 await event(projectId,runId,'testing','test_design_started','AI-тестировщик формирует тесты по актуализированному ТЗ перед проверкой PR');
 await recordActivity(projectId,[taskId],runId,'qa_design','running','Тестировщик готовит сценарии проверки.');
 try{
  if(!args.simplified&&await pendingQuestions(projectId,taskId))throw new Error('Нельзя готовить тестирование: вопросы участников процесса остались без ответа');
  const evidence=await prEvidence(projectId,taskId);
  if(!evidence.commitSha)throw new Error('Нет коммита PR для тестирования');
  if(args.simplified){
   await pool.query("UPDATE tasks SET spec_review_status='current',spec_reviewed_version=spec_version,spec_reviewed_commit=$3,spec_review_note='' WHERE id=$1 AND project_id=$2 AND stage='testing'",[taskId,projectId,evidence.commitSha]);
  }else{
   const current=await pool.query("SELECT spec_reviewed_commit,spec_review_status FROM tasks WHERE id=$1 AND project_id=$2",[taskId,projectId]);
   if(current.rows[0]?.spec_review_status!=='current'||current.rows[0].spec_reviewed_commit!==evidence.commitSha)
    throw new Error('Код PR изменился после сверки аналитиком. Требуется повторная проверка требований.');
  }
  const qaKnowledge=await loadKnowledge(projectId,taskId,runId);
  const handoff=await taskHandoffContext(projectId,taskId,'testing');
  const count=await prepareDocumentation({...args,implementationEvidence:evidence.patch},async(prompt)=>{
   const taskContext='\n\nПеред вопросом о требованиях проверь ответы в задаче. Переписка не подтверждает прохождение теста.\n'+handoff;
   const bounded=composeAgentPrompt({
    role:'QA-инженер — проектирование проверок',
    objective:prompt,
    tools:'Только составление тест-кейсов; выполнение тестов позже выполняет Codex в изолированном runner.',
    context:taskContext.slice(0,2300)+'\n'+qaKnowledge.documents.slice(0,700),
    instructions:qaKnowledge.modules.slice(0,900)
   });
   await recordPrompt({projectId,processId:runId,role:'testing',operation:'qa_plan',prompt:bounded}).catch(()=>{});
   return askQaAgent(bounded,projectId,taskId,ai,runId);
  });
  // Derived links attach the actual current QA plan to the requirements governing the task.
  await pool.query("INSERT INTO knowledge_artifact_links(id,project_id,document_id,artifact_kind,artifact_ref,relation) SELECT gen_random_uuid(),$1,l.document_id,'qa_case',pc.case_id::text,'tested_by' FROM knowledge_task_links l JOIN qa_test_plans p ON p.project_id=l.project_id AND p.task_id=l.task_id JOIN qa_plan_cases pc ON pc.plan_id=p.id WHERE l.project_id=$1 AND l.task_id=$2 AND l.relation IN ('requires','implements','tests') ON CONFLICT DO NOTHING",[projectId,taskId]);
  await pool.query("UPDATE requirement_review_runs SET status='completed',message=$2,completed_at=now() WHERE id=$1 AND project_id=$3",[runId,'QA-документация подготовлена: '+count+' проверок',projectId]);
  await recordNote({projectId,taskId,authorStage:'testing',authorName:'AI-тестировщик',targetStage:'all',kind:'observation',body:'Подготовлен план тестирования по актуальному ТЗ: '+count+' проверок. Фактические результаты будут записаны после выполнения, это не подтверждение прохождения тестов.',sourceKey:'test-plan:'+runId,sourceRunId:runId});
  await event(projectId,runId,'testing','test_design_ready','QA-документация подготовлена: '+count+' проверок');
  await recordActivity(projectId,[taskId],runId,'qa_design','completed','Подготовлено проверок: '+count+'.');
  return count;
 }catch(e){
  await pool.query("UPDATE requirement_review_runs SET status='failed',message=$2,completed_at=now() WHERE id=$1 AND project_id=$3",[runId,String(e).slice(0,1800),projectId]);
  await event(projectId,runId,'testing','test_design_failed',String(e).slice(0,1900),'error');
  await recordActivity(projectId,[taskId],runId,'qa_design','failed',String(e));
  throw e;
 }
}
 return prepareQaPlan;
}

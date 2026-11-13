import {patched,proxyActivities,sleep,startChild,ParentClosePolicy} from '@temporalio/workflow';
import type * as activities from './temporal-activities.js';

const steps=proxyActivities<typeof activities>({
 startToCloseTimeout:'4 minutes',
 retry:{maximumAttempts:3,initialInterval:'3 seconds',backoffCoefficient:2}
});
/** Waiting Temporal workflows occupy no Codex/worker activity slot. */
async function waitForProjectAgents(scope:{projectId?:string;runId?:string;kind?:'analysis'|'peer'|'planning'|'documentation'}){
 // Workflows created before this deployment have a persisted history. Skip
 // the new wait during their replay to preserve Temporal determinism.
 if(!patched('per-project-agent-runtime-v1'))return;
 while(!await steps.projectAgentsRunning(scope))await sleep('20 seconds');
}
const inboxSteps=proxyActivities<Pick<typeof activities,'runProjectManagerInbox'>>({
 startToCloseTimeout:'6 minutes',scheduleToCloseTimeout:'1 day',
 retry:{maximumAttempts:20,initialInterval:'10 seconds',maximumInterval:'1 minute',backoffCoefficient:2}
});
const watchSteps=proxyActivities<Pick<typeof activities,'readProjectManagerWatch'>>({
 startToCloseTimeout:'30 seconds',retry:{maximumAttempts:3,initialInterval:'2 seconds'}
});
export async function watchProjectManagerDelegation(watch:{projectId:string;processId:string;kind:'iteration_plan'|'document_import'|'development'|'iteration_execution'|'testing'|'task_goal';taskId?:string;orderId?:string;topicId?:string|null;actorId?:string}):Promise<void>{
 for(let count=0;count<20160;count++){
  const status=await watchSteps.readProjectManagerWatch(watch);
  if(status.status==='completed'){
   if(status.messageId&&!patched('pm-resume-through-inbox')){
    try{await startChild(processProjectManagerInbox,{workflowId:'pm-resume-'+status.messageId,args:[watch.projectId,status.messageId],parentClosePolicy:ParentClosePolicy.ABANDON});}
    catch(error){if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name))throw error;}
   }
   return;
  }
  await sleep('30 seconds');
 }
}
export async function processProjectManagerInbox(projectId:string,messageId:string,attempt?:number):Promise<void>{
 const watched=await (attempt===undefined?inboxSteps.runProjectManagerInbox(projectId,messageId)
  :inboxSteps.runProjectManagerInbox(projectId,messageId,attempt)).catch(async error=>{
   if(patched('pm-inbox-finalize-failed-turn'))await steps.markProjectManagerInboxFailed(projectId,messageId,attempt??1);
   throw error;
  });
 for(const watch of watched){
  try{
   await startChild(watchProjectManagerDelegation,{workflowId:'pm-followup-'+watch.processId,args:[watch],parentClosePolicy:ParentClosePolicy.ABANDON});
  }catch(error){
   // A second PM turn can attach to the same already-running process.
   if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name))throw error;
  }
 }
}
const qualitySteps=proxyActivities<Pick<typeof activities,'runSelfHostedQualityGates'>>({startToCloseTimeout:'80 minutes',heartbeatTimeout:'1 minute',retry:{maximumAttempts:1}});
const planningSteps=proxyActivities<typeof activities>({startToCloseTimeout:'15 minutes',retry:{maximumAttempts:3,initialInterval:'3 seconds',backoffCoefficient:2}});
const deploymentSteps=proxyActivities<typeof activities>({startToCloseTimeout:'30 minutes',heartbeatTimeout:'1 minute',retry:{maximumAttempts:1}});
export async function automaticDeployment(runId:string):Promise<void>{
 try{await deploymentSteps.runAutomaticDeployment(runId);}
 catch(e){
  let cause=e;
  while(cause instanceof Error&&cause.cause instanceof Error)cause=cause.cause;
  await steps.failAutomaticDeployment(runId,cause instanceof Error?cause.message:String(cause));
 }
}
export async function analyzeTaskStage(runId:string):Promise<void>{
 await waitForProjectAgents({runId,kind:'analysis'});
 await steps.runTaskStageAnalysis(runId);
}
/** New workflow name preserves replay of all existing cycles. */
export async function executeDelegatedWork(assignmentId:string):Promise<void>{
 try{
  const {projectId}=await steps.delegatedWorkScope(assignmentId);
  await waitForProjectAgents({projectId});
  await steps.runDelegatedWork(assignmentId);
 }catch(error){
  await steps.failDelegatedWork(assignmentId,String(error));
 }
}

export async function processPeerQuestionWork(noteId:string):Promise<void>{
 try{await waitForProjectAgents({runId:noteId,kind:'peer'});await steps.runPeerQuestionWork(noteId);}
 catch(error){await steps.failPeerQuestionWork(noteId,String(error));}
}
export async function prepareIterationPlan(runId:string):Promise<void>{
 try{await waitForProjectAgents({runId,kind:'planning'});await planningSteps.prepareIterationPlanDraft(runId);}
 catch(error){
  let cause=error;
  while(cause instanceof Error&&cause.cause instanceof Error)cause=cause.cause;
  await steps.failIterationPlanDraft(runId,cause instanceof Error?cause.message:String(cause));
 }
}

export type CycleInput={projectId:string;taskId:string;runId:string;maxFixes:number};

// Workflow history is durable. Secrets and Codex jobs live only in Activities.
export async function developmentTestingCycle(input:CycleInput):Promise<string>{
 try {
 let runId=input.runId;
 for(let attempt=0;attempt<=input.maxFixes;attempt++){
  await waitForProjectAgents({projectId:input.projectId});
  try{await steps.startDevelopment({projectId:input.projectId,taskId:input.taskId,runId,attempt});}
  catch(error){
   await steps.noteCycleFailure({projectId:input.projectId,taskId:input.taskId,message:'Разработка не запущена: '+String(error),stage:'development'});
   return 'development_failed';
  }
  let development;
  while(true){
   development=await steps.checkDevelopment({projectId:input.projectId,taskId:input.taskId,runId});
   if(development.status==='completed'||development.status==='failed')break;
   await sleep('8 seconds');
  }
  if(development.status==='failed'){
   await steps.noteCycleFailure({projectId:input.projectId,taskId:input.taskId,message:development.message,stage:'development'});
   return 'development_failed';
  }
  // The developer may prove that implementation already exists on the target
  // branch. An empty PR is impossible; independently run QA on that pinned SHA.
  // Old workflows keep their prior deterministic history on replay.
  const reusedBase=patched('goal-driven-developer-v1')&&await steps.developmentVerificationSource({projectId:input.projectId,taskId:input.taskId})==='already_implemented';
  let quality:{passed:boolean;message:string};
  await waitForProjectAgents({projectId:input.projectId});
  if(reusedBase)quality={passed:true,message:'Код уже находится в базовой ветке; обязательный QA проверит его SHA'};
  else try{quality=await qualitySteps.runSelfHostedQualityGates({projectId:input.projectId,taskId:input.taskId,runId});}
  catch(error){
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,message:'Не удалось выполнить собственный CI/ревью: '+String(error),stage:'quality_gates'});
   return 'quality_gates_blocked';
  }
  if(!quality.passed){
   if(quality.message.startsWith('Сбой проверки:')){
    await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,message:quality.message,stage:'quality_gates'});
    return 'quality_gates_blocked';
   }
   if(attempt>=input.maxFixes){
    await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,message:'Лимит доработок CI/архитектора: '+quality.message,stage:'quality_gates'});
    return 'quality_gates_needs_attention';
   }
   runId=await steps.scheduleQualityFix({projectId:input.projectId,taskId:input.taskId,cycleId:input.runId,attempt:attempt+1,message:quality.message});
   continue;
  }
  const simplified=patched('simplified-task-handoff');
  if(!simplified&&!patched('skip-post-implementation-requirements-gate-v1')){
  await steps.resolvePeerQuestions({projectId:input.projectId,taskId:input.taskId});
  // Analyst is an ongoing owner of the specification, not a one-time Kanban executor.
  // Reconcile the actual PR before QA is allowed to author the final test plan.
  let status: 'current'|'pending'|'needs_approval'|'rejected';
  try{status=await steps.reconcileRequirements({projectId:input.projectId,taskId:input.taskId,runId,mode:'handoff'});}
  catch(error){
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,message:'Сверка ТЗ не завершена: '+String(error),stage:'requirements'});
   return 'requirements_review_failed';
  }
  if(patched('resolve-handoff-questions')&&status==='needs_approval'){
   await steps.resolvePeerQuestions({projectId:input.projectId,taskId:input.taskId});
   status=await steps.checkRequirementStatus({projectId:input.projectId,taskId:input.taskId});
  }
  while(status==='pending'||status==='needs_approval'){
   await sleep('20 seconds'); // Persistent Temporal wait, no active Codex billing.
   status=await steps.checkRequirementStatus({projectId:input.projectId,taskId:input.taskId});
   if(status==='pending')status=await steps.reconcileRequirements({projectId:input.projectId,taskId:input.taskId,runId,mode:'handoff'});
  }
  if(status==='rejected'){
   if(attempt>=input.maxFixes)return 'requirements_rejected_needs_attention';
   runId=await steps.scheduleRequirementFix({projectId:input.projectId,taskId:input.taskId,cycleId:input.runId,attempt:attempt+1});
   continue;
  }
  }
  const singlePass=simplified&&patched('qa-single-pass');
  if(!singlePass)try{await steps.prepareQaPlan({projectId:input.projectId,taskId:input.taskId,runId,...(simplified?{simplified}: {})});}
  catch(error){
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,message:'Не удалось актуализировать тестовую документацию: '+String(error),stage:'qa_preparation'});
   return 'qa_plan_failed';
  }
  let testId:string;
  await waitForProjectAgents({projectId:input.projectId});
  try{testId=await steps.startTesting({projectId:input.projectId,taskId:input.taskId,cycleId:input.runId,attempt,...(simplified?{simplified}: {}),...(singlePass?{singlePass}: {})});}
  catch(error){
   if(!patched('record-qa-start-failure'))throw error;
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,
    message:'Не удалось запустить тестирование: '+String((error instanceof Error?error.cause:null)||error),stage:'qa_start',qaRun:{cycleId:input.runId,attempt}});
   return 'qa_start_failed';
  }
  let testing;
  while(true){
   testing=await steps.checkTesting({projectId:input.projectId,taskId:input.taskId,testId});
   if(testing.status==='completed'||testing.status==='failed')break;
   await sleep('8 seconds');
  }
  if(testing.status==='failed'){
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId:input.runId,message:'Сбой QA-исполнителя: '+testing.message,stage:'testing'});
   return 'testing_runner_failed';
  }
  if(testing.verdict==='blocked'){
   await steps.noteBlockedTests({projectId:input.projectId,taskId:input.taskId,testId,...(simplified?{simplified}: {})});
   return simplified?'ready_to_merge_partial':'testing_awaits_explicit_decision';
  }
  if(testing.verdict==='passed'){
   await steps.approveTestedTask({projectId:input.projectId,taskId:input.taskId,testId,...(simplified?{simplified}: {})});
   return reusedBase?'already_implemented_verified':'ready_to_merge';
  }
  const next=await steps.rejectTestedTask({projectId:input.projectId,taskId:input.taskId,cycleId:input.runId,testId,attempt,allowFix:attempt<input.maxFixes});
  if(!next)return 'manual_intervention';
  runId=next;
 }
 return 'manual_intervention';
 } finally {
  await steps.finishTaskOrchestration({projectId:input.projectId,taskId:input.taskId,ownerId:input.runId});
 }
}

/** A separate Temporal lane for non-code deliverables. It never starts a
 * developer, creates a PR, merges, or deploys. QA produces verifiable browser
 * artifacts and the backend checks their recorded source SHA and viewports.
 */
export async function browserEvidenceCycle(input:{projectId:string;taskId:string;runId:string}):Promise<string>{
 try{
  await waitForProjectAgents({projectId:input.projectId});
  const testId=await steps.startTesting({
   projectId:input.projectId,taskId:input.taskId,cycleId:input.runId,attempt:0,
   simplified:true,singlePass:true
  });
  let report;
  while(true){
   report=await steps.checkTesting({projectId:input.projectId,taskId:input.taskId,testId});
   if(report.status==='completed'||report.status==='failed')break;
   await sleep('8 seconds');
  }
  if(report.status==='failed'){
   await steps.finishEvidenceTask({...input,status:'failed',message:'Исполнитель не завершил сбор доказательств: '+report.message});
   return 'evidence_runner_failed';
  }
  if(report.verdict==='passed'){
   await steps.approveTestedTask({projectId:input.projectId,taskId:input.taskId,testId,simplified:true});
   await steps.finishEvidenceTask({...input,status:'completed',message:'Получены и независимо подтверждены артефакты браузера'});
   return 'evidence_verified';
  }
  if(report.verdict==='blocked'){
   await steps.noteBlockedTests({projectId:input.projectId,taskId:input.taskId,testId,simplified:true});
  }
  await steps.finishEvidenceTask({...input,status:'blocked',
   message:report.verdict==='failed'
    ?'Обнаружены недостатки или неполные артефакты. Это не является поводом создавать PR.'
    :'Нет доступной подтверждённой среды или недостаточно браузерных доказательств.'});
  return 'evidence_blocked';
 }catch(error){
  await steps.finishEvidenceTask({...input,status:'failed',message:'Браузерная задача заблокирована: '+String(error).slice(0,1200)});
  return 'evidence_failed';
 }finally{
  await steps.finishTaskOrchestration({projectId:input.projectId,taskId:input.taskId,ownerId:input.runId});
 }
}

export async function manualTesting(input:{projectId:string;taskId:string;cycleId:string}):Promise<string>{
 await waitForProjectAgents({projectId:input.projectId});
 try {
 const reusedBase=patched('goal-driven-manual-qa-v1')&&await steps.developmentVerificationSource({projectId:input.projectId,taskId:input.taskId})==='already_implemented';
 if(!reusedBase){
  const quality=await qualitySteps.runSelfHostedQualityGates({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId});
  if(!quality.passed){
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,
    message:'Собственный CI / ревью архитектора: '+quality.message,stage:'quality_gates'});
   return 'quality_gates_failed';
  }
 }
 const simplified=patched('simplified-manual-testing');
 if(!simplified&&!patched('skip-post-implementation-requirements-gate-v1')){
 await steps.resolvePeerQuestions({projectId:input.projectId,taskId:input.taskId});
 let status=await steps.reconcileRequirements({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,mode:'handoff'});
 if(patched('resolve-manual-testing-questions')&&status==='needs_approval'){
  await steps.resolvePeerQuestions({projectId:input.projectId,taskId:input.taskId});
  status=await steps.checkRequirementStatus({projectId:input.projectId,taskId:input.taskId});
 }
 while(status==='pending'||status==='needs_approval'){
  await sleep('20 seconds');
  status=await steps.checkRequirementStatus({projectId:input.projectId,taskId:input.taskId});
  if(status==='pending')status=await steps.reconcileRequirements({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,mode:'handoff'});
 }
 if(status==='rejected')return 'requirements_rejected';
 }
 const singlePass=simplified&&patched('qa-single-pass');
 if(!singlePass)try{await steps.prepareQaPlan({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,...(simplified?{simplified}: {})});}
 catch(error){
  await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,message:'Не удалось подготовить QA-документацию: '+String(error),stage:'qa_preparation'});
  return 'qa_plan_failed';
 }
 let testId:string;
 try{testId=await steps.startTesting({projectId:input.projectId,taskId:input.taskId,cycleId:input.cycleId,attempt:0,...(simplified?{simplified}: {}),...(singlePass?{singlePass}: {})});}
 catch(error){
  if(!patched('record-qa-start-failure'))throw error;
  await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,
   message:'Не удалось запустить тестирование: '+String((error instanceof Error?error.cause:null)||error),stage:'qa_start',qaRun:{cycleId:input.cycleId,attempt:0}});
  return 'qa_start_failed';
 }
 let testing;
 while(true){
  testing=await steps.checkTesting({projectId:input.projectId,taskId:input.taskId,testId});
  if(testing.status==='completed'||testing.status==='failed')break;
  await sleep('8 seconds');
 }
 if(testing.status==='failed'){
  await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,message:'Сбой QA-исполнителя: '+testing.message,stage:'testing'});
  return 'testing_runner_failed';
 }
 if(testing.verdict==='blocked'){
  await steps.noteBlockedTests({projectId:input.projectId,taskId:input.taskId,testId,...(simplified?{simplified}: {})});
  return simplified?'ready_to_merge_partial':'testing_awaits_explicit_decision';
 }
 if(testing.verdict==='passed'){
  await steps.approveTestedTask({projectId:input.projectId,taskId:input.taskId,testId,...(simplified?{simplified}: {})});
  return reusedBase?'already_implemented_verified':'ready_to_merge';
 }
 await steps.rejectTestedTask({projectId:input.projectId,taskId:input.taskId,cycleId:input.cycleId,testId,attempt:0,allowFix:false});
 return 'manual_intervention';
 } finally {
  await steps.finishTaskOrchestration({projectId:input.projectId,taskId:input.taskId,ownerId:input.cycleId});
 }
}

/** An independently started review for user edits at any stage (including completed tasks). */
export async function requirementsReview(input:{projectId:string;taskId:string;runId:string}):Promise<string>{
 await waitForProjectAgents({projectId:input.projectId});
 try{
  const args={...input,mode:'edit' as const};
  const status=await steps.reconcileRequirements(args);
  if(patched('resolve-edit-questions')&&status==='needs_approval'){
   await steps.resolvePeerQuestions(input);
   const next=await steps.checkRequirementStatus(input);
   if(next==='pending')return steps.reconcileRequirements(args);
   return next;
  }
  return status;
 }catch(error){
  await steps.noteReviewFailure({projectId:input.projectId,taskId:input.taskId,runId:input.runId,message:String(error)});
  return 'failed';
 }
}


/** Each user turn is a durable Temporal workflow. Failure leaves a retryable
 *  persisted message, not an invisible discarded request. */
export async function projectManagerReply(input:{projectId:string;taskId:string;messageId:string}):Promise<string>{
 if(patched('manager-resolves-task-answers-first')){
  await steps.resolvePeerQuestions({projectId:input.projectId,taskId:input.taskId});
  const result=await steps.handleManagerTurn(input);
  const continuation=result.message||(!result.handled?await steps.continueManagedTask(input):'');
  await steps.completeManagerMessage({...input,continuation,handled:result.handled});
  return 'responded';
 }
 if(patched('manager-handles-analysis-turn')){
  const result=await steps.handleManagerTurn(input);
  let continuation=result.message;
  if(!result.handled){
   await steps.resolvePeerQuestions({projectId:input.projectId,taskId:input.taskId});
   continuation=continuation||await steps.continueManagedTask(input);
  }
  await steps.completeManagerMessage({...input,continuation,handled:result.handled});
  return 'responded';
 }
 await steps.resolvePeerQuestions({projectId:input.projectId,taskId:input.taskId});
 if(patched('manager-continues-task')){
  const continuation=await steps.continueManagedTask(input);
  await steps.completeManagerMessage({...input,continuation});
 }else{
  await steps.completeManagerMessage(input);
 }
 return 'responded';
}

const analyst=proxyActivities<Pick<typeof activities,'runProjectSpecification'>>({
 startToCloseTimeout:'3 hours',heartbeatTimeout:'45 seconds',scheduleToCloseTimeout:'4 hours',
 retry:{maximumAttempts:3,initialInterval:'3 seconds'}
});

export async function prepareProjectSpecification(jobId:string):Promise<void>{
 await waitForProjectAgents({runId:jobId,kind:'documentation'});
 try{await analyst.runProjectSpecification(jobId);}
 catch{await steps.failProjectSpecification(jobId);}
}

export async function mergeReadyBatch(batchId:string):Promise<void>{
 try{
  const tasks=await steps.pendingMergeTasks(batchId);
  for(const taskId of tasks){
   let result:Awaited<ReturnType<typeof activities.tryMergeBatchTask>>|undefined;
   let executionError:string|undefined;
   try{
    for(let attempt=0;attempt<3;attempt++){
     result=await steps.tryMergeBatchTask(batchId,taskId);
     if(result.status==='merged'||result.status==='skipped'||attempt===2)break;
     if(result.status==='conflict'){
      let completed=false;
      for(let poll=0;poll<150;poll++){
       const conflict=await steps.pollMergeConflict(batchId,taskId,attempt);
       if(conflict.status==='completed'){completed=true;break;}
       if(conflict.status==='failed'){executionError=conflict.message||'Не удалось разрешить конфликт';break;}
       await sleep('8 seconds');
      }
      if(!completed){executionError??='Истекло время ожидания разрешения конфликта';break;}
     }
     await sleep('3 seconds');
    }
   }catch(error){
    let cause=error;
    while(cause instanceof Error&&cause.cause instanceof Error)cause=cause.cause;
    executionError=cause instanceof Error?cause.message:String(cause);
   }
   const status=executionError?'failed':result?.status==='merged'?'merged':'skipped';
   const reason=executionError??result?.reason;
   await steps.recordMergeBatchResult(batchId,{taskId,status,...(reason?{reason}:{})});
  }
 }catch(error){
  await steps.completeMergeBatch(batchId,String(error));
  throw error;
 }
 await steps.completeMergeBatch(batchId);
}

/** Explicit retry of the independent quality gate without running a redundant QA cycle. */
export async function manualQualityGates(input:{projectId:string;taskId:string;runId:string}){
 await waitForProjectAgents({projectId:input.projectId});
 return qualitySteps.runSelfHostedQualityGates(input);
}

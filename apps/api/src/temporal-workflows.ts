import {patched,proxyActivities,sleep,startChild,ParentClosePolicy} from '@temporalio/workflow';
import type * as activities from './temporal-activities.js';

const steps=proxyActivities<typeof activities>({
 startToCloseTimeout:'4 minutes',
 retry:{maximumAttempts:3,initialInterval:'3 seconds',backoffCoefficient:2}
});
const inboxSteps=proxyActivities<Pick<typeof activities,'runProjectManagerInbox'>>({
 startToCloseTimeout:'6 minutes',scheduleToCloseTimeout:'1 day',
 retry:{maximumAttempts:20,initialInterval:'10 seconds',maximumInterval:'1 minute',backoffCoefficient:2}
});
const watchSteps=proxyActivities<Pick<typeof activities,'readProjectManagerWatch'>>({
 startToCloseTimeout:'30 seconds',retry:{maximumAttempts:3,initialInterval:'2 seconds'}
});
export async function watchProjectManagerDelegation(watch:{projectId:string;processId:string;kind:'iteration_plan'|'document_import'|'development'}):Promise<void>{
 for(let count=0;count<20160;count++){
  const status=await watchSteps.readProjectManagerWatch(watch);
  if(status==='completed')return;
  await sleep('30 seconds');
 }
}
export async function processProjectManagerInbox(projectId:string,messageId:string):Promise<void>{
 const watched=await inboxSteps.runProjectManagerInbox(projectId,messageId);
 for(const watch of watched){
  try{
   await startChild(watchProjectManagerDelegation,{workflowId:'pm-followup-'+watch.processId,args:[watch],parentClosePolicy:ParentClosePolicy.ABANDON});
  }catch(error){
   // A second PM turn can attach to the same already-running process.
   if(!['WorkflowExecutionAlreadyStartedError','WorkflowAlreadyStartedError'].includes((error as Error).name))throw error;
  }
 }
}
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
export async function prepareIterationPlan(runId:string):Promise<void>{
 try{await planningSteps.prepareIterationPlanDraft(runId);}
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
  try{await steps.prepareQaPlan({projectId:input.projectId,taskId:input.taskId,runId});}
  catch(error){
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,message:'Не удалось актуализировать тестовую документацию: '+String(error),stage:'qa_preparation'});
   return 'qa_plan_failed';
  }
  const testId=await steps.startTesting({projectId:input.projectId,taskId:input.taskId,cycleId:input.runId,attempt});
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
   await steps.noteBlockedTests({projectId:input.projectId,taskId:input.taskId,testId});
   return 'testing_awaits_explicit_decision';
  }
  if(testing.verdict==='passed'){
   await steps.approveTestedTask({projectId:input.projectId,taskId:input.taskId,testId});
   return 'ready_to_merge';
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

export async function manualTesting(input:{projectId:string;taskId:string;cycleId:string}):Promise<string>{
 try {
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
 try{await steps.prepareQaPlan({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId});}
 catch(error){
  await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,message:'Не удалось подготовить QA-документацию: '+String(error),stage:'qa_preparation'});
  return 'qa_plan_failed';
 }
 const testId=await steps.startTesting({projectId:input.projectId,taskId:input.taskId,cycleId:input.cycleId,attempt:0});
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
  await steps.noteBlockedTests({projectId:input.projectId,taskId:input.taskId,testId});
  return 'testing_awaits_explicit_decision';
 }
 if(testing.verdict==='passed'){
  await steps.approveTestedTask({projectId:input.projectId,taskId:input.taskId,testId});
  return 'ready_to_merge';
 }
 await steps.rejectTestedTask({projectId:input.projectId,taskId:input.taskId,cycleId:input.cycleId,testId,attempt:0,allowFix:false});
 return 'manual_intervention';
 } finally {
  await steps.finishTaskOrchestration({projectId:input.projectId,taskId:input.taskId,ownerId:input.cycleId});
 }
}

/** An independently started review for user edits at any stage (including completed tasks). */
export async function requirementsReview(input:{projectId:string;taskId:string;runId:string}):Promise<string>{
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
 try{await analyst.runProjectSpecification(jobId);}
 catch{await steps.failProjectSpecification(jobId);}
}

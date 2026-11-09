import {proxyActivities,sleep} from '@temporalio/workflow';
import type * as activities from './temporal-activities.js';

const steps=proxyActivities<typeof activities>({
 startToCloseTimeout:'4 minutes',
 retry:{maximumAttempts:3,initialInterval:'3 seconds',backoffCoefficient:2}
});
export type CycleInput={projectId:string;taskId:string;runId:string;maxFixes:number};

// Workflow history is durable. Secrets and Codex jobs live only in Activities.
export async function developmentTestingCycle(input:CycleInput):Promise<string>{
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
  // Analyst is an ongoing owner of the specification, not a one-time Kanban executor.
  // Reconcile the actual PR before QA is allowed to author the final test plan.
  let status: 'current'|'pending'|'needs_approval'|'rejected';
  try{status=await steps.reconcileRequirements({projectId:input.projectId,taskId:input.taskId,runId,mode:'handoff'});}
  catch(error){
   await steps.noteHandoffFailure({projectId:input.projectId,taskId:input.taskId,runId,message:'Сверка ТЗ не завершена: '+String(error),stage:'requirements'});
   return 'requirements_review_failed';
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
  if(testing.status==='failed'||testing.verdict==='blocked'){
   await steps.noteCycleFailure({projectId:input.projectId,taskId:input.taskId,message:testing.message,stage:'testing'});
   return 'testing_needs_attention';
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
}

export async function manualTesting(input:{projectId:string;taskId:string;cycleId:string}):Promise<string>{
 let status=await steps.reconcileRequirements({projectId:input.projectId,taskId:input.taskId,runId:input.cycleId,mode:'handoff'});
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
 if(testing.status==='failed'||testing.verdict==='blocked'){
  await steps.noteCycleFailure({projectId:input.projectId,taskId:input.taskId,message:testing.message,stage:'testing'});
  return 'testing_needs_attention';
 }
 if(testing.verdict==='passed'){
  await steps.approveTestedTask({projectId:input.projectId,taskId:input.taskId,testId});
  return 'ready_to_merge';
 }
 await steps.rejectTestedTask({projectId:input.projectId,taskId:input.taskId,cycleId:input.cycleId,testId,attempt:0,allowFix:false});
 return 'manual_intervention';
}

/** An independently started review for user edits at any stage (including completed tasks). */
export async function requirementsReview(input:{projectId:string;taskId:string;runId:string}):Promise<string>{
 try{
  return await steps.reconcileRequirements({projectId:input.projectId,taskId:input.taskId,runId:input.runId,mode:'edit'});
 }catch(error){
  await steps.noteReviewFailure({projectId:input.projectId,taskId:input.taskId,runId:input.runId,message:String(error)});
  return 'failed';
 }
}

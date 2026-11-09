import {proxyActivities,sleep} from '@temporalio/workflow';
import type * as activities from './temporal-activities.js';

const steps=proxyActivities<typeof activities>({
 startToCloseTimeout:'2 minutes',
 retry:{maximumAttempts:3,initialInterval:'3 seconds',backoffCoefficient:2}
});
export type CycleInput={projectId:string;taskId:string;runId:string;maxFixes:number};

// Workflow history is durable. Secrets and Codex jobs live only in Activities.
export async function developmentTestingCycle(input:CycleInput):Promise<string>{
 let runId=input.runId;
 for(let attempt=0;attempt<=input.maxFixes;attempt++){
  await steps.startDevelopment({projectId:input.projectId,taskId:input.taskId,runId,attempt});
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
  // A failed test creates an actionable report before the next Codex invocation.
  const next=await steps.rejectTestedTask({projectId:input.projectId,taskId:input.taskId,cycleId:input.runId,testId,attempt,allowFix:attempt<input.maxFixes});
  if(!next)return 'manual_intervention';
  runId=next;
 }
 return 'manual_intervention';
}

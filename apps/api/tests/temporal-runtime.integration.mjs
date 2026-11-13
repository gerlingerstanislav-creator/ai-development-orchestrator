import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NativeConnection,Worker} from '@temporalio/worker';
import {Connection,Client} from '@temporalio/client';

/**
 * Runs against the real Temporal development server, not a mocked workflow
 * scheduler. Activities stand in for Codex, PostgreSQL and GitHub: this checks
 * Workflow determinism, actual Activity dispatch and end-to-end stage ordering,
 * while never making a paid Codex request or mutating an external repository.
 */
const scenarios=new Map();
const batchEvents=[];
const workflowPath=fileURLToPath(new URL('../dist/temporal-workflows.js',import.meta.url));
const event=(projectId,name,payload={})=>{
 const scenario=scenarios.get(projectId);
 if(!scenario)throw Error('Unknown project in Temporal integration test');
 scenario.events.push({name,...payload});
 return scenario;
};
const scenario=(mode,maxFixes=1)=>{
 const data={projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),
  maxFixes,mode,events:[],checks:0,qualityChecks:0,qaChecks:0};
 scenarios.set(data.projectId,data);
 return data;
};

const activities={
 projectAgentsRunning:async()=>true,
 startDevelopment:async args=>{event(args.projectId,'development-start',{attempt:args.attempt,runId:args.runId});},
 checkDevelopment:async args=>{
  const state=event(args.projectId,'development-check');
  state.checks++;
  // Verify actual Temporal polling and timers once, without using an agent slot.
  if(state.mode==='polling'&&state.checks===1)return {status:'running',message:'Codex is working'};
  return {status:'completed',message:'Commit and PR recorded'};
 },
 developmentVerificationSource:async args=>{event(args.projectId,'verification-source');return 'pr_created';},
 runSelfHostedQualityGates:async args=>{
  const state=event(args.projectId,'quality-gates',{runId:args.runId});
  state.qualityChecks++;
  return state.mode==='ci-fix'&&state.qualityChecks===1
   ?{passed:false,message:'deterministic TypeScript failure'}
   :{passed:true,message:'CI and architecture checks passed'};
 },
 scheduleQualityFix:async args=>{
  event(args.projectId,'schedule-ci-fix',{attempt:args.attempt});
  return 'ci-fix-'+args.attempt;
 },
 scheduleRequirementFix:async args=>{event(args.projectId,'schedule-requirement-fix');return 'requirements-fix';},
 startTesting:async args=>{
  event(args.projectId,'qa-start',{attempt:args.attempt,singlePass:args.singlePass,simplified:args.simplified});
  return 'qa-'+args.attempt;
 },
 checkTesting:async args=>{
  const state=event(args.projectId,'qa-check',{testId:args.testId});
  state.qaChecks++;
  const attempt=Number(args.testId.split('-').at(-1));
  const verdict=state.mode==='qa-fix'&&attempt===0?'failed':
   state.mode==='blocked'?'blocked':state.mode==='qa-executor-failure'?'failed':'passed';
  return {status:state.mode==='qa-executor-failure'?'failed':'completed',
   verdict,message:'Recorded QA evidence'};
 },
 approveTestedTask:async args=>{event(args.projectId,'qa-approved',{testId:args.testId});},
 rejectTestedTask:async args=>{
  event(args.projectId,'qa-rejected',{attempt:args.attempt,allowFix:args.allowFix});
  return args.allowFix?'qa-fix-'+(args.attempt+1):null;
 },
 noteBlockedTests:async args=>{event(args.projectId,'qa-blocked',{testId:args.testId});},
 noteHandoffFailure:async args=>{event(args.projectId,'handoff-failed',{stage:args.stage});},
 noteCycleFailure:async args=>{event(args.projectId,'cycle-failed',{stage:args.stage});},
 finishTaskOrchestration:async args=>{event(args.projectId,'orchestration-released',{ownerId:args.ownerId});},
 pendingMergeTasks:async batchId=>{
  batchEvents.push({name:'merge-pending',batchId});
  return ['merge-task-a'];
 },
 tryMergeBatchTask:async(batchId,taskId)=>{
  batchEvents.push({name:'merge-attempt',batchId,taskId});
  return {status:'merged'};
 },
 recordMergeBatchResult:async(batchId,data)=>{
  batchEvents.push({name:'merge-record',batchId,...data});
 },
 completeMergeBatch:async batchId=>{batchEvents.push({name:'merge-complete',batchId});},
 runProjectSpecification:async jobId=>{batchEvents.push({name:'documentation-complete',jobId});},
 failProjectSpecification:async jobId=>{
  batchEvents.push({name:'documentation-failed',jobId});
  throw Error('Unexpected documentation failure');
 }
};

test('real Temporal worker runs development → independent QA → correction → merge → documentation', {timeout:180000}, async t=>{
 const address=process.env.TEMPORAL_ADDRESS||'127.0.0.1:7233';
 const queue='ado-integration-'+randomUUID();
 const native=await NativeConnection.connect({address});
 const service=await Connection.connect({address});
 const client=new Client({connection:service,namespace:'default'});
 const worker=await Worker.create({
  connection:native,namespace:'default',taskQueue:queue,workflowsPath:workflowPath,
  activities,maxConcurrentActivityTaskExecutions:5
 });
 try{
  await worker.runUntil(async()=>{
   const execute=(type,args)=>client.workflow.execute(type,{
    workflowId:'ado-ci-'+randomUUID(),taskQueue:queue,args:[args],
    workflowExecutionTimeout:'2 minutes'
   });
   await t.test('happy path: developer, quality gate, real QA verdict and release',async()=>{
    const s=scenario('success');
    assert.equal(await execute('developmentTestingCycle',s),'ready_to_merge');
    const names=s.events.map(x=>x.name);
    assert.ok(names.indexOf('development-start')<names.indexOf('quality-gates'));
    assert.ok(names.indexOf('quality-gates')<names.indexOf('qa-start'));
    assert.ok(names.indexOf('qa-start')<names.indexOf('qa-approved'));
    assert.equal(names.at(-1),'orchestration-released');
    assert.equal(names.filter(x=>x==='development-start').length,1);
    assert.equal(names.filter(x=>x==='qa-start').length,1);
   });
   await t.test('QA failure goes back to same task developer, then retries independent QA',async()=>{
    const s=scenario('qa-fix');
    assert.equal(await execute('developmentTestingCycle',s),'ready_to_merge');
    assert.deepEqual(s.events.filter(x=>x.name==='development-start').map(x=>x.attempt),[0,1]);
    assert.deepEqual(s.events.filter(x=>x.name==='qa-start').map(x=>x.attempt),[0,1]);
    assert.deepEqual(s.events.filter(x=>x.name==='qa-rejected').map(x=>x.allowFix),[true]);
    assert.equal(s.events.filter(x=>x.name==='qa-approved').length,1);
    assert.equal(s.events.at(-1).name,'orchestration-released');
   });
   await t.test('CI failure schedules bounded developer fix before QA',async()=>{
    const s=scenario('ci-fix');
    assert.equal(await execute('developmentTestingCycle',s),'ready_to_merge');
    assert.equal(s.qualityChecks,2);
    assert.equal(s.events.filter(x=>x.name==='schedule-ci-fix').length,1);
    assert.deepEqual(s.events.filter(x=>x.name==='development-start').map(x=>x.attempt),[0,1]);
    assert.equal(s.events.filter(x=>x.name==='qa-start').length,1,
     'QA starts only after CI and architect pass');
   });
   await t.test('blocked QA never receives approval or a successful merge verdict',async()=>{
    const s=scenario('blocked');
    const status=await execute('developmentTestingCycle',s);
    assert.ok(['testing_awaits_explicit_decision','ready_to_merge_partial'].includes(status));
    assert.equal(s.events.filter(x=>x.name==='qa-blocked').length,1);
    assert.equal(s.events.filter(x=>x.name==='qa-approved').length,0);
    assert.equal(s.events.at(-1).name,'orchestration-released');
   });
   await t.test('manual QA does not spawn development or duplicate the CI cycle',async()=>{
    const s=scenario('manual');
    assert.equal(await execute('manualTesting',{projectId:s.projectId,taskId:s.taskId,cycleId:s.runId}),'ready_to_merge');
    assert.equal(s.events.filter(x=>x.name==='development-start').length,0);
    assert.equal(s.events.filter(x=>x.name==='quality-gates').length,1);
    assert.equal(s.events.filter(x=>x.name==='qa-approved').length,1);
    assert.equal(s.events.at(-1).name,'orchestration-released');
   });
   await t.test('documented QA executor failure cannot approve the task',async()=>{
    const s=scenario('qa-executor-failure');
    assert.equal(await execute('developmentTestingCycle',s),'testing_runner_failed');
    assert.equal(s.events.filter(x=>x.name==='handoff-failed').at(-1).stage,'testing');
    assert.equal(s.events.filter(x=>x.name==='qa-approved').length,0);
   });
   await t.test('real Temporal merge and documentation workflows finish in order',async()=>{
    const batchId=randomUUID(),jobId=randomUUID();
    await execute('mergeReadyBatch',batchId);
    await execute('prepareProjectSpecification',jobId);
    assert.deepEqual(batchEvents.filter(x=>x.batchId===batchId).map(x=>x.name),
     ['merge-pending','merge-attempt','merge-record','merge-complete']);
    assert.equal(batchEvents.find(x=>x.name==='merge-record'&&x.batchId===batchId).status,'merged');
    assert.equal(batchEvents.some(x=>x.name==='documentation-complete'&&x.jobId===jobId),true);
    assert.equal(batchEvents.some(x=>x.name==='documentation-failed'),false);
   });
  });
 }finally{
  await native.close();
  await service.close();
 }
});

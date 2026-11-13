import test from 'node:test';
import assert from 'node:assert/strict';
import {latestTaskQa,taskQaIsRunning,qaOutcomeLabel,activeTaskAgentExecutions,taskHasLiveWork}
 from '../src/features/tasks/task-live-state.ts';

const taskId='task-34';
const oldCycle='cycle-previous',cycle='cycle-34';
const at='2026-11-13T10:33:35.000Z';
const old={id:'qa-old',task_id:taskId,cycle_id:oldCycle,status:'running',
 created_at:'2026-11-13T10:29:25.000Z'};
const finished={id:'qa-34',task_id:taskId,cycle_id:cycle,status:'failed',created_at:at};
const lease={owner_id:cycle,state:'active'};
const agents=[{id:'qa-34',kind:'testing',status:'running'}];
const background=[{taskId,kind:'testing',status:'running'}];

test('task #34: a terminal QA report stops the spinner despite Temporal ownership and stale global polls',()=>{
 const qa=latestTaskQa(taskId,taskId,[finished],[old]);
 assert.equal(qa?.id,'qa-34');
 assert.equal(taskQaIsRunning(taskId,taskId,[finished],[old],lease),false);
 assert.deepEqual(activeTaskAgentExecutions(agents,qa),[]);
 assert.equal(taskHasLiveWork(taskId,'testing',taskId,[finished],[old],
  lease,agents,background,[],[]),false);
});

test('the latest terminal run wins over older running events even in the same feed',()=>{
 assert.equal(latestTaskQa(taskId,taskId,[old,finished],[])?.id,'qa-34');
 assert.equal(taskQaIsRunning(taskId,taskId,[old,finished],[],lease),false);
 assert.equal(taskQaIsRunning(taskId,null,[],[old,finished],null),false);
});

test('QA remains live while the latest attempt is genuinely queued or running',()=>{
 for(const status of ['queued','running']){
  const running={...finished,status};
  assert.equal(taskQaIsRunning(taskId,taskId,[running],[old],lease),true);
  assert.deepEqual(activeTaskAgentExecutions([{id:running.id,kind:'testing',status}],running)
   .map(run=>run.id),['qa-34']);
 }
});

test('a new Temporal owner can prepare a new QA cycle after the previous failed run',()=>{
 const next={owner_id:'cycle-next',state:'active'};
 assert.equal(taskQaIsRunning(taskId,taskId,[finished],[],next),true);
 assert.equal(taskQaIsRunning(taskId,taskId,[],[],lease),true);
 assert.equal(taskQaIsRunning(taskId,taskId,[finished],[],{...lease,state:'finished'}),false);
});

test('unrelated ongoing agents remain visible after terminal QA',()=>{
 const work=[...agents,{id:'analysis-1',kind:'analysis',status:'running'},
  {id:'dev-1',kind:'development',status:'completed'}];
 assert.deepEqual(activeTaskAgentExecutions(work,finished).map(run=>run.id),['analysis-1']);
 assert.equal(taskHasLiveWork(taskId,'testing',taskId,[finished],[old],lease,
  work,background,[],[]),true);
});

test('task indicators never borrow a different task scoped run or a closed task lease',()=>{
 const other={...finished,id:'qa-other',task_id:'other-task',status:'running'};
 assert.equal(latestTaskQa('other-task',taskId,[finished],[other])?.id,'qa-other');
 assert.equal(taskQaIsRunning(taskId,'other-task',[finished],[finished],lease),false);
 assert.equal(taskHasLiveWork(taskId,'testing','other-task',[],[finished],
  null,[],background,[],[]),false);
});

test('testing stage has a distinct terminal label without implying that the agent is still working',()=>{
 assert.equal(qaOutcomeLabel({...finished,verdict:'blocked'}),'Сбой QA');
 assert.equal(qaOutcomeLabel({...finished,status:'completed',verdict:'blocked'}),'Ожидает решения');
 assert.equal(qaOutcomeLabel({...finished,status:'completed',verdict:'failed'}),'Есть замечания');
 assert.equal(qaOutcomeLabel({...finished,status:'completed',verdict:'passed'}),'Проверено');
 assert.equal(qaOutcomeLabel({...finished,status:'running',verdict:null}),'');
});

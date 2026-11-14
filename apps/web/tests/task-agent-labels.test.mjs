import test from 'node:test';
import assert from 'node:assert/strict';
import {taskAgentLabel} from '../src/agent-labels.ts';

test('known specialist milestones retain localized labels',()=>{
 assert.equal(taskAgentLabel('analysis').name,'Аналитик');
 assert.equal(taskAgentLabel('testing').active,'Ведётся тестирование');
});
test('PM kickoff and delegated process kinds cannot crash task modal before first iteration',()=>{
 for(const kind of ['agent','pm_inbox','unknown_future_role','']){
  const label=taskAgentLabel(kind);
  assert.ok(label.name);
  assert.ok(label.active);
 }
 assert.equal(taskAgentLabel('agent').name,'Исполнитель');
});

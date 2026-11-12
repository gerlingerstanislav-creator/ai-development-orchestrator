import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_WORKFLOW_PRESET,WORKFLOW_PRESETS,WORKFLOW_STAGE_SEQUENCE,workflowPreset,workflowPlanningContext} from '../dist/workflow-presets.js';
import {workflowResponsibility} from '../dist/workflow-responsibilities.js';

test('universal workflow has a stable, complete stage sequence',()=>{
 assert.deepEqual(WORKFLOW_STAGE_SEQUENCE,['backlog','analysis','development','testing','merge_queue','deployment','documentation','done']);
 assert.equal(new Set(WORKFLOW_STAGE_SEQUENCE).size,WORKFLOW_STAGE_SEQUENCE.length);
 for(const stage of WORKFLOW_STAGE_SEQUENCE){
  const responsibility=workflowResponsibility(stage);
  assert.ok(responsibility?.trigger,'missing stage trigger: '+stage);
  assert.ok(responsibility?.result,'missing stage result: '+stage);
  assert.ok(responsibility?.participants?.length||responsibility?.role,'missing role owner or participants: '+stage);
 }
});

test('profiles are unique, standard by default, and preserve gates',()=>{
 assert.deepEqual(WORKFLOW_PRESETS.map(p=>p.id),['fast','standard','extended']);
 assert.equal(workflowPreset('invalid').id,DEFAULT_WORKFLOW_PRESET);
 for(const profile of WORKFLOW_PRESETS){
  assert.ok(profile.title&&profile.description&&profile.planning);
  const instructions=workflowPlanningContext(profile.id);
  assert.match(instructions,/QA/);
  assert.match(instructions,/CI/);
  assert.match(instructions,/слияния PR/);
 }
});

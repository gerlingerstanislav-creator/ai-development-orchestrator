import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowProfiles,workflowProfile,isWorkflowProfile,workflowProfileInstructions,readTaskWorkflowProfile,profileCanChange} from '../dist/workflow-profiles.js';

test('one universal workflow has three complete and safe profiles',()=>{
 assert.deepEqual(workflowProfiles.map(profile=>profile.id),['fast','standard','extended']);
 const stages=['backlog','analysis','development','testing','merge_queue','deployment','documentation','done'];
 for(const profile of workflowProfiles){
  assert.deepEqual(profile.steps.map(step=>step.stage),stages);
  assert.ok(profile.steps.every(step=>step.owner&&step.outcome));
  assert.ok(workflowProfileInstructions(profile.id,'analysis'));
  assert.ok(workflowProfileInstructions(profile.id,'testing'));
 }
 assert.equal(workflowProfile('unknown').id,'standard');
 assert.equal(isWorkflowProfile('standard'),true);
 assert.equal(isWorkflowProfile('skip_qa'),false);
});
test('effective profile is read from task, not mutable project default',async()=>{
 const db={query:async(sql,params)=>{assert.match(sql,/FROM tasks/);assert.deepEqual(params,['p','t']);return {rows:[{workflow_profile:'extended'}]};}};
 assert.equal(await readTaskWorkflowProfile(db,'p','t'),'extended');
 assert.equal(await readTaskWorkflowProfile({query:async()=>({rows:[{workflow_profile:'invalid'}]})},'p','t'),'standard');
});
test('changing a profile is forbidden while analysis runs or PR exists',()=>{
 assert.equal(profileCanChange('backlog','new',false),true);
 assert.equal(profileCanChange('analysis','ready_for_development',false),true);
 assert.equal(profileCanChange('analysis','processing',false),false);
 assert.equal(profileCanChange('development','approved',false),false);
 assert.equal(profileCanChange('analysis','new',true),false);
});

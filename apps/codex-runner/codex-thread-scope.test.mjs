import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationThreadScope} from './codex-thread-scope.mjs';

const manager={
 agent_role:'manager',project_id:'ae75ec35-c9a4-4218-b838-b8287e7fbd7d',
 actor_id:'5fcf2fcb-3097-4d58-97b5-5823f5250c15'
};
test('PM policy revision invalidates an old Codex thread but preserves owner and project scope',()=>{
 const old=conversationThreadScope(manager);
 const v1=conversationThreadScope({...manager,prompt_revision:'0123456789abcdef'});
 const v1Again=conversationThreadScope({...manager,prompt_revision:'0123456789abcdef'});
 const v2=conversationThreadScope({...manager,prompt_revision:'abcdef0123456789'});
 assert.deepEqual(v1,v1Again,'same approved policy resumes safely');
 assert.equal(v1.projectId,old.projectId);
 assert.equal(v1.role,'manager');
 assert.equal(v1.taskId,undefined);
 assert.notEqual(old.processId,v1.processId);
 assert.notEqual(v1.processId,v2.processId,'updated role policy starts a fresh PM thread');
 assert.match(v1.processId,/owner-chat:.*:policy-0123456789abcdef$/);
});
test('untrusted or malformed revisions cannot control thread scope',()=>{
 const base=conversationThreadScope(manager);
 for(const revision of ['../../../other','deadbeef','ff'.repeat(200),'ABCDEF0123456789']){
  assert.deepEqual(conversationThreadScope({...manager,prompt_revision:revision}),base);
 }
});
test('non-PM agents keep their existing session regardless of optional policy metadata',()=>{
 const data={...manager,agent_role:'analyst',process_id:'some-process'};
 assert.deepEqual(conversationThreadScope(data),
  conversationThreadScope({...data,prompt_revision:'0123456789abcdef'}));
});

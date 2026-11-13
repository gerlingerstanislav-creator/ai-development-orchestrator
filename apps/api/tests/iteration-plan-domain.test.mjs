import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,planItems,planDiff,normalizeIterationName} from '../dist/modules/planning/domain/iteration-plan.js';

const task=(key,depends_on)=>({key,title:'Work '+key,description:'Implement '+key,kind:'development',tags:[],...(depends_on?{depends_on}:{})});
const plan=(tasks)=>({epics:[{key:'epic',title:'Customer checkout',description:'Workflow',tasks}]});
const fail=(action,status)=>assert.throws(action,e=>e.statusCode===status);

test('iteration domain validates unique keys, dependency graph and no more than 80 tasks',()=>{
 validatePlan(plan([task('one'),task('two','one')]));
 fail(()=>validatePlan(plan([task('same'),task('same')])),400);
 fail(()=>validatePlan(plan([task('a','b'),task('b','a')])),400);
 fail(()=>validatePlan(plan([task('alone','missing')])),400);
 fail(()=>validatePlan(plan(Array.from({length:81},(_,i)=>task('t'+i)))),400);
});

test('legacy analysis-only cards become clarifications, not phantom tasks or dangling dependencies',()=>{
 const request={key:'question',title:'Clarify warranty',description:'Ask the customer',kind:'analysis',tags:[]};
 const output=planItems(plan([request,task('implement','question')]),[]);
 assert.deepEqual(output.items.map(item=>item.key),['epic','implement']);
 assert.equal(output.items[1].depends_on,undefined);
 assert.deepEqual(output.clarifications.map(item=>item.key),['question']);
 assert.deepEqual(output.unmentioned,[]);
});

test('plan diffs detect changed requirements, tags, roles and dependencies',()=>{
 const current=[
  {id:'epic-id',project_id:'p',title:'Customer checkout',description:'Workflow',type:'epic',stage:'backlog',parent_id:null,iteration_item_key:'epic',depends_on_task_id:null,iteration_work_kind:null,tags:[],spec_version:1,updated_at:'now'},
  {id:'task-id',project_id:'p',title:'Work old',description:'Old description',type:'task',stage:'analysis',parent_id:'epic-id',iteration_item_key:'implement',depends_on_task_id:null,iteration_work_kind:'development',tags:['old'],spec_version:1,updated_at:'now'}
 ];
 const p=plan([{...task('implement'),title:'New feature',tags:['new']}]);
 const {items}=planItems(p,current);
 const changed=planDiff(items).find(i=>i.key==='implement');
 assert.deepEqual(changed.changes,['title','description','tags']);
 assert.equal(changed.existing.id,'task-id');
 assert.equal(normalizeIterationName('  Work  '),'work');
});

test('one old task cannot be claimed by two separately named plan items',()=>{
 const current=[{id:'e',project_id:'p',title:'Customer checkout',description:'Workflow',type:'epic',stage:'backlog',parent_id:null,iteration_item_key:'epic',depends_on_task_id:null,iteration_work_kind:null,tags:[],spec_version:1,updated_at:'now'},
  {id:'t',project_id:'p',title:'Repeat',description:'Feature',type:'task',stage:'analysis',parent_id:'e',iteration_item_key:null,depends_on_task_id:null,iteration_work_kind:'development',tags:[],spec_version:1,updated_at:'now'}];
 const p=plan([{...task('one'),title:'Repeat'},{...task('two'),title:'Repeat'}]);
 fail(()=>planItems(p,current),409);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {agentToolCatalog as legacyCatalog,capabilitiesForRole,toolsForSession,
 isProjectManagerOrderAction} from '../dist/agent-tools.js';
import {agentToolCatalog as domainCatalog} from '../dist/modules/agents/domain/tool-catalog.js';

test('catalog extraction preserves one authoritative schema and stable public imports',()=>{
 assert.strictEqual(domainCatalog,legacyCatalog,'the public entry point must re-export the same catalog');
 assert.ok(domainCatalog.length>90);
 const names=domainCatalog.map(x=>x.name);
 assert.equal(names.length,new Set(names).size,'every tool must have one schema');
 for(const tool of domainCatalog){
  assert.equal(tool.inputSchema.type,'object',tool.name);
  assert.equal(tool.inputSchema.additionalProperties,false,tool.name);
  assert.equal(typeof tool.annotations.readOnlyHint,'boolean',tool.name);
  assert.ok(tool.inputSchema.required.every(k=>k in tool.inputSchema.properties),tool.name);
 }
});

test('goal and task work remain distinct schemas with unchanged effect metadata',()=>{
 const byName=new Map(domainCatalog.map(x=>[x.name,x]));
 const goal=byName.get('goals.plan');
 const work=byName.get('work.plan');
 const delegate=byName.get('work.delegate');
 const list=byName.get('work.list');
 assert.ok(goal&&work&&delegate&&list);
 assert.deepEqual(goal.inputSchema.required,['goal_id','steps']);
 assert.deepEqual(work.inputSchema.required,['steps']);
 assert.deepEqual(delegate.inputSchema.required,['role','objective','acceptance']);
 for(const tool of [goal,work,delegate]){
  assert.equal(tool.annotations.readOnlyHint,false);
  assert.ok('goal_id' in tool.inputSchema.properties);
 }
 assert.deepEqual(list.annotations,{readOnlyHint:true,openWorldHint:false,destructiveHint:false});
 assert.equal(isProjectManagerOrderAction('goals.plan'),true);
 assert.equal(isProjectManagerOrderAction('goals.complete'),false);
});

test('role ACL and temporary grants remain outside the catalog',()=>{
 const manager=new Set(capabilitiesForRole('manager').map(x=>x.name));
 const docs=new Set(capabilitiesForRole('documentation').map(x=>x.name));
 assert.ok(manager.has('goals.plan'));
 assert.ok(manager.has('work.review'));
 assert.ok(!docs.has('goals.plan'));
 assert.ok(!docs.has('tasks.delete'));
 assert.ok(docs.has('documents.update'));
 assert.ok(!docs.has('tasks.close'));
 const temporary=new Set(toolsForSession('testing',false,['documents.update']).map(x=>x.name));
 assert.ok(temporary.has('documents.update'),'an allowlisted assignment grant adds only that tool');
 assert.ok(!new Set(toolsForSession('testing').map(x=>x.name)).has('documents.update'));
});

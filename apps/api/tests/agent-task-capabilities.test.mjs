import test from 'node:test';
import assert from 'node:assert/strict';
import {toolsForRole,toolsForSession,readSessionToolGrants,capabilitiesForRole} from '../dist/agent-tools.js';
import {normalizeTaskToolGrants,restrictChildToolGrants,taskGrantableTools} from '../dist/modules/agents/domain/tool-capabilities.js';
import {delegateWork,planWork,installTaskCapabilityGrants} from '../dist/modules/agents/infrastructure/work-assignments.js';

const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const processId='00000000-0000-4000-8000-000000000003';
const workSession={role:'testing',project_id:projectId,task_id:taskId,process_id:processId,read_only:false};

test('grantable tools contain only bounded, audited, non-owner project operations',()=>{
 assert.ok(taskGrantableTools.includes('documents.update'));
 assert.ok(!taskGrantableTools.includes('qa.retry'));
 assert.ok(!taskGrantableTools.includes('tasks.close'));
 assert.ok(!taskGrantableTools.includes('workflow.release_task'));
 assert.deepEqual(normalizeTaskToolGrants(['documents.update','documents.update']),['documents.update']);
 assert.throws(()=>normalizeTaskToolGrants(['tasks.delete']),/нельзя передать/);
 assert.throws(()=>normalizeTaskToolGrants(['qa.retry']),/нельзя передать/);
 assert.throws(()=>restrictChildToolGrants(['documents.update'],[]),/Нельзя передавать права/);
 assert.deepEqual(restrictChildToolGrants(['documents.update'],['documents.update']),['documents.update']);
});

test('effective tools are role-neutral only during an authorized non-read-only assignment',()=>{
 const basic=toolsForRole('testing').map(t=>t.name);
 assert.ok(!basic.includes('documents.update'));
 assert.ok(toolsForSession('testing',false,['documents.update']).some(t=>t.name==='documents.update'));
 assert.ok(toolsForSession('architect',false,['documents.update']).some(t=>t.name==='documents.update'));
 assert.ok(!toolsForSession('testing',true,['documents.update']).some(t=>t.name==='documents.update'));
 assert.ok(!toolsForSession('testing',false,['documents.update']).some(t=>t.name==='tasks.close'));
 assert.ok(capabilitiesForRole('testing',false,'documents',['documents.update']).some(t=>t.name==='documents.update'));
});

test('assignment DB scope uses project, task, role, live status and current specification',async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  return {rows:[{granted_tools:['documents.update']}],rowCount:1};
 }};
 const result=await readSessionToolGrants(db,workSession);
 assert.deepEqual(result,['documents.update']);
 assert.deepEqual(calls[0].args,[processId,projectId,taskId,'testing']);
 assert.match(calls[0].sql,/a.status='running'/);
 assert.match(calls[0].sql,/t.spec_version=a.spec_version/);
 assert.match(calls[0].sql,/p.agents_running=true/);
 assert.deepEqual(await readSessionToolGrants(db,{...workSession,read_only:true}),[]); // no grants in reader mode
 assert.equal(calls.length,1);
});

test('stale or foreign assignments immediately lose effective capabilities',async()=>{
 const db={query:async()=>({rows:[],rowCount:0})};
 assert.deepEqual(await readSessionToolGrants(db,workSession),[]);
 assert.deepEqual(await readSessionToolGrants(db,{...workSession,task_id:null}),[]);
 assert.deepEqual(await readSessionToolGrants(db,{...workSession,process_id:null}),[]);
});

test('new migration is additive and can be applied without rewriting prior work',async()=>{
 const statements=[];
 await installTaskCapabilityGrants({query:async sql=>{statements.push(sql);return {rows:[],rowCount:0};}});
 assert.match(statements[0],/ADD COLUMN IF NOT EXISTS granted_tools text\[\]/);
 assert.doesNotMatch(statements[0],/DROP TABLE|DELETE FROM/);
});

test('delegation grants exactly requested tools and rejects escalation by children',async()=>{
 const queries=[];
 const db={query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes('SELECT id,stage,spec_version'))return {rows:[{stage:'analysis',spec_version:2}],rowCount:1};
  if(sql.includes('SELECT id,role,parent_id,granted_tools'))return {rows:[{id:processId,role:'testing',parent_id:null,granted_tools:[]}],rowCount:1};
  if(sql.includes('count(*)::int AS n'))return {rows:[{n:0}],rowCount:1};
  if(sql.includes('SELECT id,status,granted_tools'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:1};
 }};
 await delegateWork(db,{projectId,taskId,sourceRole:'manager',role:'testing',objective:'Check user interface via browser',
  acceptance:'Provide independently verifiable acceptance evidence',tools:['documents.update']});
 const inserted=queries.find(q=>q.sql.startsWith('INSERT INTO agent_work_assignments'));
 assert.deepEqual(inserted.args.at(-1),['documents.update']);
 await assert.rejects(delegateWork(db,{projectId,taskId,sourceRole:'testing',role:'documentation',
  objective:'Update the documentation based on QA',acceptance:'All documents reflect current evidence',
  parentId:processId,tools:['documents.update']}),/Нельзя передавать права/);
});

test('DAG work plans persist tool grants as part of each assignment',async()=>{
 const inserts=[];
 const db={query:async(sql,args)=>{
  if(sql.includes('SELECT id,stage,spec_version'))return {rows:[{stage:'analysis',spec_version:2}],rowCount:1};
  if(sql.includes('count(*)::int AS n'))return {rows:[{n:0}],rowCount:1};
  if(sql.includes('INSERT INTO agent_work_assignments'))inserts.push(args);
  return {rows:[],rowCount:1};
 }};
 await planWork(db,{projectId,taskId,sourceRole:'manager',steps:[
  {key:'docs',role:'architect',objective:'Review architecture documentation',
   acceptance:'Produce an independently reviewed update',needs:[],tools:['documents.update']}
 ]});
 assert.deepEqual(inserts[0].at(-1),['documents.update']);
});

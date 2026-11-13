import test from 'node:test';
import assert from 'node:assert/strict';
import {createQaPlanActivity} from '../dist/modules/quality/application/prepare-qa-plan.js';

const ids={
 projectId:'123e4567-e89b-42d3-a456-426614174002',
 taskId:'123e4567-e89b-42d3-a456-426614174003',
 runId:'123e4567-e89b-42d3-a456-426614174004'
};
const sha='a'.repeat(40);

function fixture({enabled=true,questions=false,commitSha=sha,reviewSha=sha,reviewStatus='current',count=3,
 failure=null,logFailure=false}={}){
 const queries=[],events=[],activities=[],prompts=[],agentCalls=[],notes=[],prepared=[];
 const db={query:async(sql,args=[])=>{
  queries.push({sql,args});
  if(sql.startsWith('SELECT model,reasoning,enabled FROM project_ai_settings'))
   return {rows:[{model:'gpt-6',reasoning:'medium',enabled}],rowCount:1};
  if(sql.startsWith('SELECT spec_reviewed_commit,spec_review_status FROM tasks'))
   return {rows:[{spec_reviewed_commit:reviewSha,spec_review_status:reviewStatus}],rowCount:1};
  return {rows:[],rowCount:1};
 }};
 const activity=createQaPlanActivity({
  pool:db,
  failNonRetryable:message=>Object.assign(new Error(message),{nonRetryable:true}),
  event:async(...args)=>events.push(args),
  recordActivity:async(...args)=>activities.push(args),
  pendingQuestions:async()=>questions,
  prEvidence:async()=>({commitSha,patch:'diff for QA evidence',summary:'PR summary'}),
  loadKnowledge:async()=>({documents:'Approved specification',modules:'Check visual and API behavior'}),
  taskHandoffContext:async()=> 'Owner approved tests in task chat',
  prepareDocumentation:async(args,ask)=>{
   prepared.push(args);
   await ask('Generate reproducible test cases for current PR');
   if(failure)throw new Error(failure);
   return count;
  },
  recordPrompt:async entry=>{
   prompts.push(entry);
   if(logFailure)throw Error('Prompt audit unavailable');
  },
  askQaAgent:async(...args)=>{
   agentCalls.push(args);
   return '{"cases": []}';
  },
  recordNote:async entry=>notes.push(entry)
 });
 return {activity,queries,events,activities,prompts,agentCalls,notes,prepared};
}
const statuses=f=>f.queries.filter(x=>x.sql.startsWith('UPDATE requirement_review_runs')).map(x=>x.sql.includes("status='running'")?'running':x.sql.includes("status='completed'")?'completed':'failed');

test('successful QA design preserves evidence, prompts, project linkage and audit milestones',async()=>{
 const f=fixture();
 const n=await f.activity(ids);
 assert.equal(n,3);
 assert.deepEqual(statuses(f),['running','completed']);
 assert.equal(f.prepared.length,1);
 const {contextSupplement,...originalArgs}=f.prepared[0];
 assert.deepEqual(originalArgs,{...ids,implementationEvidence:'diff for QA evidence'});
 assert.match(contextSupplement,/Approved specification/);
 assert.match(contextSupplement,/Owner approved tests/);
 assert.equal(f.prompts.length,1);
 assert.deepEqual(f.prompts[0].role,'testing');
 assert.deepEqual(f.prompts[0].operation,'qa_plan');
 assert.match(f.prompts[0].prompt,/Generate reproducible test cases for current PR/);
 assert.equal(f.agentCalls.length,1);
 assert.equal(f.agentCalls[0][1],ids.projectId);
 assert.equal(f.agentCalls[0][2],ids.taskId);
 assert.equal(f.agentCalls[0][3].model,'gpt-6');
 assert.equal(f.agentCalls[0][4],ids.runId);
 assert.equal(f.queries.some(q=>q.sql.includes('INSERT INTO knowledge_artifact_links')),true);
 assert.equal(f.notes.length,1);
 assert.equal(f.notes[0].sourceKey,'test-plan:'+ids.runId);
 assert.match(f.notes[0].body,/не подтверждение прохождения тестов/);
 assert.deepEqual(f.activities.map(x=>x[4]),['running','completed']);
 assert.deepEqual(f.events.map(x=>x[3]),['test_design_started','test_design_ready']);
});

test('disabled AI is terminal before writing any progress or invoking QA',async()=>{
 const f=fixture({enabled:false});
 await assert.rejects(f.activity(ids),e=>e.nonRetryable&&/AI отключён/.test(e.message));
 assert.equal(f.events.length,0);
 assert.equal(f.activities.length,0);
 assert.equal(f.prepared.length,0);
 assert.deepEqual(statuses(f),[]);
});

test('unanswered specialist questions block full plan but allow simplified plan',async()=>{
 const blocked=fixture({questions:true});
 await assert.rejects(blocked.activity(ids),/вопросы участников процесса/);
 assert.deepEqual(statuses(blocked),['running','failed']);
 assert.deepEqual(blocked.activities.map(x=>x[4]),['running','failed']);
 assert.deepEqual(blocked.events.map(x=>x[3]),['test_design_started','test_design_failed']);
 assert.equal(blocked.prepared.length,0);

 const simplified=fixture({questions:true,reviewSha:'outdated',reviewStatus:'pending'});
 await simplified.activity({...ids,simplified:true});
 assert.deepEqual(statuses(simplified),['running','completed']);
 assert.equal(simplified.queries.some(x=>x.sql.includes("UPDATE tasks SET spec_review_status='current'")),true);
 assert.equal(simplified.prepared[0].simplified,true);
});

test('PR SHA must be present and current after analyst review',async()=>{
 const noSha=fixture({commitSha:''});
 await assert.rejects(noSha.activity(ids),/Нет коммита PR/);
 assert.deepEqual(statuses(noSha),['running','failed']);
 const stale=fixture({reviewSha:'b'.repeat(40)});
 await assert.rejects(stale.activity(ids),/Код PR изменился/);
 assert.equal(stale.prepared.length,0);
 const rejected=fixture({reviewStatus:'needs_approval'});
 await assert.rejects(rejected.activity(ids),/Код PR изменился/);
 assert.equal(rejected.agentCalls.length,0);
});

test('failed QA plan writing records concrete failure; prompt-audit outage remains nonblocking',async()=>{
 const f=fixture({failure:'QA doc parser failed',logFailure:true});
 await assert.rejects(f.activity(ids),/QA doc parser failed/);
 assert.equal(f.prompts.length,1);
 assert.equal(f.agentCalls.length,1,'Codex response was requested despite audit outage');
 assert.deepEqual(statuses(f),['running','failed']);
 assert.equal(f.notes.length,0);
 assert.equal(f.queries.some(x=>x.sql.includes('INSERT INTO knowledge_artifact_links')),false);
 assert.deepEqual(f.activities.map(x=>x[4]),['running','failed']);
 assert.deepEqual(f.events.map(x=>x[3]),['test_design_started','test_design_failed']);
});

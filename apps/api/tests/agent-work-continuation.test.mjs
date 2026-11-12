import test from 'node:test';
import assert from 'node:assert/strict';
import {planManagerStageMove} from '../dist/task-stage-operations.js';
import {toolsForRole,toolAllowedForRole} from '../dist/agent-tools.js';
import {readTaskWorkBrief} from '../dist/task-work-brief.js';

test('only PM can mutate workflow, cancel work or rerun QA; specialists have scoped read tools',()=>{
 for(const role of ['manager','analyst','business_analyst','analysis','development','testing','documentation','devops']){
  const reader=toolsForRole(role,true).map(tool=>tool.name);
  for(const name of ['tasks.read','project.context','knowledge.context','processes.list'])
   assert.ok(reader.includes(name),role+' must see '+name);
  assert.ok(!reader.includes('workflow.move_task'));
  assert.ok(!reader.includes('tasks.cancel'));
 }
 for(const op of ['workflow.move_task','tasks.cancel','tasks.delete','qa.retry','workflow.release_task'])
  assert.equal(toolAllowedForRole('manager',op),true,op);
 for(const role of ['analyst','business_analyst','analysis','development','testing','documentation','devops']){
  for(const op of ['workflow.move_task','tasks.cancel','tasks.delete','qa.retry','workflow.release_task'])
   assert.equal(toolAllowedForRole(role,op),false,role+' must not own '+op);
 }
 for(const role of ['analysis','development','testing','documentation','devops'])
  assert.ok(toolAllowedForRole(role,'tasks.read'));
});

test('PM transitions never bypass owner questions, QA, deployment or post-merge constraints',()=>{
 const cases=[
  ['backlog','analysis',false,'patch'],['analysis','development',false,'blocked'],
  ['analysis','analysis',false,'reanalyze'],['testing','analysis',true,'reanalyze'],
  ['merge_queue','analysis',true,'reanalyze'],['testing','development',true,'developer_rework'],
  ['merge_queue','development',true,'developer_rework'],['testing','development',false,'blocked'],
  ['development','testing',true,'resume_development'],['development','testing',false,'blocked'],
  ['testing','merge_queue',true,'apply_qa'],['merge_queue','testing',true,'retry_qa'],
  ['development','merge_queue',true,'blocked'],['testing','deployment',true,'blocked'],
  ['merge_queue','done',true,'blocked'],['deployment','testing',true,'blocked'],
  ['documentation','development',true,'blocked'],['done','analysis',true,'blocked']
 ];
 for(const [from,to,hasPr,expected] of cases)
  assert.equal(planManagerStageMove(from,to,hasPr).operation,expected,from+' → '+to);
});

test('new owner comments, durable QA defects and existing PR survive bounded context gathering',async()=>{
 const now='2026-11-12T12:00:00Z';
 const pool={query:async(sql)=>{
  if(sql.includes('FROM task_agent_notes'))
   return {rows:[{kind:'resolution',author_stage:'human',author_name:'Владелец',target_stage:'all',
     body:'При изменении ширины круги должны масштабироваться без смещения',status:'resolved',created_at:now}]};
  if(sql.includes('FROM manager_messages'))
   return {rows:[{role:'user',body:'Не переделывай страницу. Поправь только масштабирование.',created_at:now}]};
  if(sql.includes('FROM task_events'))
   return {rows:[{event:'tests_failed',detail:'CSS ломается при ширине 360px',created_at:now}]};
  if(sql.includes('FROM ai_task_runs'))
   return {rows:[{status:'completed',message:'10 кругов уже созданы',pr_url:'https://github.com/example/repo/pull/9',created_at:now}]};
  if(sql.includes('FROM ai_test_runs'))
   return {rows:[{status:'completed',verdict:'failed',report:{summary:'Визуальный тест не пройден',caseResults:[
    {case_id:'responsive',result:'failed',evidence:'На 360px последние круги обрезаны'}
   ]},created_at:now}]};
  throw Error('unexpected query: '+sql);
 }};
 const brief=await readTaskWorkBrief(pool,'project','task',3500);
 assert.match(brief,/Не переделывай страницу/);
 assert.match(brief,/масштабироваться/);
 assert.match(brief,/pull\/9/);
 assert.match(brief,/QA/);
 assert.match(brief,/360px/);
 assert.match(brief,/Не.*повторяй с нуля/);
 assert.ok(brief.length<=3500);
});

test('unrelated user inputs cannot turn a QA result into success by moving stage',()=>{
 assert.equal(planManagerStageMove('testing','done',true).operation,'blocked');
 assert.equal(planManagerStageMove('testing','merge_queue',true).operation,'apply_qa');
 assert.equal(planManagerStageMove('merge_queue','deployment',true).operation,'blocked');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskStageAnalysisActivity} from '../dist/modules/execution/application/task-stage-analysis.js';

const runId='123e4567-e89b-42d3-a456-426614174000';
const taskId='123e4567-e89b-42d3-a456-426614174001';
const projectId='123e4567-e89b-42d3-a456-426614174002';
const ready={outcome:'ready',summary:'Требования уточнены и переданы разработчику',refined_description:'Сохранить все существующие критерии приёмки, добавить конкретную проверку готовности.',questions:[],documentation_notes:[]};

function fixture({status='queued',output=ready,freshInputs=false,openQuestions=false,questionsFromTask=[],cancelDuringCompletion=false}={}){
 const statements=[],events=[],assistantPrompts=[],task={
  id:taskId,project_id:projectId,title:'Implement request',description:'Initial requirements and acceptance criteria',
  stage:'analysis',analysis_state:'processing',clarification_questions:questionsFromTask,spec_version:2
 };
 const run={id:runId,project_id:projectId,task_id:taskId,spec_version:2,status};
 let released=0,commits=0,rollbacks=0;
 const q=async(sql,args=[])=>{
  statements.push({sql,args});
  if(sql==='BEGIN')return {rows:[],rowCount:0};
  if(sql==='COMMIT'){commits++;return {rows:[],rowCount:0};}
  if(sql==='ROLLBACK'){rollbacks++;return {rows:[],rowCount:0};}
  if(sql.startsWith('SELECT id,project_id,task_id,spec_version,status FROM agent_analysis_runs'))return {rows:[{...run}],rowCount:1};
  if(sql.startsWith("UPDATE agent_analysis_runs SET status='running'")){
   if(!['queued','running'].includes(run.status))return {rows:[],rowCount:0};
   run.status='running';
   return {rows:[{id:runId,updated_at:'2026-11-13T10:00:00Z'}],rowCount:1};
  }
  if(sql.startsWith('SELECT id,project_id,title,description,stage,analysis_state'))return {rows:[{...task}],rowCount:1};
  if(sql.startsWith('SELECT kind,body,answer,answer_author FROM task_agent_notes'))return {rows:[],rowCount:0};
  if(sql.startsWith('SELECT agent_name,agent_instructions FROM workflow_stages'))return {rows:[{agent_name:'System analyst',agent_instructions:'Preserve behavior'}],rowCount:1};
  if(sql.startsWith('SELECT status FROM agent_analysis_runs')&&sql.includes('FOR UPDATE'))return {rows:[{status:run.status}],rowCount:1};
  if(sql.startsWith('SELECT * FROM tasks')&&sql.includes('FOR UPDATE'))return {rows:[{...task}],rowCount:1};
  if(sql.includes('UNION ALL SELECT 1 FROM manager_messages'))return {rows:freshInputs?[{one:1}]:[],rowCount:freshInputs?1:0};
  if(sql.startsWith('SELECT 1 FROM task_agent_notes n WHERE n.task_id='))return {rows:openQuestions?[{one:1}]:[],rowCount:openQuestions?1:0};
  if(sql.startsWith('UPDATE tasks SET title=$3')){task.description=args[3];return {rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE tasks SET analysis_state=')){
   const found=sql.match(/analysis_state='([^']+)'/);
   if(found)task.analysis_state=found[1];
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith("UPDATE agent_analysis_runs SET status='completed'")){
   if(run.status!=='cancelled')run.status='completed';
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith('UPDATE agent_analysis_runs SET status=$2')){
   run.status=args[1];
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith("UPDATE agent_analysis_runs SET status='failed'")){
   run.status='failed';return {rows:[],rowCount:1};
  }
  if(sql.startsWith('INSERT INTO task_agent_notes')||sql.startsWith('INSERT INTO task_events'))return {rows:[],rowCount:1};
  throw new Error('Unexpected SQL: '+sql);
 };
 const pool={query:q,connect:async()=>({query:q,release:()=>released++})};
 const runAnalysis=createTaskStageAnalysisActivity({
  pool,
  updateSpecification:async(db,project,task,title,description)=>db.query(
   "UPDATE tasks SET title=$3,description=$4,spec_review_status='current',spec_reviewed_version=spec_version,spec_review_note='',spec_reviewed_commit='',updated_at=now() WHERE project_id=$1 AND id=$2",
   [project,task,title,description]),
  taskHandoffContext:async(project,task,stage)=>{
   assert.deepEqual([project,task,stage],[projectId,taskId,'analysis']);
   return 'History of the task';
  },
  assistantCompletion:async(prompt,project,task,operation,process)=>{
   assistantPrompts.push({prompt,project,task,operation,process});
   if(cancelDuringCompletion)run.status='cancelled';
   return JSON.stringify(output);
  },
  event:async(...args)=>{events.push(args);}
 });
 return {runAnalysis,statements,run,task,events,assistantPrompts,released:()=>released,commits:()=>commits,rollbacks:()=>rollbacks};
}

test('completed analysis is never sent to Codex again',async()=>{
 const f=fixture({status:'completed'});
 await f.runAnalysis(runId);
 assert.equal(f.statements.length,1);
 assert.equal(f.assistantPrompts.length,0);
 assert.equal(f.events.length,0);
});

test('ready outcome updates specification and generates one durable handoff',async()=>{
 const f=fixture();
 await f.runAnalysis(runId);
 assert.equal(f.run.status,'completed');
 assert.equal(f.task.analysis_state,'ready_for_development');
 assert.equal(f.commits(),1);
 assert.equal(f.rollbacks(),0);
 assert.equal(f.released(),1);
 assert.equal(f.assistantPrompts.length,1);
 assert.deepEqual([f.assistantPrompts[0].project,f.assistantPrompts[0].task,f.assistantPrompts[0].operation,f.assistantPrompts[0].process],
  [projectId,taskId,'task_analysis',runId]);
 const handoff=f.statements.filter(x=>x.sql.includes("'handoff'"));
 assert.equal(handoff.length,1);
 assert.equal(handoff[0].args[5],'task-analysis:'+runId);
 assert.deepEqual(f.events[0].slice(0,4),[projectId,runId,'analysis','completed']);
});

test('only explicit owner questions block a ready result; answered context is not a blocker',async()=>{
 const f=fixture({openQuestions:true});
 await f.runAnalysis(runId);
 assert.equal(f.task.analysis_state,'waiting_questions');
 assert.equal(f.run.status,'completed');
 assert.equal(f.statements.some(x=>x.sql.includes("'analysis_completed'")),false);
});

test('unresolved product ambiguity records owner questions and stops development handoff',async()=>{
 const f=fixture({output:{outcome:'needs_input',summary:'Необходимо решение владельца по логике',refined_description:ready.refined_description,
  questions:['Выбрать поведение после отмены операции?'],documentation_notes:['Обновить руководство при утверждении поведения']}});
 await f.runAnalysis(runId);
 assert.equal(f.run.status,'waiting');
 assert.equal(f.task.analysis_state,'waiting_questions');
 assert.equal(f.statements.filter(x=>x.sql.includes("'question'")&&x.sql.includes('requires_customer')).length,1);
 assert.equal(f.statements.filter(x=>x.sql.includes("'observation'")).length,1);
 assert.deepEqual(f.events[0].slice(0,4),[projectId,runId,'analysis','waiting']);
});

test('new human input during completion requeues analysis rather than overwriting it',async()=>{
 const f=fixture({freshInputs:true});
 await f.runAnalysis(runId);
 assert.equal(f.run.status,'completed');
 assert.equal(f.task.analysis_state,'new');
 assert.equal(f.commits(),1);
 assert.equal(f.statements.some(x=>x.sql.startsWith('UPDATE tasks SET title=$3')),false);
 assert.equal(f.statements.filter(x=>x.sql.includes("'analysis_inputs_changed'")).length,1);
});

test('cancelled analysis cannot apply a late Codex completion',async()=>{
 const f=fixture({cancelDuringCompletion:true});
 await f.runAnalysis(runId);
 assert.equal(f.run.status,'cancelled');
 assert.equal(f.statements.some(x=>x.sql.startsWith('UPDATE tasks SET title=$3')),false);
 assert.equal(f.commits(),1);
 assert.equal(f.events.length,0);
});

test('invalid structured response fails explicitly instead of marking analysis ready',async()=>{
 const f=fixture({output:{...ready,outcome:'ready',questions:['Unexpected owner question']}});
 await f.runAnalysis(runId);
 assert.equal(f.run.status,'failed');
 assert.equal(f.task.analysis_state,'failed');
 assert.equal(f.events[0][3],'failed');
 assert.equal(f.commits(),0);
});

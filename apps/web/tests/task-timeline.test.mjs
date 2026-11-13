import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTaskTimeline} from '../src/features/tasks/task-timeline.ts';
const empty={taskId:'task1',messages:[],notes:[],events:[],processEvents:[],aiRuns:[],activeTaskId:null,taskTestRuns:[],testRuns:[]};
test('task timeline merges task discussion, notes, events and runs in chronological order',()=>{
 const entries=buildTaskTimeline({...empty,
  messages:[{id:'m',role:'user',body:'Please implement',created_at:'2026-01-01T00:01:00Z'}],
  notes:[{id:'n',author_name:'QA',target_stage:'development',kind:'question',body:'Need test',status:'open',created_at:'2026-01-01T00:03:00Z'}],
  events:[{id:'e',event:'created',detail:'Task created',created_at:'2026-01-01T00:00:00Z'}],
  processEvents:[{id:'p',process_kind:'testing',stage:'blocked',level:'error',detail:'No executable test',created_at:'2026-01-01T00:02:00Z'}]
 });
 assert.deepEqual(entries.map(x=>x.id),['evt-e','msg-m','process-p','note-n']);
 assert.match(entries[2].title,/Тестировщик/);
 assert.equal(entries[2].failed,true);
 assert.match(entries[3].text,/Ожидает ответа/);
});
test('QA blocked never gets a success label and retains checks and case evidence',()=>{
 const run={id:'qa',task_id:'task1',status:'completed',message:'incomplete',verdict:'blocked',created_at:'2026-01-01T01:00:00Z',report:{
  summary:'Unable to verify browser',checks:[{name:'frontend',result:'blocked',details:'Chrome not available'}],
  findings:[{severity:'high',description:'No browser'}],caseResults:[{case_id:'c1',result:'blocked',evidence:'No screenshots'}]
 }};
 const [entry]=buildTaskTimeline({...empty,testRuns:[run]});
 assert.equal(entry.kind,'run');
 assert.equal(entry.title,'Тестирование требует внимания');
 assert.match(entry.text,/Chrome not available/);
 assert.match(entry.text,/No screenshots/);
});
test('current active task timeline prioritizes live QA run over stale cached result',()=>{
 const archived={id:'old',task_id:'task1',status:'completed',verdict:'passed',message:'old',created_at:'2026-01-01T01:00:00Z'};
 const live={id:'live',task_id:'task1',status:'running',message:'currently testing',created_at:'2026-01-01T02:00:00Z'};
 const entries=buildTaskTimeline({...empty,activeTaskId:'task1',testRuns:[archived],taskTestRuns:[live]});
 assert.deepEqual(entries.map(x=>x.id),['test-live']);
 assert.equal(entries[0].title,'AI-тестировщик работает');
});

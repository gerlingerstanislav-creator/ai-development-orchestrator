import test from 'node:test';
import assert from 'node:assert/strict';
import {readPmTaskGoal} from '../dist/pm-task-goal.js';

const project='00000000-0000-4000-8000-000000000001';
const task='00000000-0000-4000-8000-000000000002';

function store(active){
 const queries=[];
 return {
  queries,
  query:async (sql,args)=>{
   queries.push({sql,args});
   if(sql.includes('SELECT id,title,display_number,stage,analysis_state,type'))return {
    rows:[{id:task,title:'Проверить пользовательский интерфейс',display_number:36,stage:'development',analysis_state:'approved',type:'task'}]
   };
   return {rows:[{active}]};
  }
 };
}

test('PM task goal sees queued and running specialist assignments without PR',async()=>{
 const db=store(true);
 const result=await readPmTaskGoal(db,project,task);
 assert.equal(result.status,'running');
 assert.deepEqual(db.queries[1].args,[task,project]);
 assert.match(db.queries[1].sql,/FROM agent_work_assignments/);
 assert.match(db.queries[1].sql,/status IN \('queued','running'\)/);
});

test('PM task goal requires action after all executions become terminal',async()=>{
 const db=store(false);
 const result=await readPmTaskGoal(db,project,task);
 assert.equal(result.status,'needs_action');
 assert.match(result.reason,/не выполняется активный процесс/);
});

test('PM goal watches development, QA and delegated work for bug and improvement types',async()=>{
 for(const type of ['bug','improvement']){
  const db=store(true);
  const original=db.query;
  db.query=async(sql,args)=>{
   const result=await original(sql,args);
   if(sql.includes('SELECT id,title,display_number,stage,analysis_state,type'))
    result.rows[0].type=type;
   return result;
  };
  assert.equal((await readPmTaskGoal(db,project,task)).status,'running');
  assert.equal(db.queries.length,2);
 }
});

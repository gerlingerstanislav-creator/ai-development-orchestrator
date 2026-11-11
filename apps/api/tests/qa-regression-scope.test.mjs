import test from 'node:test';
import assert from 'node:assert/strict';
import {qaRegressionScope,readQaPlan} from '../dist/qa-plan.js';

test('QA regression scope includes own/shared cases and only completed tasks',()=>{
 const where=qaRegressionScope('c',2,3);
 assert.match(where,/c\.source_task_id IS NULL/);
 assert.match(where,/c\.source_task_id=\$3/);
 assert.match(where,/regression_task\.project_id=\$2/);
 assert.match(where,/regression_task\.stage='done'/);
 assert.throws(()=>qaRegressionScope('c;DROP TABLE tasks',2,3));
});
test('reading pre-existing QA plan filters out regression from unmerged tasks',async()=>{
 const queries=[];
 const pool={query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes('FROM qa_test_plans'))return {rowCount:1,rows:[{id:'plan',summary:'QA',spec_version:2,spec_hash:'h'}]};
  return {rowCount:1,rows:[{id:'case-1',title:'Own test',purpose:'targeted'}]};
 }};
 const result=await readQaPlan(pool,'project-1','task-1');
 assert.equal(result.cases.length,1);
 assert.deepEqual(queries[1].args,['plan','project-1','task-1']);
 assert.match(queries[1].sql,/p\.purpose='targeted' OR/);
 assert.match(queries[1].sql,/regression_task\.stage='done'/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {qaWaiverAssessment} from '../dist/qa-waiver.js';

const report=capabilities=>({
 commit:'a'.repeat(40),
 capabilities,
 summary:'Core validation unavailable',
 findings:[],
 checks:[{name:'Python execution',result:'not_run',details:'Python test process cannot start'}],
 caseResults:[{case_id:'case-1',result:'blocked',reason:'environment_unavailable',evidence:'python3 missing; cannot execute retry_delivery.py in sandbox'}]
});
const run=capabilities=>({
 id:'run-1',task_id:'task-1',status:'completed',verdict:'blocked',
 qa_spec_version:1,qa_plan_snapshot:{cases:[{id:'case-1',title:'SQLite delivery retries'}]},
 report:report(capabilities)
});
test('cannot grant a QA waiver for a missing supported Python runtime',()=>{
 const assessment=qaWaiverAssessment(run('node: available\npython3: unavailable\npytest: unavailable'));
 assert.equal(assessment.eligible,false);
 assert.match(assessment.blockers.join(' '),/Python 3/);
});
test('waiver assessment does not misclassify a working Python runtime as an infrastructure failure',()=>{
 const assessment=qaWaiverAssessment(run('node: available\npython3: available\npython3_runtime: ok'));
 assert.ok(!assessment.blockers.some(x=>x.includes('QA запускается без Python 3')));
});

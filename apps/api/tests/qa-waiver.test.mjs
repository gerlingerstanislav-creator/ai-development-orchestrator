import test from 'node:test';
import assert from 'node:assert/strict';
import {qaWaiverAssessment} from '../dist/qa-waiver.js';

const sha='c'.repeat(40);
const base=()=>({
 id:'00000000-0000-4000-8000-000000000007',
 task_id:'00000000-0000-4000-8000-000000000008',
 status:'completed',verdict:'blocked',qa_spec_version:3,
 qa_plan_snapshot:{cases:[
  {id:'a',title:'API responds with correct payload',priority:'high'},
  {id:'b',title:'User can navigate visually',priority:'normal'}
 ]},
 report:{commit:sha,summary:'API verified, browser is unavailable',findings:[],
  checks:[{name:'API contract',result:'passed',details:'curl and assertions succeeded'}],
  caseResults:[
   {case_id:'a',result:'passed',reason:'executed',evidence:'HTTP 200 and payload were verified'},
   {case_id:'b',result:'blocked',reason:'tool_unavailable',evidence:'Chromium and Playwright are not installed in QA container'}
  ]}
});
test('allows a documented tooling gap, never considers it a passing test',()=>{
 const r=qaWaiverAssessment(base());
 assert.equal(r.eligible,true);
 assert.equal(r.passed,1);
 assert.equal(r.unverified.length,1);
 assert.equal(r.unverified[0].title,'User can navigate visually');
});
test('rejects reported regressions, test failures and confirmed findings',()=>{
 const a=base();a.report.caseResults[0].result='failed';assert.equal(qaWaiverAssessment(a).eligible,false);
 const b=base();b.report.checks[0].result='failed';assert.equal(qaWaiverAssessment(b).eligible,false);
 const c=base();c.report.findings=[{severity:'major',description:'Broken response'}];assert.equal(qaWaiverAssessment(c).eligible,false);
});
test('rejects unknown, undocumented or merely skipped scenarios',()=>{
 const a=base();a.report.caseResults[1].reason='unknown';assert.equal(qaWaiverAssessment(a).eligible,false);
 const b=base();b.report.caseResults[1].evidence='Cannot';assert.equal(qaWaiverAssessment(b).eligible,false);
 const c=base();c.report.caseResults[1].result='passed';assert.equal(qaWaiverAssessment(c).eligible,false);
 const d=base();d.report.caseResults.pop();assert.equal(qaWaiverAssessment(d).eligible,false);
});
test('requires completed blocked run with tested commit, spec version and plan',()=>{
 const a=base();a.status='failed';assert.equal(qaWaiverAssessment(a).eligible,false);
 const b=base();b.verdict='failed';assert.equal(qaWaiverAssessment(b).eligible,false);
 const c=base();c.report.commit='';assert.equal(qaWaiverAssessment(c).eligible,false);
 const d=base();d.qa_spec_version=null;assert.equal(qaWaiverAssessment(d).eligible,false);
 const e=base();e.qa_plan_snapshot.cases=[];assert.equal(qaWaiverAssessment(e).eligible,false);
});

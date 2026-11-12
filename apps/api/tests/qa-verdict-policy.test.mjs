import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateQaRun} from '../dist/modules/quality/domain/qa-verdict.js';

const current={rowCount:1,rows:[{
 spec_version:3,spec_review_status:'current',spec_reviewed_version:3,
 spec_reviewed_commit:'abc123'
}]};
const case1={id:'qa-1',title:'Compiler output',description:'Check project builds'};
const evidence='Executed npm test and confirmed all assertions passed';
function run({
 cases=[case1],caseResults=[{case_id:'qa-1',result:'passed',reason:'executed',evidence}],
 remote={},snapshot={},status='completed',spec=current,message='Runner completed'
}={}){
 return evaluateQaRun({
  snapshot:{cases,...snapshot},status,message,qaSpecVersion:3,currentSpec:spec,
  remote:{
   verdict:'passed',testedCommit:'abc123',checks:[{result:'passed'}],
   caseResults,executionVerified:true,...remote
  }
 });
}
test('verified nonvisual QA checks pass with preserved report shape and commit',()=>{
 const result=run();
 assert.equal(result.verdict,'passed');
 assert.equal(result.adHoc,false);
 assert.equal(result.outcome,'Runner completed');
 assert.deepEqual(result.cases,[case1]);
 assert.deepEqual(result.report.caseResults,[{
  case_id:'qa-1',result:'passed',reason:'executed',evidence,browserVerified:false
 }]);
 assert.equal(result.report.commit,'abc123');
 assert.equal(result.report.spec_version,3);
 assert.equal(result.report.staleSpecification,false);
});
test('missing execution evidence never counts as a passed QA test',()=>{
 const short=run({caseResults:[{case_id:'qa-1',result:'passed',reason:'executed',evidence:'looks fine'}]});
 assert.equal(short.verdict,'blocked');
 assert.equal(short.checked[0].result,'blocked');
 const missing=run({caseResults:[]});
 assert.equal(missing.verdict,'blocked');
 assert.equal(missing.checked[0].result,'not_run');
 assert.match(missing.checked[0].evidence,/Нет подтверждённого/);
});
test('visual criteria require actual browser-client verification even with Chromium present',()=>{
 const visual={id:'qa-1',title:'Видимость восьми линий и различимость цветов'};
 const caps='qa_browser: playwright chromium available';
 const unverified=run({cases:[visual],remote:{capabilities:caps}});
 assert.equal(unverified.verdict,'blocked');
 assert.equal(unverified.checked[0].reason,'unverified');
 const verified=run({cases:[visual],remote:{capabilities:caps},
  caseResults:[{case_id:'qa-1',result:'passed',reason:'executed',evidence,
   browserVerified:true}]});
 assert.equal(verified.verdict,'passed');
 assert.equal(verified.checked[0].browserVerified,true);
 const absentBrowser=run({cases:[visual],remote:{capabilities:''},
  caseResults:[{case_id:'qa-1',result:'passed',reason:'executed',evidence,
   browserVerified:true}]});
 assert.equal(absentBrowser.verdict,'blocked');
 assert.equal(absentBrowser.checked[0].reason,'tool_unavailable');
});
test('actual failures outweigh success claims, while stale specifications block even failed runs',()=>{
 const failed=run({caseResults:[{case_id:'qa-1',result:'failed',reason:'executed',evidence:'Test exited with code 1'}]});
 assert.equal(failed.verdict,'failed');
 assert.equal(run({remote:{checks:[{result:'failed'}]}}).verdict,'failed');
 assert.equal(run({remote:{findings:[{severity:'high'}]}}).verdict,'failed');
 const stale=run({remote:{checks:[{result:'failed'}]},
  spec:{rowCount:1,rows:[{...current.rows[0],spec_version:4}]}});
 assert.equal(stale.verdict,'blocked');
 assert.equal(stale.report.staleSpecification,true);
 assert.equal(run({spec:{rowCount:0,rows:[]}}).verdict,'blocked');
});
test('completed QA needs cases, tested commit, check receipts and an up-to-date review',()=>{
 assert.equal(run({cases:[]}).verdict,'blocked');
 assert.equal(run({remote:{testedCommit:null}}).verdict,'blocked');
 assert.equal(run({remote:{checks:null}}).verdict,'blocked');
 assert.equal(run({spec:{rowCount:1,rows:[{...current.rows[0],spec_review_status:'pending'}]}}).verdict,'blocked');
 assert.equal(run({snapshot:{simplified:true},remote:{testedCommit:'other-sha'}}).verdict,'blocked');
});
test('single-pass QA is gated on executor verification and preserves checked count',()=>{
 const ok=run({snapshot:{singlePass:true}});
 assert.equal(ok.outcome,'Проверено 1 из 1.');
 const notVerified=run({snapshot:{singlePass:true},remote:{executionVerified:false}});
 assert.equal(notVerified.verdict,'blocked');
 const failedStatus=run({snapshot:{singlePass:true},status:'failed'});
 assert.equal(failedStatus.outcome,'Runner completed');
});
test('ad-hoc test cases are sanitized, deduplicated and invalid sets cannot pass',()=>{
 const ok=run({cases:[],snapshot:{singlePass:true,adHoc:true},
  remote:{cases:[{id:'qa-1',title:'Compile validation'},{id:'qa-1',title:'Compile validation'}]}});
 assert.equal(ok.cases.length,1);
 assert.equal(ok.adHoc,true);
 assert.equal(ok.verdict,'passed');
 const invalid=run({cases:[],snapshot:{singlePass:true,adHoc:true},
  remote:{cases:[{id:'qa-0',title:'Invalid identifier'}]}});
 assert.deepEqual(invalid.cases,[]);
 assert.equal(invalid.verdict,'blocked');
});
test('report strips oversized or non-JPEG screenshots and caps capabilities',()=>{
 const screenshots=[
  {mime:'image/jpeg',data:'YWJj'},
  {mime:'image/png',data:'YWJj'},
  {mime:'image/jpeg',data:'?!'},
  {mime:'image/jpeg',data:'b'.repeat(250001)},
  {mime:'image/jpeg',data:'YWJj'},
  {mime:'image/jpeg',data:'YWJj'},
  {mime:'image/jpeg',data:'YWJj'}
 ];
 const result=run({remote:{screenshots,capabilities:'a'.repeat(2000),summary:' QA summary '}});
 assert.equal(result.report.screenshots.length,3);
 assert.ok(result.report.screenshots.every(s=>s.mime==='image/jpeg'));
 assert.equal(result.report.capabilities.length,1500);
 assert.equal(result.report.summary,' QA summary ');
});

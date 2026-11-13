import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validEvidenceSha,evidenceViewport,browserEvidenceAssessment} from '../dist/task-evidence.js';

const sha='a'.repeat(40);
const fakeJpeg=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(180,7),Buffer.from([0xff,0xd9])]);
const shot=(width,height)=>({
 name:width+'x'+height+'-123e4567-e89b-42d3-a456-426614174000.jpg',
 mime:'image/jpeg',data:fakeJpeg.toString('base64'),
 sha256:createHash('sha256').update(fakeJpeg).digest('hex'),
 viewport:{width,height},origin:'isolated-local-browser'
});
const report=(shots=[shot(1440,900),shot(390,844)])=>({
 commit:sha,executionVerified:true,caseResults:[{case_id:'qa-1',result:'passed'}],
 checks:[{name:'browser',result:'passed'}],screenshots:shots
});

test('browser evidence requires a pinned full SHA and a recognizable viewport receipt',()=>{
 assert.equal(validEvidenceSha(sha),true);
 assert.equal(validEvidenceSha('HEAD'),false);
 assert.deepEqual(evidenceViewport(shot(390,844).name),{width:390,height:844});
 assert.equal(evidenceViewport('made-up.jpg'),null);
});

test('non-code completion needs both desktop and mobile, real receipts and successful QA',()=>{
 assert.equal(browserEvidenceAssessment(report(),sha).passed,true);
 assert.equal(browserEvidenceAssessment(report([shot(1440,900)]),sha).passed,false);
 assert.equal(browserEvidenceAssessment(report([shot(390,844)]),sha).passed,false);
 assert.equal(browserEvidenceAssessment({...report(),commit:'b'.repeat(40)},sha).passed,false);
 assert.equal(browserEvidenceAssessment({...report(),executionVerified:false},sha).passed,false);
 assert.equal(browserEvidenceAssessment({...report(),checks:[{result:'blocked'}]},sha).passed,false);
 assert.equal(browserEvidenceAssessment({...report(),caseResults:[{result:'failed'}]},sha).passed,false);
 assert.equal(browserEvidenceAssessment(report([shot(1440,900),{...shot(390,844),sha256:'0'.repeat(64)}]),sha).passed,false);
 assert.equal(browserEvidenceAssessment(report([shot(1440,900),{...shot(390,844),origin:'agent-generated'}]),sha).passed,false);
 assert.equal(browserEvidenceAssessment(report([shot(1440,900),{...shot(390,844),viewport:{width:400,height:900}}]),sha).passed,false);
});

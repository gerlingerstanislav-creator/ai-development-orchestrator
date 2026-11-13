import test from 'node:test';
import assert from 'node:assert/strict';
import {isGroundedPeerAnswer,createPeerQuestionResolution} from '../dist/modules/agents/application/peer-question-resolution.js';

const sources={
 specification:'The test must verify login before deployment.',
 conversation:'Owner approved the blue theme.',
 notes:'QA reported that mobile navigation is responsive.',
 pr:'src/app.ts: add timeout guard'
};
const answered=(source,quote)=>({status:'answered',answer:'Relevant, checked fact.',source,quote});

test('peer question accepts a quote from supplied evidence, not an assertion alone',()=>{
 assert.equal(isGroundedPeerAnswer(answered('specification','verify login'),sources,'Does the flow check credentials?'),true);
 assert.equal(isGroundedPeerAnswer(answered('pr','timeout guard'),sources,'How does PR handle expiry?'),true);
 assert.equal(isGroundedPeerAnswer(answered('pr','unverified action'),sources,'What changed?'),false);
 assert.equal(isGroundedPeerAnswer(answered('random','verify login'),sources,'What is required?'),false);
 assert.equal(isGroundedPeerAnswer({status:'answered',answer:'',source:'pr',quote:'timeout guard'},sources,'What changed?'),false);
 assert.equal(isGroundedPeerAnswer({status:'answered',answer:'A claim',source:'pr',quote:''},sources,'What changed?'),false);
});

test('peer consultation cannot quote the question itself as independent proof',()=>{
 assert.equal(isGroundedPeerAnswer(answered('specification','verify login'),sources,'Please verify login'),false);
 assert.equal(isGroundedPeerAnswer({status:'needs_tool',answer:'No CLI',source:'pr',quote:'timeout guard'},sources,'What changed?'),false);
 assert.equal(isGroundedPeerAnswer({status:'needs_customer',answer:'Need business input',source:'specification',quote:'verify login'},sources,'What changed?'),false);
});

test('peer service is constructed without spawning a Temporal worker or Runner call',()=>{
 const service=createPeerQuestionResolution({
  pool:{query:async()=>({rowCount:0,rows:[]})},
  prEvidence:async()=>({commitSha:'',patch:'',summary:''}),
  askRunnerAssistant:async()=>{throw Error('Must not call Runner when there are no questions');},
  event:async()=>{}
 });
 assert.equal(typeof service,'function');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {runAutonomousDocumentationAgent} from '../dist/modules/knowledge/application/autonomous-documentation-agent.js';

const createPorts=(overrides={})=>{
 let state='running';const prompts=[],events=[],progress=[],sessions=[];
 const ports={
  projectId:'project',processId:'import',message:'Read repository and create specifications',
  agentInstructions:async()=>'Project agent instructions',
  createSession:async()=>({id:'session',secret:'session-secret'}),
  finishSession:async id=>{sessions.push(id);},
  readState:async()=>({status:state,message:''}),
  readEvents:async()=>events,
  readLiveInstructions:async()=>[{body:'Preserve user-provided requirements'}],
  assertRunning:async()=>{},
  recordPrompt:async prompt=>{prompts.push(prompt);},
  onWorkStart:async()=>{},
  performRound:async()=>{state='completed';return 'Tools invoked';},
  onProgress:async(stage,detail)=>{progress.push({stage,detail});},
  ...overrides
 };
 return {ports,prompts,events,progress,sessions,setStatus:s=>{state=s;}};
};
test('verified documentation completion closes its scoped session and honors owner instructions',async()=>{
 const h=createPorts();
 await runAutonomousDocumentationAgent(h.ports);
 assert.equal(h.sessions.length,1);
 assert.equal(h.sessions[0],'session');
 assert.equal(h.prompts.length,1);
 assert.match(h.prompts[0],/documentation\.complete/);
 assert.match(h.prompts[0],/documents\.list\/read\/create\/update\/changeset/);
 assert.match(h.prompts[0],/Preserve user-provided requirements/);
 assert.equal(h.progress.at(-1).stage,'verified');
});
test('recoverable Codex interruption resumes with durable MCP evidence instead of duplicating edits',async()=>{
 let rounds=0,revision=0;
 const h=createPorts({
  readLiveInstructions:async()=>[{body:revision?'New owner instruction':'First owner instruction'}],
  performRound:async()=>{
   rounds++;
   if(rounds===1){revision=1;h.events.unshift({id:'event-1',tool:'documents.update',success:true,result:{id:'doc-1'}});throw Error('socket hang up');}
   h.setStatus('completed');return 'Confirmed';
  }
 });
 await runAutonomousDocumentationAgent(h.ports);
 assert.equal(rounds,2);
 assert.match(h.prompts[1],/New owner instruction/);
 assert.match(h.prompts[1],/documents.update/);
 assert.match(h.prompts[1],/уже выполнены/);
 assert.equal(h.progress.some(x=>x.stage==='retrying'),true);
 assert.deepEqual(h.sessions,['session']);
});
test('unrecoverable agent error does not fabricate a completed document and always closes session',async()=>{
 const h=createPorts({performRound:async()=>{throw Error('permanent agent failure');}});
 await assert.rejects(runAutonomousDocumentationAgent(h.ports),/permanent agent failure/);
 assert.deepEqual(h.sessions,['session']);
 assert.equal(h.progress.some(x=>x.stage==='verified'),false);
});
test('documentation agent fails closed when no scoped MCP session can be issued',async()=>{
 const h=createPorts({createSession:async()=>null});
 await assert.rejects(runAutonomousDocumentationAgent(h.ports),/доступ/);
 assert.equal(h.prompts.length,0);
 assert.equal(h.sessions.length,0);
});

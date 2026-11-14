import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentationJobRunner} from '../dist/modules/knowledge/infrastructure/documentation-job-runtime.js';
import {jsonObject} from '../dist/modules/knowledge/domain/json-object.js';

const projectId='00000000-0000-4000-8000-000000000011';
const jobId='00000000-0000-4000-8000-000000000012';
const actorId='00000000-0000-4000-8000-000000000013';
function fixture({exists=true,enabled=true,draftResult=null,existingStatus='running',draftError=null,configurationError=null}={}){
 const events=[],queries=[],saved=[],messages=[],usages=[];
 let status=existingStatus,savedDocuments=0;
 const job={id:jobId,project_id:projectId,actor_id:actorId,request_text:'Подготовь ТЗ по исходникам',
  source_key:'analyst:'+jobId,status:'running',analyst_input:{
   mode:'documentation',attachments:[],documentId:null,location:null,autonomous:true
  },draft_result:draftResult};
 const pool={query:async(sql,params=[])=>{
  queries.push({sql,params});
  if(sql.startsWith('SELECT * FROM document_import_jobs'))return {rows:exists?[job]:[],rowCount:exists?1:0};
  if(sql.startsWith('SELECT model FROM project_agent_models'))return {rows:[],rowCount:0};
  if(sql.includes('SELECT status,saved_documents FROM document_import_jobs'))return {rows:[{status,saved_documents:savedDocuments}],rowCount:1};
  if(sql.startsWith('SELECT status FROM document_import_jobs'))return {rows:[{status}],rowCount:1};
  if(sql.startsWith('UPDATE document_import_jobs SET status=')){status='failed';return {rows:[],rowCount:1};}
  throw Error('Unexpected SQL: '+sql.slice(0,110));
 }};
 const run=createDocumentationJobRunner({
  pool,codexUrl:'http://codex:4300',runnerKey:'long-authenticated-secret',
  decryptToken:()=>{throw Error('Should not decrypt token in fixture');},
  completion:async()=>{throw Error('Should not invoke completion in this fixture');},
  configuration:async()=>{if(configurationError)throw configurationError;return {model:'gpt-6-sol',reasoning:'medium',enabled};},
  businessAnalystContext:async()=>'',rulesContext:async()=>'',processEvent:async(...args)=>{events.push(args);},
  history:async()=>'',store:async(...args)=>{messages.push(args);return 'message-id';},
  storeTokenUsage:async(...args)=>{usages.push(args);},
  saveImportedDraft:async(...args)=>{
   saved.push(args);
   if(draftError)throw draftError;
   status='completed';savedDocuments=2;
   return {message:'Saved approved specification',created_document_id:'root-id',generated_documents:2};
  }
 });
 return {run:()=>run(jobId),events,queries,saved,messages,usages,getStatus:()=>status};
}

test('a non-running or absent document job is a strict no-op',async()=>{
 const f=fixture({exists:false});
 await f.run();
 assert.equal(f.events.length,0);
 assert.equal(f.saved.length,0);
 assert.equal(f.queries.length,1);
 assert.equal(f.getStatus(),'running');
});
test('AI disabled setting fails explicitly without committing a false completed job',async()=>{
 const f=fixture({enabled:false,draftResult:{documents:[]}});
 await f.run();
 assert.equal(f.getStatus(),'failed');
 assert.equal(f.saved.length,0);
 assert.equal(f.events.length,1);
 assert.equal(f.events[0][2],'failed');
 assert.match(f.events[0][3],/Включи AI/);
 assert.ok(f.queries.some(x=>x.sql.includes("status='failed'")));
});
test('persisted draft restarts by reusing the existing transactional draft writer',async()=>{
 const draft={collection_title:'Technical specification',sourceName:'source',
  notes:'confirmed',sourcePaths:[],documents:[{title:'One',body:'Requirement',sources:[]}]};
 const f=fixture({draftResult:draft});
 await f.run();
 assert.equal(f.getStatus(),'completed');
 assert.equal(f.saved.length,1);
 assert.equal(f.saved[0][0],projectId);
 assert.equal(f.saved[0][1],jobId);
 assert.equal(f.saved[0][2],draft);
 assert.equal(f.saved[0][3],'analyst:'+jobId);
 assert.equal(f.saved[0][4].actorId,actorId);
 assert.equal(f.events.length,1);
 assert.equal(f.events[0][2],'completed');
 assert.match(f.events[0][3],/2 страниц/);
 assert.equal(f.usages.length,0);
});
test('failed draft transaction does not report completion or persist agent messages',async()=>{
 const f=fixture({draftResult:{documents:[]},draftError:Error('Storage unavailable')});
 await f.run();
 assert.equal(f.getStatus(),'failed');
 assert.equal(f.saved.length,1);
 assert.equal(f.messages.length,0);
 assert.equal(f.events.length,1);
 assert.equal(f.events[0][2],'failed');
 assert.match(f.events[0][3],/Storage unavailable/);
});
test('an explicitly cancelled job never becomes a failed job on delayed completion',async()=>{
 const f=fixture({configurationError:Error('Codex connection interrupted'),existingStatus:'cancelled'});
 await f.run();
 assert.equal(f.getStatus(),'cancelled');
 assert.equal(f.events.length,0);
 assert.ok(!f.queries.some(x=>x.sql.includes("status='failed'")));
});
test('structured assistant JSON rejects incomplete or malformed output before any write',()=>{
 assert.deepEqual(jsonObject('text {"reply":"done","operations":[]} tail'),{reply:'done',operations:[]});
 assert.throws(()=>jsonObject('no structured data'),/не вернул структурированный/);
 assert.throws(()=>jsonObject('{"reply":'),/не вернул структурированный|некорректный JSON/);
});

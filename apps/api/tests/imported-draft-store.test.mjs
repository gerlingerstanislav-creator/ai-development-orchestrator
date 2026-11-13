import test from 'node:test';
import assert from 'node:assert/strict';
import {createImportedDraftStore} from '../dist/modules/knowledge/infrastructure/imported-draft-store.js';

const sample={collection_title:'Project specification',sourceName:'GitHub pinned SHA',notes:'Based on evidence',
 sourcePaths:['docs/requirements.md'],documents:[
  {title:'Functional',body:'Feature specification',sources:['docs/requirements.md','bad/untrusted.md']},
  {title:'Nonfunctional',body:'Constraints',sources:[]}
 ]};
function storeHarness(status='running',recordImportMessages=async()=>{}){
 const commands=[];let released=0;
 const client={
  query:async(sql,params=[])=>{
   commands.push({sql,params});
   if(sql.includes('SELECT status,result FROM document_import_jobs'))return {rows:[{status,result:{message:'Existing'}}],rowCount:1};
   if(sql.includes("system_key='spec'"))return {rows:[{id:'spec-root'}],rowCount:1};
   if(sql.includes("RETURNING id")&&sql.includes('INSERT INTO documents'))return {rows:[{id:'generated-root'}],rowCount:1};
   return {rows:[],rowCount:1};
  },
  release:()=>{released++;}
 };
 const pool={connect:async()=>client};
 const save=createImportedDraftStore(pool,recordImportMessages);
 return {save,commands,released:()=>released};
}
test('atomic draft save persists pages, source filtering, completion and chat before COMMIT',async()=>{
 const ordered=[];
 const h=storeHarness('running',async(client,projectId,input,result,rootId)=>{
  ordered.push({projectId,input,result,rootId});
  await client.query('INSERT INTO conversation_test VALUES($1)',[result.message]);
 });
 const result=await h.save('project','job',sample,'source-key',{actorId:'owner',message:'Please prepare',mode:'documentation'});
 assert.equal(result.generated_documents,2);
 assert.equal(result.created_document_id,'generated-root');
 assert.equal(h.commands[0].sql,'BEGIN');
 assert.equal(h.commands.at(-1).sql,'COMMIT');
 assert.deepEqual(ordered.map(x=>x.rootId),['generated-root']);
 assert.equal(h.commands.filter(x=>x.sql.includes('INSERT INTO documents')).length,3);
 const firstDoc=h.commands.find(x=>x.params?.includes('source-key/generated/0'));
 assert.match(firstDoc.params[3],/docs\/requirements.md/);
 assert.doesNotMatch(firstDoc.params[3],/bad\/untrusted.md/);
 assert.equal(h.released(),1);
});
test('completed draft is idempotent and never re-writes committed documents',async()=>{
 const h=storeHarness('completed');
 assert.deepEqual(await h.save('p','j',sample,'source'),{message:'Existing'});
 assert.deepEqual(h.commands.map(x=>x.sql.includes('SELECT status,result')?'SELECT':x.sql),['BEGIN','SELECT','COMMIT']);
 assert.equal(h.released(),1);
});
test('stopped import rejects write and rolls back without partial pages',async()=>{
 const h=storeHarness('cancelled');
 await assert.rejects(h.save('p','j',sample,'source'),/остановлен/);
 assert.equal(h.commands.at(-1).sql,'ROLLBACK');
 assert.equal(h.commands.filter(x=>x.sql.includes('INSERT INTO documents')).length,0);
 assert.equal(h.released(),1);
});
test('failed chat persistence rolls back generated pages and completion status',async()=>{
 const h=storeHarness('running',async()=>{throw Error('Cannot persist history');});
 await assert.rejects(h.save('p','j',sample,'source',{actorId:'a',message:'m',mode:'documentation'}),/Cannot persist history/);
 assert.equal(h.commands.at(-1).sql,'ROLLBACK');
 assert.equal(h.released(),1);
});

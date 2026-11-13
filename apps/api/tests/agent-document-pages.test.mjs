import test from 'node:test';
import assert from 'node:assert/strict';
import {
 createDoc,updateDoc,deleteDoc,documentRevision,createPage,updatePage,deleteEmptyPage
} from '../dist/modules/knowledge/infrastructure/agent-document-pages.js';

const p='project',d='document',parent='parent';
const revision='2026-11-13T12:00:00.000Z';
test('document schema validates bounded bodies and requires optimistic revisions',()=>{
 assert.equal(createDoc.parse({title:'Page',parent_id:'00000000-0000-4000-8000-000000000001'}).body,'');
 assert.equal(createDoc.safeParse({title:'',parent_id:'invalid'}).success,false);
 assert.equal(updateDoc.safeParse({document_id:'00000000-0000-4000-8000-000000000002',expected_revision:'invalid'}).success,false);
 assert.equal(deleteDoc.safeParse({document_id:'00000000-0000-4000-8000-000000000002',expected_revision:revision}).success,true);
 assert.equal(documentRevision(revision),revision);
});
test('scoped document creation rejects foreign parent and writes inside caller transaction',async()=>{
 const queries=[];
 const db={query:async(sql,params)=>{
  queries.push({sql,params});
  if(sql.includes('SELECT id FROM documents'))return {rowCount:params[0]===parent?1:0,rows:[]};
  return {rowCount:1,rows:[]};
 }};
 await assert.rejects(createPage(db,p,{parent_id:'other',title:'Blocked',body:''}),e=>e.statusCode===404);
 assert.equal(queries.filter(x=>x.sql.startsWith('INSERT INTO documents')).length,0);
 const created=await createPage(db,p,{parent_id:parent,title:'Allowed',body:'Source'});
 assert.equal(created.title,'Allowed');
 assert.equal(created.parent_id,parent);
 const insert=queries.find(x=>x.sql.startsWith('INSERT INTO documents'));
 assert.equal(insert.params[1],p);
});
test('update respects protected system page, revisions and cycle detection',async()=>{
 const writes=[];
 let row={id:d,title:'Original',body:'Content',parent_id:parent,system_key:'spec',updated_at:revision};
 const db={query:async(sql,params)=>{
  if(sql.includes('SELECT id,title,body,parent_id,system_key'))return {rowCount:1,rows:[row]};
  if(sql.includes('SELECT id FROM documents WHERE id='))return {rowCount:1,rows:[{id:params[0]}]};
  if(sql.includes('WITH RECURSIVE parents'))return {rowCount:1,rows:[{id:d}]};
  if(sql.startsWith('UPDATE documents')){writes.push(params);return {rowCount:1,rows:[{updated_at:revision}]};}
  throw Error('Unexpected SQL '+sql);
 }};
 await assert.rejects(updatePage(db,p,{document_id:d,expected_revision:revision,title:'New'}),e=>e.statusCode===409);
 row={...row,system_key:null};
 await assert.rejects(updatePage(db,p,{document_id:d,expected_revision:'2025-11-13T12:00:00.000Z',body:'New'}),e=>e.statusCode===409);
 await assert.rejects(updatePage(db,p,{document_id:d,expected_revision:revision,parent_id:'child'}),/собственного потомка/);
 assert.equal(writes.length,0);
 const result=await updatePage(db,p,{document_id:d,expected_revision:revision,body:'Updated'});
 assert.equal(result.id,d);
 assert.equal(writes.length,1);
 assert.equal(writes[0][0],p);
});
test('empty page delete refuses source links, children, tasks and revisioned documents',async()=>{
 let entry={id:d,body:'',system_key:null,import_source:null,source_refs:[],updated_at:revision};
 let blocker='';
 const queries=[];
 const db={query:async(sql,params)=>{
  queries.push(sql);
  if(sql.includes('SELECT id,body,system_key'))return {rowCount:1,rows:[entry]};
  if(sql.includes('SELECT 1 FROM'))return {rowCount:sql.includes(blocker)?1:0,rows:[]};
  if(sql.startsWith('DELETE FROM documents'))return {rowCount:1,rows:[]};
  throw Error('Unexpected SQL '+sql);
 }};
 for(const [key,patch,reason] of [
  ['system',{system_key:'spec'},/Системные разделы/],
  ['body',{body:'approved content'},/с содержимым/],
  ['source',{source_refs:[{path:'README.md'}]},/источниками/]
 ]){
  entry={...entry,...patch};
  await assert.rejects(deleteEmptyPage(db,p,{document_id:d,expected_revision:revision}),reason);
  entry={id:d,body:'',system_key:null,import_source:null,source_refs:[],updated_at:revision};
 }
 for(const [sqlCheck,expected] of [
  ['FROM documents WHERE project_id',/дочерними документами/],
  ['FROM tasks WHERE project_id',/привязана к задачам/],
  ['FROM document_versions',/история версий/]
 ]){
  blocker=sqlCheck;
  await assert.rejects(deleteEmptyPage(db,p,{document_id:d,expected_revision:revision}),expected);
 }
 blocker='';const result=await deleteEmptyPage(db,p,{document_id:d,expected_revision:revision});
 assert.equal(result.deleted,true);
 assert.equal(queries.filter(sql=>sql.startsWith('DELETE FROM documents')).length,1);
});

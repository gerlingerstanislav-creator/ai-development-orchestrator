import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {validDocParent} from '../dist/modules/documentation/infrastructure/document-hierarchy.js';
import {registerDocumentationRoutes} from '../dist/modules/documentation/api.js';
import {fingerprint} from '../dist/topic-import.js';

const project='123e4567-e89b-42d3-a456-426614174000';
const parent='123e4567-e89b-42d3-a456-426614174001';
const docId='123e4567-e89b-42d3-a456-426614174002';
const proposalId='123e4567-e89b-42d3-a456-426614174003';
function fixture({access=true,admin=true,query,connect}={}){
 const calls=[];
 const run=async(sql,args)=>{calls.push({sql,args});return (await query?.(sql,args))??{rows:[],rowCount:0};};
 const pool={query:run,connect:connect??(async()=>{throw Error('Unexpected SQL transaction');})};
 const app=Fastify();
 registerDocumentationRoutes(app,{
  pool,
  access:async(_req,reply)=>access?true:(reply.code(403).send({error:'Forbidden'}),false),
  requireAdmin:async(_req,reply)=>admin?true:(reply.code(403).send({error:'Administrator only'}),false)
 });
 return {app,calls};
}
test('hierarchy validation forbids missing, foreign and descendant parents',async()=>{
 const queries=[];
 const db={query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.startsWith('SELECT id'))return {rowCount:1};
  if(sql.includes('WITH RECURSIVE'))return {rowCount:1};
  throw Error('Unexpected SQL');
 }};
 assert.equal(await validDocParent(db,project,null,null),true);
 assert.equal(queries.length,0);
 assert.equal(await validDocParent(db,project,docId,docId),false);
 assert.equal(queries.length,1);
 assert.deepEqual(queries[0].args,[docId,project]);
 assert.equal(await validDocParent(db,project,docId,parent),false);
 assert.deepEqual(queries.at(-1).args,[parent,project,docId]);
 const missing={query:async()=>({rowCount:0})};
 assert.equal(await validDocParent(missing,project,docId,parent),false);
});
test('document creation requires a system-root child, a parent in the project and preserves metadata',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.startsWith('SELECT id FROM documents'))return {rowCount:1,rows:[{id:parent}]};
  return {rowCount:1,rows:[]};
 }});
 try{
  const path='/api/projects/'+project+'/docs';
  const payload={title:'Feature page',body:'Requirements',document_kind:'functional',
   implementation_status:'planned',implementation_evidence:'Owner-approved'};
  const unparented=await f.app.inject({method:'POST',url:path,payload});
  assert.equal(unparented.statusCode,409);
  assert.equal(f.calls.length,0);
  const created=await f.app.inject({method:'POST',url:path,payload:{...payload,parent_id:parent}});
  assert.equal(created.statusCode,201);
  assert.match(created.json().id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(f.calls[0].args,[parent,project]);
  const insert=f.calls.find(x=>x.sql.includes('INSERT INTO documents'));
  assert.ok(insert);
  assert.equal(insert.args[1],project);
  assert.equal(insert.args[2],'Feature page');
  assert.equal(insert.args[5],'functional');
  assert.equal(insert.args[6],'planned');
 }finally{await f.app.close();}
});
test('protected root sections cannot be moved, renamed or deleted',async()=>{
 const f=fixture({query:async sql=>{
  if(sql.startsWith('SELECT parent_id,system_key,title'))
   return {rows:[{parent_id:null,system_key:'spec',title:'Техническое задание'}],rowCount:1};
  if(sql.startsWith('SELECT id,system_key'))
   return {rows:[{id:docId,system_key:'spec'}],rowCount:1};
  throw Error('Unexpected SQL: '+sql);
 }});
 try{
  const route='/api/projects/'+project+'/docs/'+docId;
  const changed=await f.app.inject({method:'PATCH',url:route,
   payload:{title:'Renamed',body:'New text',parent_id:null}});
  assert.equal(changed.statusCode,409);
  const deleted=await f.app.inject({method:'DELETE',url:route});
  assert.equal(deleted.statusCode,409);
  assert.equal(f.calls.some(x=>/UPDATE documents|DELETE FROM documents/.test(x.sql)),false);
 }finally{await f.app.close();}
});
test('document and proposal endpoints reject nonmembers and admin-required commands',async()=>{
 const outsider=fixture({access:false});
 try{
  for(const route of ['/api/projects/'+project+'/docs','/api/projects/'+project+'/documentation/proposals']){
   assert.equal((await outsider.app.inject({url:route})).statusCode,403);
  }
  assert.equal(outsider.calls.length,0);
 }finally{await outsider.app.close();}
 const member=fixture({admin:false});
 try{
  assert.equal((await member.app.inject({method:'DELETE',url:'/api/projects/'+project+'/docs/'+docId})).statusCode,403);
  assert.equal((await member.app.inject({method:'POST',url:'/api/projects/'+project+'/documentation/proposals/'+proposalId+'/decision',
   payload:{decision:'approve'}})).statusCode,403);
  assert.equal(member.calls.length,0);
 }finally{await member.app.close();}
});
test('proposal acceptance uses the original content fingerprint and rolls back conflicting edits',async()=>{
 const statements=[];
 const client={query:async(sql,args)=>{
  statements.push({sql,args});
  if(sql.startsWith('SELECT * FROM document_import_proposals'))
   return {rows:[{document_id:docId,title:'New title',proposed_body:'New body',base_hash:'stale-hash'}],rowCount:1};
  if(sql.startsWith('SELECT id,title,body,system_key'))
   return {rows:[{id:docId,title:'Original',body:'Owner edit',system_key:null}],rowCount:1};
  return {rows:[],rowCount:1};
 },release(){}};
 const f=fixture({connect:async()=>client});
 try{
  const res=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/documentation/proposals/'+proposalId+'/decision',
   payload:{decision:'approve'}});
  assert.equal(res.statusCode,409);
  assert.equal(statements.some(x=>x.sql==='ROLLBACK'),true);
  assert.equal(statements.some(x=>/UPDATE documents|UPDATE document_import_proposals/.test(x.sql)),false);
 }finally{await f.app.close();}
});
test('matching proposal approval updates document and marks proposal in one transaction',async()=>{
 const statements=[];
 const client={query:async(sql,args)=>{
  statements.push({sql,args});
  if(sql.startsWith('SELECT * FROM document_import_proposals'))
   return {rows:[{document_id:docId,title:'New title',proposed_body:'New body',base_hash:fingerprint('Original','Body')}],rowCount:1};
  if(sql.startsWith('SELECT id,title,body,system_key'))
   return {rows:[{id:docId,title:'Original',body:'Body',system_key:null}],rowCount:1};
  return {rows:[],rowCount:1};
 },release(){}};
 const f=fixture({connect:async()=>client});
 try{
  const res=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/documentation/proposals/'+proposalId+'/decision',
   payload:{decision:'approve'}});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.json(),{ok:true,decision:'approve'});
  assert.ok(statements.some(x=>x.sql.includes('UPDATE documents')));
  assert.ok(statements.some(x=>x.sql.includes('UPDATE document_import_proposals')));
  assert.equal(statements.at(-1).sql,'COMMIT');
 }finally{await f.app.close();}
});

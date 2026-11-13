import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerConnectionRoutes} from '../dist/modules/integrations/connections/api.js';

const owner='123e4567-e89b-42d3-a456-426614174001';
const stranger='123e4567-e89b-42d3-a456-426614174002';
const project='123e4567-e89b-42d3-a456-426614174003';
const id='123e4567-e89b-42d3-a456-426614174004';
async function fixture(){
 const app=Fastify();
 const state=new Map([[id,{id,owner_id:owner,name:'Рабочий GitHub',provider:'github_token',secret_encrypted:'encrypted:old',project_count:1}]]);
 let actor=owner;
 const sql=[];
 const pool={query:async (query,args=[])=>{
  sql.push({query,args});
  if(query.includes('FROM connections c WHERE c.owner_id=$1 ORDER BY'))return {rows:[...state.values()].filter(c=>c.owner_id===args[0]).map(({secret_encrypted,owner_id,...rest})=>rest),rowCount:1};
  if(query.startsWith('INSERT INTO connections(')){
   const [id,owner_id,name,provider,secret_encrypted]=args;
   state.set(id,{id,owner_id,name,provider,secret_encrypted,project_count:0});
   return {rowCount:1};
  }
  if(query.startsWith('UPDATE connections')){
   const row=state.get(args[0]);
   if(!row||row.owner_id!==args[1])return {rows:[],rowCount:0};
   if(args[2]!==null)row.name=args[2];
   if(args[3]!==null)row.secret_encrypted=args[3];
   return {rows:[{id:row.id,name:row.name,provider:row.provider}],rowCount:1};
  }
  if(query.startsWith('DELETE FROM connections c')){
   const row=state.get(args[0]);
   if(row?.owner_id===args[1]&&!row.project_count){state.delete(row.id);return {rowCount:1,rows:[{id:row.id}]};}
   return {rowCount:0,rows:[]};
  }
  if(query.startsWith('SELECT id FROM connections WHERE id=$1 AND owner_id=$2')){
   const row=state.get(args[0]);
   return {rows:row?.owner_id===args[1]?[{id:row.id}]:[],rowCount:row?.owner_id===args[1]?1:0};
  }
  if(query.startsWith('SELECT c.id,c.name,c.provider FROM connections c JOIN project_connections')){
   return {rows:[],rowCount:0};
  }
  if(query.startsWith('INSERT INTO project_connections('))return {rows:[],rowCount:0};
  throw Error('Unexpected SQL '+query);
 }};
 registerConnectionRoutes({app,pool,uid:()=>actor,
  access:async(_req,reply,projectId)=>{if(projectId!==project){reply.code(403).send({error:'Forbidden'});return false;}return true;},
  encryptToken:secret=>'encrypted:'+secret});
 await app.ready();
 return {app,state,sql,setActor:value=>{actor=value;}};
}
test('profile lists personal credentials without leaking secrets',async()=>{
 const f=await fixture();
 try{
  const r=await f.app.inject({method:'GET',url:'/api/connections'});
  assert.equal(r.statusCode,200);
  assert.deepEqual(r.json(),[{id,name:'Рабочий GitHub',provider:'github_token',project_count:1}]);
  assert.equal(r.body.includes('encrypted:'),false);
  f.setActor(stranger);
  assert.deepEqual((await f.app.inject({method:'GET',url:'/api/connections'})).json(),[]);
 }finally{await f.app.close();}
});
test('create and rotate a token in place without exposing the new secret',async()=>{
 const f=await fixture();
 try{
  const created=await f.app.inject({method:'POST',url:'/api/connections',
   payload:{name:' Новый ',provider:'github_token',secret:'github_pat_secret'}});
  assert.equal(created.statusCode,201);
  const newId=created.json().id;
  assert.equal(f.state.get(newId).secret_encrypted,'encrypted:github_pat_secret');
  assert.equal(created.body.includes('secret'),false);
  const patch=await f.app.inject({method:'PATCH',url:'/api/connections/'+id,
   payload:{name:'Переименован',secret:'rotated-secret'}});
  assert.equal(patch.statusCode,200);
  assert.equal(f.state.get(id).name,'Переименован');
  assert.equal(f.state.get(id).secret_encrypted,'encrypted:rotated-secret');
  assert.equal(patch.body.includes('rotated-secret'),false);
  const renamed=await f.app.inject({method:'PATCH',url:'/api/connections/'+id,payload:{name:'Ещё раз'}});
  assert.equal(renamed.statusCode,200);
  assert.equal(f.state.get(id).secret_encrypted,'encrypted:rotated-secret');
  const bad=await f.app.inject({method:'PATCH',url:'/api/connections/'+id,payload:{}});
  assert.equal(bad.statusCode,400);
 }finally{await f.app.close();}
});
test('owner boundary prevents editing or removing another account\'s token',async()=>{
 const f=await fixture();
 try{
  f.setActor(stranger);
  const update=await f.app.inject({method:'PATCH',url:'/api/connections/'+id,
   payload:{secret:'hijack-secret'}});
  assert.equal(update.statusCode,404);
  assert.equal(f.state.get(id).secret_encrypted,'encrypted:old');
  const removed=await f.app.inject({method:'DELETE',url:'/api/connections/'+id});
  assert.equal(removed.statusCode,404);
  assert.ok(f.state.has(id));
 }finally{await f.app.close();}
});
test('linked token cannot be deleted; unused token can be removed',async()=>{
 const f=await fixture();
 try{
  const blocked=await f.app.inject({method:'DELETE',url:'/api/connections/'+id});
  assert.equal(blocked.statusCode,409);
  assert.ok(f.state.has(id));
  f.state.get(id).project_count=0;
  const deleted=await f.app.inject({method:'DELETE',url:'/api/connections/'+id});
  assert.equal(deleted.statusCode,200);
  assert.deepEqual(deleted.json(),{ok:true});
  assert.equal(f.state.has(id),false);
 }finally{await f.app.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import Fastify from 'fastify';
import {z} from 'zod';
import {registerConnectionRoutes} from '../dist/modules/integrations/connections/api.js';
import {encryptConnectionSecret,decryptConnectionSecret} from '../dist/modules/integrations/connections/secret-cipher.js';

const user='123e4567-e89b-42d3-a456-426614174001';
const project='123e4567-e89b-42d3-a456-426614174002';
const connection='123e4567-e89b-42d3-a456-426614174003';
const key=Buffer.alloc(32,7);

function fixture(allowed=true){
 const statements=[];
 const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>{
  if(error instanceof z.ZodError)return reply.code(400).send({error:'Некорректные данные'});
  return reply.code(500).send({error:'Internal error'});
 });
 const pool={query:async(sql,args)=>{
  statements.push({sql,args});
  if(sql.startsWith('SELECT c.id,c.name,c.provider,c.created_at,'))
   return {rows:[{id:connection,name:'GitHub',provider:'github_token',created_at:'2026-11-13'}],rowCount:1};
  if(sql.startsWith('SELECT c.id,c.name,c.provider FROM connections'))
   return {rows:[{id:connection,name:'GitHub',provider:'github_token'}],rowCount:1};
  if(sql.startsWith('INSERT INTO connections('))return {rows:[],rowCount:1};
  if(sql.startsWith('INSERT INTO project_connections('))return {rows:[],rowCount:args[2]===user?1:0};
  throw Error('Unexpected SQL: '+sql);
 }};
 registerConnectionRoutes({app,pool,uid:()=>user,encryptionKey:key,
  access:async(_req,reply)=>{
   if(!allowed){reply.code(403).send({error:'Нет доступа к проекту'});return false;}
   return true;
  }});
 return {app,statements};
}

test('secret envelope remains compatible with pre-refactor AES-GCM values',()=>{
 const iv=Buffer.alloc(12,3);
 const before=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([before.update('old-secret-token','utf8'),before.final()]);
 const legacy=Buffer.concat([iv,before.getAuthTag(),data]).toString('base64');
 assert.equal(decryptConnectionSecret(legacy,key),'old-secret-token');
 const fresh=encryptConnectionSecret('new-secret-token',key);
 assert.equal(decryptConnectionSecret(fresh,key),'new-secret-token');
 assert.notEqual(encryptConnectionSecret('new-secret-token',key),fresh,'new random IV on every write');
 assert.throws(()=>decryptConnectionSecret(fresh,Buffer.alloc(32,4)));
});

test('list/create connections isolate owner and never leak plaintext',async()=>{
 const {app,statements}=fixture();
 try{
  const list=await app.inject({method:'GET',url:'/api/connections'});
  assert.equal(list.statusCode,200);
  assert.equal(list.json()[0].provider,'github_token');
  const create=await app.inject({method:'POST',url:'/api/connections',
   payload:{name:'GitHub',provider:'github_token',secret:'correct-secret-token'}});
  assert.equal(create.statusCode,201);
  assert.deepEqual(Object.keys(create.json()).sort(),['id','name','provider']);
  const inserted=statements.find(x=>x.sql.startsWith('INSERT INTO connections('));
  assert.equal(inserted.args[1],user);
  assert.equal(inserted.args[3],'github_token');
  assert.notEqual(inserted.args[4],'correct-secret-token');
  assert.equal(decryptConnectionSecret(inserted.args[4],key),'correct-secret-token');
  assert.deepEqual(statements[0].args,[user]);
 }finally{await app.close();}
});

test('project connection listing is scoped by membership and owner',async()=>{
 const {app,statements}=fixture();
 try{
  const result=await app.inject({url:'/api/projects/'+project+'/connections'});
  assert.equal(result.statusCode,200);
  assert.deepEqual(result.json(),[{id:connection,name:'GitHub',provider:'github_token'}]);
  const query=statements[0];
  assert.match(query.sql,/c.owner_id=\$2/);
  assert.deepEqual(query.args,[project,user]);
 }finally{await app.close();}
});

test('attaching a connection cannot reference credentials owned by another user',async()=>{
 const {app,statements}=fixture();
 try{
  const response=await app.inject({method:'POST',url:'/api/projects/'+project+'/connections',payload:{connectionId:connection}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),{ok:true});
  const query=statements[0];
  assert.match(query.sql,/owner_id=\$3/);
  assert.match(query.sql,/ON CONFLICT DO NOTHING/);
  assert.deepEqual(query.args,[project,connection,user]);
 }finally{await app.close();}
});

test('no project credential SQL executes without project membership',async()=>{
 const {app,statements}=fixture(false);
 try{
  const listed=await app.inject({url:'/api/projects/'+project+'/connections'});
  const attach=await app.inject({method:'POST',url:'/api/projects/'+project+'/connections',payload:{connectionId:connection}});
  assert.equal(listed.statusCode,403);
  assert.equal(attach.statusCode,403);
  assert.equal(statements.length,0);
 }finally{await app.close();}
});

test('invalid credential payloads and project ids are rejected',async()=>{
 const {app,statements}=fixture();
 try{
  const bad=await app.inject({method:'POST',url:'/api/connections',
   payload:{name:'X',provider:'unsupported',secret:'12345678'}});
  const invalid=await app.inject({url:'/api/projects/not-a-uuid/connections'});
  assert.equal(bad.statusCode,400);
  assert.equal(invalid.statusCode,400);
  assert.equal(statements.length,0);
 }finally{await app.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {redactDiagnostic,registerDiagnosticRoutes} from '../dist/diagnostics.js';

const projectId='00000000-0000-4000-8000-000000000001';

test('diagnostics recursively redact secrets without discarding useful error context',()=>{
 const input={
  password:'my-password',authorization:'Bearer should-not-leak',nested:{
   comment:'Codex failed: github_pat_abcdef012345 and Bearer eyJhbGciOi',
   url:'https://username:p4ssw0rd@example.com/path'
  },codes:[400,500]
 };
 const clean=redactDiagnostic(input);
 const encoded=JSON.stringify(clean);
 assert.doesNotMatch(encoded,/my-password|should-not-leak|abcdef012345|p4ssw0rd|eyJhbGciOi/);
 assert.match(encoded,/Codex failed/);
 assert.match(encoded,/400/);
 assert.match(encoded,/\[REDACTED\]/);
});

test('project diagnostic download is scoped and excludes message bodies by default',async()=>{
 const queries=[];
 const pool={query:async (sql,params)=>{
  queries.push({sql,params});
  return {rows:sql.includes('SELECT name FROM projects')?[{name:'Fixture project'}]:[]};
 }};
 const app=Fastify();
 try{
  registerDiagnosticRoutes(app,{pool,access:async()=>true});
  const response=await app.inject({method:'GET',url:'/api/projects/'+projectId+'/diagnostics/export?hours=72'});
  assert.equal(response.statusCode,200,response.body);
  const report=response.json();
  assert.equal(report.project.id,projectId);
  assert.equal(report.window_hours,72);
  assert.equal(report.include_messages,false);
  assert.ok(Array.isArray(report.sections.testing_runs));
  assert.ok(queries.every(q=>q.params[0]===projectId));
  assert.ok(queries.filter(q=>q.params.length===2).every(q=>q.params[1]===72));
  assert.ok(queries.some(q=>q.sql.includes('NULL::text AS body')));
  assert.equal(response.headers['cache-control'],'no-store');
  const withChat=await app.inject({method:'GET',url:'/api/projects/'+projectId+'/diagnostics/export?hours=1&includeMessages=true'});
  assert.equal(withChat.statusCode,200,withChat.body);
  assert.equal(withChat.json().include_messages,true);
  assert.ok(queries.some(q=>q.sql.includes('LEFT(body,12000) AS body')));
 }finally{await app.close();}
});

test('project diagnostics require project access and never query data when denied',async()=>{
 let queried=false;
 const app=Fastify();
 try{
  registerDiagnosticRoutes(app,{
   pool:{query:async()=>{queried=true;throw Error('should not query');}},
   access:async(_req,reply)=>{reply.code(403).send({error:'No access'});return false;}
  });
  const response=await app.inject({method:'GET',url:'/api/projects/'+projectId+'/diagnostics/export'});
  assert.equal(response.statusCode,403);
  assert.equal(queried,false);
 }finally{await app.close();}
});

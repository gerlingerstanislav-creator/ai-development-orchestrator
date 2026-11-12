import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {inspectGithubRepository} from '../dist/modules/integrations/github/repository-gateway.js';
import {registerProjectGitRoutes} from '../dist/modules/integrations/github/api.js';

const project='123e4567-e89b-42d3-a456-426614174000';
const connection='123e4567-e89b-42d3-a456-426614174001';
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
const stored={repository:'acme/demo',default_branch:'main',target_branch:'main',connection_id:connection,connection_name:'GitHub'};
async function fixture(allow=true){
 const app=Fastify();
 const queries=[];
 const db={query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes('SELECT g.repository'))return {rows:[stored],rowCount:1};
  if(sql.includes('SELECT provider,secret_encrypted FROM connections'))return {rows:[{provider:'github_token',secret_encrypted:'encrypted-token'}],rowCount:1};
  if(sql.includes('INSERT INTO project_git_repositories'))return {rows:[],rowCount:1};
  if(sql.includes('DELETE FROM project_git_repositories'))return {rows:[],rowCount:1};
  throw Error('Unexpected SQL: '+sql);
 }};
 registerProjectGitRoutes({app,pool:db,uid:()=> 'owner-1',
  access:async(_req,reply)=>{
   if(!allow){reply.code(403).send({error:'Forbidden'});return false;}
   return true;
  },decryptToken:encrypted=>{
   assert.equal(encrypted,'encrypted-token');
   return 'github-test-secret';
  }
 });
 await app.ready();
 return {app,queries};
}
const repoResponse={full_name:'acme/demo',default_branch:'main',archived:false,disabled:false,private:true,permissions:{push:true}};
test('GitHub gateway validates write access and preserves upstream error codes',async()=>{
 const old=globalThis.fetch;
 try{
  globalThis.fetch=async()=>reply(repoResponse);
  assert.deepEqual(await inspectGithubRepository('github-test-secret','acme/demo'),
   {name:'acme/demo',branch:'main',canPush:true,private:true});
  for(const status of [401,403,404,500]){
   globalThis.fetch=async()=>reply({message:'problem'},status);
   await assert.rejects(inspectGithubRepository('github-test-secret','acme/demo'),
    error=>error.statusCode===(status===500?502:400));
  }
  globalThis.fetch=async()=>reply({...repoResponse,permissions:{push:false}});
  await assert.rejects(inspectGithubRepository('github-test-secret','acme/demo'),/права записи/);
 }finally{globalThis.fetch=old;}
});
test('project binding validates branch, PR permission and persists selected connection',async()=>{
 const {app,queries}=await fixture();
 const old=globalThis.fetch,seen=[];
 globalThis.fetch=async(url,options)=>{
  seen.push({url,options});
  if(url.endsWith('/repos/acme/demo'))return reply(repoResponse);
  if(url.endsWith('/branches/main'))return reply({name:'main'});
  if(url.includes('/pulls?'))return reply([]);
  throw Error('Unexpected URL '+url);
 };
 try{
  const result=await app.inject({method:'PUT',url:'/api/projects/'+project+'/git',
   payload:{repository:'acme/demo',connectionId:connection}});
  assert.equal(result.statusCode,200,JSON.stringify(result.json()));
  assert.equal(result.json().repository,'acme/demo');
  assert.equal(result.json().initialized,false);
  assert.equal(result.json().private,true);
  assert.equal(seen.length,3);
  for(const req of seen)assert.equal(req.options.headers.Authorization,'Bearer github-test-secret');
  assert.ok(queries.some(q=>q.sql.includes('INSERT INTO project_git_repositories')&&q.args[0]===project));
  const get=await app.inject({url:'/api/projects/'+project+'/git'});
  assert.equal(get.statusCode,200);
  assert.deepEqual(get.json(),stored);
  assert.equal(JSON.stringify(get.json()).includes('github-test-secret'),false);
  const remove=await app.inject({method:'DELETE',url:'/api/projects/'+project+'/git'});
  assert.deepEqual(remove.json(),{ok:true});
 }finally{globalThis.fetch=old;await app.close();}
});
test('project connection cannot be read or changed without membership',async()=>{
 const {app,queries}=await fixture(false);
 const old=globalThis.fetch;
 let called=false;
 globalThis.fetch=async()=>{called=true;return reply(repoResponse)};
 try{
  for(const method of ['GET','DELETE']){
   assert.equal((await app.inject({method,url:'/api/projects/'+project+'/git'})).statusCode,403);
  }
  assert.equal((await app.inject({method:'PUT',url:'/api/projects/'+project+'/git',
   payload:{repository:'acme/demo',connectionId:connection}})).statusCode,403);
  assert.equal(queries.length,0);
  assert.equal(called,false);
 }finally{globalThis.fetch=old;await app.close();}
});
test('repository binding does not initialize any existing GitHub repository',async()=>{
 const {app,queries}=await fixture();
 const old=globalThis.fetch,seen=[];
 globalThis.fetch=async(url,options)=>{
  seen.push({url,method:options.method??'GET'});
  if(url.endsWith('/repos/acme/demo'))return reply(repoResponse);
  if(url.endsWith('/branches/main'))return reply({error:'missing'},404);
  if(url.includes('/branches?per_page=1'))return reply([{name:'develop'}]);
  throw Error('Should not issue a content-write request');
 };
 try{
  const result=await app.inject({method:'PUT',url:'/api/projects/'+project+'/git',
   payload:{repository:'acme/demo',connectionId:connection}});
  assert.equal(result.statusCode,400);
  assert.equal(queries.some(q=>q.sql.includes('INSERT INTO project_git_repositories')),false);
  assert.equal(seen.some(x=>x.method==='PUT'),false);
 }finally{globalThis.fetch=old;await app.close();}
});

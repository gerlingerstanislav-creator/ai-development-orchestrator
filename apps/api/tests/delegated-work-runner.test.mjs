import test from 'node:test';
import assert from 'node:assert/strict';
import {createDelegatedRunner} from '../dist/modules/agents/infrastructure/delegated-work-runner.js';

const sha='fd8ac117d19b8dcdbe4b5c9ef2f3582df9461f49';
const projectId='00000000-0000-4000-8000-000000000001';
const taskId='00000000-0000-4000-8000-000000000002';
const assignmentId='00000000-0000-4000-8000-000000000003';
const actorId='00000000-0000-4000-8000-000000000004';
test('generic delegated worker uses pinned user SHA, not a branch or task-type shortcut',async()=>{
 const received=[],events=[],queries=[];
 const pool={query:async(sql,args)=>{
  queries.push(sql);
  if(sql.includes('project_git_repositories'))return {rowCount:1,rows:[{
   repository:'owner/source',default_branch:'main',target_branch:'main',secret_encrypted:'sealed'
  }]};
  return {rowCount:1,rows:[]};
 }};
 const run=createDelegatedRunner({
  pool,baseUrl:'http://codex:4300',secret:'internal-shared-secret',decrypt:()=> 'project-github-token',
  event:async(...values)=>events.push(values),
  fetchImpl:async(url,options)=>{
   received.push({url,headers:options.headers,body:JSON.parse(options.body)});
   return {ok:true,json:async()=>({
    message:'Verified evidence is available',source_sha:sha,
    browser_available:true,screenshots_saved:2,usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}
   })};
  }
 });
 const output=await run({
  project_id:projectId,task_id:taskId,role:'testing',project_owner_id:actorId,
  task_description:'Inspect deployed source pinned to '+sha,
 },assignmentId,'Read requirements and collect proof',{model:'gpt-6',reasoning:'high'});
 assert.match(output,/Verified evidence/);
 assert.equal(received.length,1);
 assert.equal(received[0].url,'http://codex:4300/delegated-work');
 assert.equal(received[0].body.sourceSha,sha);
 assert.equal(received[0].body.role,'testing');
 assert.equal(received[0].body.repository,'owner/source');
 assert.equal(received[0].body.token,'project-github-token');
 assert.equal(received[0].headers['X-Runner-Secret'],'internal-shared-secret');
 assert.equal(events.length,1);
 assert.ok(events[0][4].includes('сохранено скриншотов: 2'));
 assert.ok(queries.some(sql=>sql.includes('ai_token_usage')));
});

test('missing GitHub access never invents a repository or browser evidence',async()=>{
 const received=[];
 const run=createDelegatedRunner({
  pool:{query:async()=>({rowCount:0,rows:[]})},
  baseUrl:'http://codex:4300',secret:'internal',decrypt:()=>{throw Error('should not decrypt');},
  event:async()=>{},
  fetchImpl:async(_url,options)=>{received.push(JSON.parse(options.body));
   return {ok:true,json:async()=>({message:'blocked',browser_available:false,screenshots_saved:0})};
  }
 });
 assert.equal(await run({project_id:projectId,task_id:taskId,role:'testing',project_owner_id:actorId,
   task_description:'inspect feature'},assignmentId,'Inspect',{model:'gpt-6',reasoning:'high'}),'blocked');
 assert.equal(received[0].repository,null);
 assert.equal(received[0].sourceSha,undefined);
});

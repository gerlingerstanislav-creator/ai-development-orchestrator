import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {executeAgentTool} from '../dist/agent-tool-executor.js';

test('scoped agent reads current task, PR identity and only its own project',async()=>{
 const project=randomUUID(),taskId=randomUUID(),otherTask=randomUUID();
 const queries=[];
 const pool={query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes('SELECT id,title,description,stage,board_status,acceptance_mode,postponed_at,acceptance_feedback,analysis_state,clarification_questions')){
   if(args[0]!==project||args[1]!==taskId)return {rows:[],rowCount:0};
   return {rows:[{id:taskId,title:'Fix checkout',stage:'development',pr_url:'https://github.com/acme/orders/pull/12',pr_number:12,git_branch:taskId,pr_base_branch:'main',spec_reviewed_commit:'abc123'}],rowCount:1};
  }
  if(sql.includes('SELECT repository,target_branch,default_branch FROM project_git_repositories'))
   return {rows:[{repository:'acme/orders',target_branch:'main',default_branch:'main'}],rowCount:1};
  return {rows:[],rowCount:0};
 }};
 const session={id:randomUUID(),project_id:project,task_id:taskId,actor_id:randomUUID(),role:'development',status:'running',read_only:true,expires_at:new Date(Date.now()+60000)};
 const result=await executeAgentTool(pool,session,'tasks.read',{task_id:taskId},async()=>{});
 assert.equal(result.task.id,taskId);
 assert.deepEqual(result.git,{repository:'acme/orders',branch:taskId,base_branch:'main',pr_url:'https://github.com/acme/orders/pull/12',pr_number:12,reviewed_commit:'abc123'});
 assert.ok(Array.isArray(result.open_questions));
 await assert.rejects(executeAgentTool(pool,session,'tasks.read',{task_id:otherTask},async()=>{}),/другой задаче/);
 assert.ok(queries.some(q=>q.args?.[0]===project&&q.args?.[1]===taskId));
});
